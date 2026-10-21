#!/usr/bin/env python3
"""Read-only controller checks. No remediation, SQL writes, or service lifecycle calls."""
import argparse
import concurrent.futures
import datetime as dt
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[1]

# Runs via existing SSH identity; emits only aggregate operational metadata.
REMOTE = r'''
import json, os, subprocess, urllib.request
container = CONTAINER
def sql(query):
    p = subprocess.run(['docker','exec',container,'psql','-X','-U','cursus','-d','cursus','-Atc',query], capture_output=True,text=True,timeout=15)
    if p.returncode: raise RuntimeError('database probe failed')
    return json.loads(p.stdout)
v = os.statvfs('/home/lab/cursus-production-data/postgres')
result = {'disk_free_bytes':v.f_bavail*v.f_frsize,'disk_free_fraction':v.f_bavail/v.f_blocks}
result['database'] = sql("SELECT json_build_object('recovery',pg_is_in_recovery(),'standbys',(SELECT coalesce(json_agg(json_build_object('state',state,'sync_state',sync_state,'lag_bytes',pg_wal_lsn_diff(pg_current_wal_lsn(),replay_lsn))), '[]'::json) FROM pg_stat_replication),'slots',(SELECT coalesce(json_agg(json_build_object('wal_status',wal_status)),'[]'::json) FROM pg_replication_slots),'archive',(SELECT row_to_json(a) FROM (SELECT failed_count,last_failed_time,last_archived_time FROM pg_stat_archiver) a))")
if result['database']['recovery']:
    result['replay_paused'] = sql('SELECT to_json(pg_is_wal_replay_paused())')
else:
    p = subprocess.run(['docker','exec',container,'cat','/backup/latest'],capture_output=True,text=True,timeout=5)
    backup_id = p.stdout.strip()
    if p.returncode == 0 and backup_id and all(c.isalnum() or c in '-_' for c in backup_id):
        p = subprocess.run(['docker','exec',container,'cat','/backup/base/'+backup_id+'/cursus-backup.json'],capture_output=True,text=True,timeout=5)
        if p.returncode == 0: result['base_backup'] = json.loads(p.stdout)
try:
    with urllib.request.urlopen('http://127.0.0.1:8080/health/ready',timeout=5) as r:
        result['ready'] = r.status == 200 and json.load(r).get('status') == 'ready'
except Exception: result['ready'] = False
print(json.dumps(result,default=str))
'''


def probe(node):
    container = node['project'] + '-' + node['postgres_service'] + '-1'
    script = REMOTE.replace('CONTAINER', repr(container))
    p = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
                        node['ssh_alias'], 'python3 -c ' + shlex.quote(script)],
                       capture_output=True, text=True, timeout=55)
    if p.returncode:
        raise RuntimeError('SSH or remote probe failed')  # no raw stderr/secrets
    return json.loads(p.stdout)


def evaluate(node, sample, now, backup_hours=24, lag_bytes=64*1024*1024):
    alerts = []
    def add(code, action):
        alerts.append({'node': node['name'], 'code': code, 'action': action})
    if not sample.get('ready'):
        add('app_unready', 'Check application logs and deploy/cutover.py recovery status; do not restart blindly.')
    if sample['disk_free_bytes'] < 20*1024**3 or sample['disk_free_fraction'] < .10:
        add('disk_low', 'Inspect disk usage and WAL retention; never delete PostgreSQL files manually.')
    db = sample['database']
    if db['recovery'] != (node['role'] == 'standby'):
        add('database_role_mismatch', 'Stop deployment operations and investigate topology; never auto-promote.')
    archive = db['archive']
    failed, archived = archive.get('last_failed_time'), archive.get('last_archived_time')
    if failed and (not archived or timestamp(failed) > timestamp(archived)):
        add('wal_archive_failed', 'Inspect pg_stat_archiver, archive logs and destination permissions/capacity; preserve existing WAL.')
    if node['role'] == 'standby':
        if sample.get('replay_paused') is not False:
            add('replay_paused', 'Investigate paused WAL replay before relying on standby recovery.')
    else:
        peers = db['standbys']
        if len(peers) != 1 or any(p['state'] != 'streaming' or p['sync_state'] != 'async' or
                                  p['lag_bytes'] is None or p['lag_bytes'] > lag_bytes for p in peers):
            add('replication_unhealthy', 'Inspect primary/standby connectivity and WAL replay. Async lag is not a guaranteed RPO.')
        if any(s.get('wal_status') in ('unreserved', 'lost') for s in db['slots']):
            add('wal_slot_at_risk', 'Investigate WAL retention and standby catch-up; do not drop slots automatically.')
        try:
            age = (now - timestamp(sample['base_backup']['completed_at'])).total_seconds()
            if age < -300 or age > backup_hours*3600: raise ValueError()
        except (KeyError, ValueError, TypeError):
            add('base_backup_stale', 'Create and verify a new base backup under the approved backup procedure; preserve existing backups. Completion marker is not restore proof.')
    return alerts


def timestamp(value):
    if not isinstance(value, str): raise ValueError('invalid timestamp')
    parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None: raise ValueError('timestamp must include timezone')
    return parsed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=ROOT/'deploy/production.json')
    parser.add_argument('--backup-max-hours', type=float, default=24)
    parser.add_argument('--lag-max-bytes', type=int, default=64*1024*1024)
    parser.add_argument('--notify', action='store_true', help='POST sanitized report to external HTTPS webhook')
    args = parser.parse_args()
    if args.backup_max_hours <= 0 or args.lag_max_bytes < 0: parser.error('invalid thresholds')
    cfg = json.loads(args.config.read_text())
    now = dt.datetime.now(dt.timezone.utc)
    report = {'checked_at':now.isoformat(), 'alerts':[], 'nodes':[],
              'limitations':['Local base-backup completion only; off-node durability and restore/PITR are not verified.',
                             'Point-in-time probes, not an asynchronous replication RPO guarantee.']}
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures = [(n, pool.submit(probe, n)) for n in cfg['nodes']]
        for node, future in futures:
            try:
                sample = future.result()
                alerts = evaluate(node,sample,now,args.backup_max_hours,args.lag_max_bytes)
                report['nodes'].append({'node':node['name'], **sample})
                report['alerts'].extend(alerts)
            except Exception:
                report['alerts'].append({'node':node['name'],'code':'probe_failed',
                                         'action':'Check controller SSH access and database availability; failure is not proof of fencing.'})
    report['healthy'] = not report['alerts']
    if args.notify:
        try:
            # Endpoint/token is controller-only, never printed or copied to nodes.
            path = Path(os.environ.get('CURSUS_ALERT_WEBHOOK_FILE', str(Path.home()/'.config/cursus/alert-webhook')))
            if path.stat().st_mode & 0o077: raise ValueError()
            url = path.read_text().strip()
            if not url.startswith('https://'): raise ValueError()
            opener = urllib.request.build_opener(NoRedirect())
            req = urllib.request.Request(url, data=json.dumps(report).encode(),
                                         headers={'Content-Type':'application/json'},method='POST')
            with opener.open(req,timeout=10) as response:
                if not 200 <= response.status < 300: raise ValueError()
            report['notification'] = 'delivered'
        except Exception:
            report['notification'] = 'failed'
    print(json.dumps(report,indent=2))
    return 0 if report['healthy'] and report.get('notification') != 'failed' else 1


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


if __name__ == '__main__':
    sys.exit(main())
