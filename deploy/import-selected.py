#!/usr/bin/env python3
"""Checksum-verified, additive selected-plan import. Never restores a database."""
from __future__ import annotations
import argparse
import copy
import datetime as dt
import hashlib
import json
import re
from pathlib import Path
import shlex
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def canonical(value): return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
def digest(data): return hashlib.sha256(data).hexdigest()
def text(value): return "'" + str(value).replace("'", "''") + "'"
def js(value): return text(canonical(value)) + '::jsonb'


def query(node, sql):
    command = 'docker exec -i ' + shlex.quote(node['postgres_container']) + ' psql -X -v ON_ERROR_STOP=1 -U cursus -d cursus -At'
    result = subprocess.run(['ssh', '-o', 'BatchMode=yes', node['ssh_alias'], command], input=sql, text=True, capture_output=True, timeout=60)
    if result.returncode: raise RuntimeError('database operation failed; inspect private execution evidence')
    return result.stdout


def verify_archive(path):
    path = Path(path).resolve(strict=True)
    manifest = json.loads(path.read_text())
    for item in manifest['files']:
        source = (path.parent / item['file']).resolve(strict=True)
        if not source.is_relative_to(path.parent): raise ValueError('archive path escapes its root')
        body = source.read_bytes()
        if len(body) != item['bytes'] or digest(body) != item['sha256']: raise ValueError('archive checksum mismatch')
    return manifest


def prepare(selection_path, live, image):
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', image): raise ValueError('exact local application image digest required')
    selection_path = Path(selection_path).resolve(strict=True)
    selection = verify_archive(selection_path)
    if selection.get('status') != 'SELECTED_ACCEPTED_RESULTS': raise ValueError('operator-selected results required')
    if live['inRecovery'] or live['streamingStandbys'] < 1: raise ValueError('healthy primary/standby required')
    if live['activeSolves']: raise ValueError('selected base scenarios have active jobs')
    if live['tenant'] != 'production': raise ValueError('unexpected tenant')
    batch = {'schemaVersion': 1, 'selectionManifest': str(selection_path), 'selectionSha256': digest(selection_path.read_bytes()),
             'image': image, 'tenant': live['tenant'], 'datasetId': live['datasetId'], 'datasetManifest': live['datasetManifest'], 'plans': []}
    for day in selection['days']:
        plan = json.loads((selection_path.parent / day['plan']).read_text())
        if not plan['provenance']['validation']['valid'] or plan['provenance']['validation']['violations'] or plan['unassigned']:
            raise ValueError('selected plan is not fully served and validated')
        if not all(t.get('geometry', {}).get('coordinates') for v in plan['vehicles'] for t in v['trips']):
            raise ValueError('selected plan has missing road geometry')
        folder = Path(day['plan']).parts[0]
        source_manifest = json.loads((selection_path.parent / folder / 'admitted-dataset-manifest.json').read_text())
        if source_manifest != live['datasetManifest']: raise ValueError('admitted production dataset differs from solved input')
        source = next((s for s in live['scenarios'] if s['body']['day'] == ('day1' if day['day'] == '2026-05-06' else 'day2')), None)
        if source is None: raise ValueError('base scenario missing')
        exceptions = []
        for e in day.get('exceptions', []):
            if e['date'] != day['day'] or not e['preserveTailLiftRequirement'] or not e['preservePayloadCapacity']: raise ValueError('invalid GVW approval')
            exceptions.append({'orderNo': e['orderNo'], 'originalMaxTonnage': e['originalMaxGvwTonnes'], 'maxTonnage': e['approvedMaxGvwTonnes'], 'reason': e['basis']})
        for e in day.get('tailLiftExceptions', []):
            if e['date'] != day['day'] or not e['preservePayloadCapacity'] or e['approvedRequiresTailLift'] is not False: raise ValueError('invalid tail-lift approval')
            exceptions.append({'orderNo': e['orderNo'], 'originalRequiresTailLift': e['originalRequiresTailLift'], 'requiresTailLift': False, 'reason': e['basis']})
        policy = {'version': 1, 'id': 'selected-' + day['day'].replace('-', '') + '-' + batch['selectionSha256'][:12],
                  'date': day['day'], 'datasetRequestSha256': live['datasetManifest']['artifacts']['request']['sha256'],
                  'approvedBy': 'operator', 'approvedAt': selection['savedAt'], 'exceptions': exceptions}
        updated = copy.deepcopy(source['body']); updated['revision'] = source['revision'] + 1; updated['planningPolicy'] = policy
        plan['id'] = 'pln_selected_' + day['day'].replace('-', '') + '_' + batch['selectionSha256'][:12]
        plan['scenarioId'] = source['id']; plan['scenarioRevision'] = updated['revision']; plan['source'] = 'saved'
        plan['createdAt'] = dt.datetime.now(dt.timezone.utc).isoformat()
        plan['provenance']['planningPolicy'] = policy
        plan['provenance']['selectedImport'] = {'selectionSha256': batch['selectionSha256'], 'originalPlanId': json.loads((selection_path.parent / day['plan']).read_text())['id']}
        batch['plans'].append({'previousScenario': source, 'scenario': updated, 'plan': plan})
    if len(batch['plans']) != 2: raise ValueError('exactly two selected days required')
    return batch


def build_sql(batch, commit=True):
    tenant = text(batch['tenant']); ids = ','.join(text(p['plan']['id']) for p in batch['plans'])
    lines = ["BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
             "SELECT pg_advisory_xact_lock(1129665104);", 'DO $import$ DECLARE existing_count integer; BEGIN',
             "IF pg_is_in_recovery() THEN RAISE EXCEPTION 'not primary'; END IF;",
             f"IF NOT EXISTS(SELECT 1 FROM datasets WHERE tenant_id={tenant} AND id={text(batch['datasetId'])} AND status='admitted' AND manifest={js(batch['datasetManifest'])}) THEN RAISE EXCEPTION 'dataset drift'; END IF;",
             f"SELECT count(*) INTO existing_count FROM plans WHERE tenant_id={tenant} AND id IN ({ids});",
             f"IF existing_count NOT IN (0,{len(batch['plans'])}) THEN RAISE EXCEPTION 'partial import'; END IF;"]
    for row in batch['plans']:
        prior, scenario, plan = row['previousScenario'], row['scenario'], row['plan']
        sid, pid = text(scenario['id']), text(plan['id'])
        lines += [f"PERFORM 1 FROM scenarios WHERE tenant_id={tenant} AND id={sid} FOR UPDATE;",
                  'IF existing_count=0 THEN',
                  f"IF EXISTS(SELECT 1 FROM jobs WHERE tenant_id={tenant} AND kind='solve' AND state IN ('pending','running') AND payload->>'scenarioId'={sid}) THEN RAISE EXCEPTION 'active solve'; END IF;",
                  f"UPDATE scenarios SET revision={int(scenario['revision'])},body={js(scenario)},updated_at=now() WHERE tenant_id={tenant} AND id={sid} AND revision={int(prior['revision'])} AND body={js(prior['body'])};",
                  "IF NOT FOUND THEN RAISE EXCEPTION 'scenario changed'; END IF;",
                  f"INSERT INTO plans(tenant_id,id,scenario_id,scenario_revision,body,created_at) VALUES({tenant},{pid},{sid},{int(scenario['revision'])},{js(plan)},{text(plan['createdAt'])}::timestamptz);",
                  f"INSERT INTO audit_events(tenant_id,action,detail) VALUES({tenant},'plans.import-selected',{js({'planId': plan['id'], 'selectionSha256': batch['selectionSha256'], 'policyId': scenario['planningPolicy']['id']})});",
                  'ELSE',
                  f"IF NOT EXISTS(SELECT 1 FROM plans WHERE tenant_id={tenant} AND id={pid} AND body={js(plan)}) OR NOT EXISTS(SELECT 1 FROM scenarios WHERE tenant_id={tenant} AND id={sid} AND body={js(scenario)}) THEN RAISE EXCEPTION 'import identity drift'; END IF;",
                  'END IF;']
    lines += ['END $import$;', 'COMMIT;' if commit else 'ROLLBACK;']
    return '\n'.join(lines)


def inventory(node):
    sql = """SELECT json_build_object('inRecovery',pg_is_in_recovery(),'streamingStandbys',(SELECT count(*) FROM pg_stat_replication WHERE state='streaming'),
      'activeSolves',(SELECT count(*) FROM jobs WHERE tenant_id='production' AND kind='solve' AND state IN ('pending','running') AND payload->>'scenarioId' IN ('day1-base','day2-base')),
      'systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()),
      'tenant','production','datasetId',id,'datasetManifest',manifest,'scenarios',(SELECT json_agg(json_build_object('id',id,'revision',revision,'body',body) ORDER BY id) FROM scenarios WHERE tenant_id='production' AND id IN ('day1-base','day2-base')))
      FROM datasets WHERE tenant_id='production' AND status='admitted';"""
    rows = query(node, sql).strip().splitlines()
    if len(rows) != 1: raise ValueError('exactly one authoritative admitted dataset required')
    return json.loads(rows[0])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['plan', 'apply'])
    parser.add_argument('--selection', type=Path)
    parser.add_argument('--batch', type=Path, required=True)
    parser.add_argument('--image')
    parser.add_argument('--approve', action='store_true')
    parser.add_argument('--backup', type=Path)
    args = parser.parse_args()
    cfg = json.loads((ROOT / 'deploy/production.json').read_text()); nodes = cfg['nodes']
    primary = next(n for n in nodes if n['role'] == 'primary'); node = {**primary, 'postgres_container': primary['project']+'-postgres-1'}
    if args.command == 'plan':
        if not args.selection or not args.image: raise ValueError('plan requires selection and exact image digest')
        batch = prepare(args.selection, inventory(node), args.image)
        descriptor = args.batch.open('x'); args.batch.chmod(0o600)
        with descriptor: json.dump(batch, descriptor, indent=2)
    else:
        if not args.approve or not args.backup: raise ValueError('apply requires --approve and verified pre-import backup')
        batch = json.loads(args.batch.read_text()); selection = Path(batch['selectionManifest'])
        if digest(selection.read_bytes()) != batch['selectionSha256']: raise ValueError('selection manifest changed')
        verify_archive(selection)
        if not args.backup.is_file() or args.backup.stat().st_size < 1024: raise ValueError('missing backup')
        if args.backup.stat().st_mode & 0o077: raise ValueError('backup must be private')
        live = inventory(node)
        if live['datasetManifest'] != batch['datasetManifest'] or live['inRecovery'] or live['streamingStandbys'] < 1: raise ValueError('database preflight failed')
        evidence = json.loads(args.backup.with_suffix('.verified.json').read_text())
        age = (dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(evidence['createdAt'])).total_seconds()
        if evidence.get('restoreVerified') is not True or evidence.get('sha256') != digest(args.backup.read_bytes()) or evidence.get('systemIdentifier') != live['systemIdentifier'] or not 0 <= age <= 86400:
            raise ValueError('backup restore evidence is missing, stale or mismatched')
        for n in nodes:
            command = 'docker inspect '+shlex.quote(n['project']+'-cursus-1')+' --format '+shlex.quote('{{.Image}}')
            actual = subprocess.check_output(['ssh','-o','BatchMode=yes',n['ssh_alias'],command],text=True,timeout=20).strip()
            if actual != batch['image']: raise ValueError('application image mismatch')
            ready = subprocess.check_output(['ssh','-o','BatchMode=yes',n['ssh_alias'],
                'curl --fail --silent --max-time 10 http://127.0.0.1:8080/health/ready'],text=True,timeout=20)
            if json.loads(ready).get('status') != 'ready': raise ValueError('application not ready')
        query(node, build_sql(batch))
    print(json.dumps({'command': args.command, 'plans': [{'id': row['plan']['id'], 'day': row['plan']['day'], 'served': row['plan']['stats']['servedOrders']} for row in batch['plans']], 'production_mutated': args.command == 'apply'}))


if __name__ == '__main__': main()
