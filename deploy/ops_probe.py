#!/usr/bin/env python3
"""Read-only node probe. Printed output contains aggregate operational data only."""
import datetime as dt
import json
from pathlib import Path
import shutil
import subprocess
import urllib.request


def run(argv, timeout=8):
    result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError('probe command failed')
    return result.stdout.strip()


def probe(node, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    result = {'reachable': True}
    try:
        request = urllib.request.Request('http://127.0.0.1:' + str(node['active_port']) + '/health/ready')
        with urllib.request.urlopen(request, timeout=4) as response:
            result['ready'] = response.status == 200 and b'"status": "ready"' in response.read(2048)
    except Exception:
        result['ready'] = False
    containers = {}
    for service in ['cursus', node['postgres_service'], 'velo', 'carta']:
        try:
            row = json.loads(run(['docker', 'inspect', node['project'] + '-' + service + '-1']))[0]
            containers[service] = {'status': row['State']['Status'], 'health': row['State'].get('Health', {}).get('Status'),
                                   'restarts': row['RestartCount'], 'image': row['Image']}
        except Exception:
            containers[service] = {'status': 'unknown'}
    result['containers'] = containers
    query = """WITH pending AS MATERIALIZED (SELECT (pg_stat_file('pg_wal/archive_status/'||f,true)).modification AS modified
      FROM pg_ls_dir('pg_wal/archive_status') f WHERE f LIKE '%.ready') SELECT json_build_object(
      'in_recovery',pg_is_in_recovery(),
      'system_id',(SELECT system_identifier::text FROM pg_control_system()),
      'schema',(SELECT max(version) FROM schema_migrations),
      'standbys',(SELECT coalesce(json_agg(x),'[]') FROM (SELECT state,pg_wal_lsn_diff(pg_current_wal_lsn(),replay_lsn)::bigint AS lag_bytes FROM pg_stat_replication) x),
      'receiver',(SELECT status FROM pg_stat_wal_receiver LIMIT 1),
      'archive',(SELECT row_to_json(x) FROM (SELECT archived_count,failed_count,last_archived_time,last_failed_time FROM pg_stat_archiver) x),
      'pending_wal',(SELECT count(modified) FROM pending),
      'oldest_pending_wal_age',(SELECT extract(epoch FROM now()-min(modified)) FROM pending),
      'unsafe_slots',(SELECT count(*) FROM pg_replication_slots WHERE wal_status IN ('lost','unreserved'))
    )"""
    # pg_current_wal_lsn cannot execute in recovery, including in a subquery.
    if node['role'] != 'primary':
        query = query.replace('pg_current_wal_lsn()', 'pg_last_wal_replay_lsn()')
    try:
        result['database'] = json.loads(run(['docker', 'exec', '-e', 'PGOPTIONS=-c statement_timeout=3000',
          node['project'] + '-' + node['postgres_service'] + '-1', 'psql', '-X', '-qAt', '-U', 'cursus', '-d', 'cursus', '-c', query]))
    except Exception:
        result['database'] = None
    root = Path(node['deployment_dir'])
    free = shutil.disk_usage(root)
    result['disk_free_percent'] = round(100 * free.free / free.total, 2)
    try:
        result['expected_system_id']=json.loads((root/'.boot-recover.json').read_text()).get('database_identity',{}).get('system_identifier')
    except (OSError,ValueError):result['expected_system_id']=None
    result['recovery_uncertain'] = (root / '.boot-recover-uncertain').exists()
    pause=root/'.boot-recover-paused'
    try:
        result['maintenance_age_seconds'] = now.timestamp()-pause.stat().st_mtime
        result['maintenance'] = True
    except FileNotFoundError:
        result['maintenance'] = False
        result['maintenance_age_seconds'] = None
    result['r2_failures'] = 0
    result['r2_codes'] = {}
    try:
        # Bound both history and output. Never forward arbitrary application logs.
        # Docker sends console.warn JSON to stderr, so read both streams below.
        logs = subprocess.run(['docker', 'logs', '--since', '5m', '--tail', '300', node['project'] + '-cursus-1'],
                              capture_output=True, text=True, timeout=8)
        if logs.returncode:
            raise RuntimeError('logs unavailable')
        for line in (logs.stdout + '\n' + logs.stderr).splitlines():
            try:
                event = json.loads(line)
                if event.get('component') == 'object-storage' and event.get('event') in ('unavailable', 'operation-failed'):
                    result['r2_failures'] += 1
                    code=event.get('code') if event.get('code') in ('timeout','busy','unavailable','integrity','closed') else 'other'
                    result['r2_codes'][code]=result['r2_codes'].get(code,0)+1
            except (ValueError, AttributeError):
                pass
        result['r2_signals_available'] = True
    except Exception:
        result['r2_signals_available'] = False
    return result


if __name__ == '__main__':
    import sys
    try:
        print(json.dumps(probe(json.loads(sys.stdin.read()))))
    except Exception:
        print(json.dumps({'reachable': True, 'probe_failed': True}))
        raise SystemExit(1)
