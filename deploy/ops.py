#!/usr/bin/env python3
"""Controller-side read-only monitoring, deduplicated alerts and isolated restore verification."""
import argparse
import concurrent.futures
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid

ROOT=Path(__file__).resolve().parents[1]
ACTIONS={
 'reachable':'Check SSH and node connectivity; do not infer that an unreachable primary is fenced.',
 'ready':'Inspect readiness and object-storage events; preserve the healthy serving peer.',
 'database':'Inspect database connectivity and role; never promote without verified fencing.',
 'replication':'Inspect standby connectivity and WAL retention; do not automatically reseed or promote.',
 'archive':'Inspect pg_stat_archiver and pending archive files; preserve required WAL.',
 'disk':'Inspect disk usage and retention; do not automatically prune data or backups.',
 'r2':'Inspect object-storage timeout/busy/integrity signals and R2 connectivity.',
 'restore':'Inspect the private restore report and temporary-container cleanup status.',
 'backup':'Run isolated backup verification and inspect backup storage.',
 'recovery':'Inspect the recovery uncertainty interlock; never clear it automatically.',
 'public':'Inspect public readiness and both origins; do not change Cloudflare automatically.',
 'monitor':'Inspect controller scheduling and probe errors.',
}


class OpsError(RuntimeError): pass


def atomic_json(path,value):
 path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
 fd,name=tempfile.mkstemp(prefix='.'+path.name,dir=path.parent);os.fchmod(fd,0o600)
 try:
  with os.fdopen(fd,'w') as stream:json.dump(value,stream,sort_keys=True);stream.write('\n');stream.flush();os.fsync(stream.fileno())
  os.replace(name,path)
  descriptor=os.open(path.parent,os.O_RDONLY)
  try:os.fsync(descriptor)
  finally:os.close(descriptor)
 finally:
  if os.path.exists(name):os.unlink(name)


def read_json(path,default=None):
 if not path.exists():return default
 try:return json.loads(path.read_text())
 except (ValueError,OSError):raise OpsError('invalid persisted operational state') from None


def private_file(path):
 path=Path(path).expanduser()
 if path.is_symlink() or not path.is_file() or path.stat().st_mode&0o077:raise OpsError('notification files must be private regular files (0600)')
 return path


def notification_settings(path):
 value=read_json(private_file(path))
 if not isinstance(value,dict) or value.get('backend') not in ('local','resend'):raise OpsError('invalid notification backend')
 if value['backend']=='resend':
  if not isinstance(value.get('to'),list) or not value['to'] or any(not isinstance(address,str) or not address.strip() or '\n' in address or '\r' in address for address in value['to']):raise OpsError('operator notification recipients required')
  if not isinstance(value.get('from'),str) or not value['from'].strip():raise OpsError('operator sender required')
  if not private_file(value['api_key_file']).read_text().strip():raise OpsError('operator notification key is empty')
 return value


def load_config(path):
 cfg=json.loads(path.read_text())
 if cfg.get('schema_version')!=1:raise OpsError('unsupported operations configuration')
 for key in ['monitor_interval_seconds','failure_samples','recovery_samples','replication_lag_bytes','archive_pending_seconds','disk_free_percent','backup_max_age_seconds','restore_interval_seconds','restore_retry_seconds','r2_failure_events']:
  if type(cfg.get(key)) is not int or cfg[key]<1:raise OpsError('invalid operational threshold: '+key)
 production=read_json(ROOT/cfg['production_config'])
 nodes=production['nodes']
 if sorted(n['role'] for n in nodes)!=['primary','standby'] or len({n['ssh_alias'] for n in nodes})!=2:raise OpsError('expected two distinct production nodes')
 for node in nodes:
  for key in ['ssh_alias','project','postgres_service']:
   if not re.fullmatch(r'[A-Za-z0-9_.-]+',node[key]):raise OpsError('invalid production node identity')
 return cfg,production


def check(key,healthy,category,summary):
 return {'id':key,'healthy':healthy is True,'category':category,'summary':summary,'action':ACTIONS[category]}


def evaluate(cfg,production,probes,state_dir,public,now):
 checks=[check('public.ready',public,'public','Public application readiness failed')]
 local=shutil.disk_usage(state_dir)
 checks.append(check('controller.disk',100*local.free/local.total>=cfg['disk_free_percent'],'disk',f'Controller backup storage: {round(100*local.free/local.total,1)}% free ({round(local.free/1024**3,1)} GiB); threshold {cfg["disk_free_percent"]}%' ))
 identities=[]
 for node in production['nodes']:
  prefix=node['name'];p=probes.get(prefix,{})
  checks.append(check(prefix+'.reachable',p.get('reachable') and not p.get('probe_failed'),'reachable',prefix+': node probe unavailable'))
  checks.append(check(prefix+'.ready',p.get('ready'),'ready',prefix+': application readiness failed'))
  db=p.get('database')
  checks.append(check(prefix+'.database',isinstance(db,dict) and db.get('in_recovery')==(node['role']=='standby') and db.get('system_id')==p.get('expected_system_id') and bool(p.get('expected_system_id')),'database',prefix+': database role or connectivity unavailable'))
  if isinstance(db,dict):
   identities.append(db.get('system_id'))
   replication=(bool(db.get('standbys')) and all(s.get('state')=='streaming' and isinstance(s.get('lag_bytes'),(int,float)) and 0<=s['lag_bytes']<=cfg['replication_lag_bytes'] for s in db['standbys'])) if node['role']=='primary' else db.get('receiver')=='streaming'
   checks.append(check(prefix+'.replication',replication and db.get('unsafe_slots',0)==0,'replication',prefix+': replication lag, receiver or WAL retention requires attention'))
   age=db.get('oldest_pending_wal_age')
   checks.append(check(prefix+'.archive',db.get('pending_wal',0)==0 or isinstance(age,(int,float)) and age<cfg['archive_pending_seconds'],'archive',prefix+f': {db.get("pending_wal",0)} WAL segments pending archival; oldest age {round(age or 0)} seconds'))
  checks.append(check(prefix+'.disk',isinstance(p.get('disk_free_percent'),(int,float)) and p['disk_free_percent']>=cfg['disk_free_percent'],'disk',prefix+': disk free space below threshold'))
  checks.append(check(prefix+'.recovery',p.get('recovery_uncertain') is False,'recovery',prefix+': recovery state is unavailable or uncertain'))
  checks.append(check(prefix+'.r2',p.get('r2_signals_available') is True and p.get('r2_failures',0)<cfg['r2_failure_events'],'r2',prefix+f': recent R2 failure signals={p.get("r2_failures",0)}, codes={json.dumps(p.get("r2_codes",{}),sort_keys=True)}; inspect R2 connectivity and queue pressure'))
  if p.get('maintenance') and p.get('maintenance_age_seconds',1e9)<900:
   for entry in checks:
    if entry['id'] in (prefix+'.ready',prefix+'.r2'):entry['suppressed']=True
  for name,container in p.get('containers',{}).items():
   entry=check(prefix+'.container.'+name,container.get('status')=='running' and container.get('health','healthy')=='healthy','ready',prefix+': '+name+' container is unavailable')
   if name=='cursus' and p.get('maintenance') and p.get('maintenance_age_seconds',1e9)<900:entry['suppressed']=True
   checks.append(entry)
 checks.append(check('database.identity',len(identities)==2 and all(identities) and len(set(identities))==1,'database','Primary and standby database identities differ or are unknown'))
 verified=read_json(state_dir/'verified-restore.json',{})
 good=verified.get('status')=='passed' and verified.get('snapshot_consistent') is True and verified.get('cleanup_completed') is True
 checks.append(check('backup.fresh',good and 0<=now-verified.get('finished_at',0)<=cfg['backup_max_age_seconds'],'backup','No fresh verified off-node backup is available'))
 attempt=read_json(state_dir/'restore-attempt.json',{})
 status=attempt.get('status');running=status=='running' and 0<=now-attempt.get('started_at',0)<=660
 checks.append(check('restore.last',status=='passed' or running,'restore','The latest isolated restore failed, is missing or exceeded its deadline'))
 return checks


def reconcile(previous,checks,cfg,now):
 """Hysteresis and durable pending notifications; unknown is always a failed check."""
 state=previous or {'incidents':{},'notifications':[]};state.setdefault('incidents',{});state.setdefault('notifications',[])
 if now-state.get('last_sampled_at',-1e30)<cfg['monitor_interval_seconds']:
  state['last_checked_at']=now;return state
 state['last_sampled_at']=now
 ids={c['id'] for c in checks}
 for known in set(state['incidents'])-ids:
  checks.append(check(known,False,'monitor','A previously monitored check disappeared'))
 for item in checks:
  if item.get('suppressed'):continue
  row=state['incidents'].setdefault(item['id'],{'failed':0,'healthy':0,'active':False})
  row['healthy']=row.get('healthy',0)+1 if item['healthy'] else 0
  row['failed']=row.get('failed',0)+1 if not item['healthy'] else 0
  threshold=1 if item['category']=='restore' else cfg['failure_samples']
  event=None
  if not row['active'] and row['failed']>=threshold:
   row.update(active=True,incident_id=uuid.uuid4().hex,opened_at=now);event='incident'
  elif row['active'] and row['healthy']>=cfg['recovery_samples']:
   row['active']=False;event='recovery'
  row.update(summary=item['summary'],action=item['action'])
  if event=='recovery':
   pending=next((e for e in state['notifications'] if e['id']=='cursus-ops/'+row['incident_id']+'/incident'),None)
   if pending and pending['delivery']=='pending' and 'first_attempt_at' not in pending:
    pending['delivery']='resolved-before-delivery';event=None
  if event:
   state['notifications'].append({'id':'cursus-ops/'+row['incident_id']+'/'+event,'created_at':now,'event':event,'check':item['id'],
     'summary':item['summary'],'action':item['action'],'delivery':'pending'})
 state['last_checked_at']=now
 return state


def notify(event,config):
 backend=config['backend']
 title='Cursus '+('recovered' if event['event']=='recovery' else 'incident')+': '+event['check']
 text=event['summary']+'\n'+event['action']
 if event['event']=='recovery':text='Recovered: '+event['check']+'\nThe check is healthy again.'
 if backend=='local':
  script='on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run'
  result=subprocess.run(['/usr/bin/osascript','-e',script,title,text],capture_output=True,timeout=10)
  if result.returncode:raise OpsError('local notification failed')
 elif backend=='resend':
  key=private_file(config['api_key_file']).read_text().strip()
  if not key or not config.get('to') or not isinstance(config['to'],list):raise OpsError('notification credentials or recipients missing')
  body=json.dumps({'from':config['from'],'to':config['to'],'subject':title,'text':text}).encode()
  request=urllib.request.Request('https://api.resend.com/emails',data=body,method='POST',headers={'Authorization':'Bearer '+key,'Content-Type':'application/json','Idempotency-Key':event['id']})
  try:
   with urllib.request.urlopen(request,timeout=10) as response:
    if response.status not in (200,201):raise OpsError('notification delivery failed')
  except Exception:raise OpsError('notification delivery failed') from None
 else:raise OpsError('unsupported notification backend')


def deliver(state,path,notification_config,now,sender=notify):
 if notification_config is None:return
 # Persist the exact destination/provider request with the event before sending;
 # a crash after provider acceptance reuses the same body and idempotency key.
 for event in state['notifications']:
  if event['delivery']!='pending':continue
  if event.get('notification_config',notification_config).get('backend')=='resend' and now-event.get('first_attempt_at',now)>=23*3600:
   event['delivery']='ambiguous';atomic_json(path,state);continue
  event.setdefault('notification_config',json.loads(json.dumps(notification_config)))
  event.setdefault('first_attempt_at',now);atomic_json(path,state)
  try:sender(event,event['notification_config'])
  except Exception:
   event['last_failure_at']=now;atomic_json(path,state);break
  event['delivery']='delivered';event['delivered_at']=now;atomic_json(path,state)


def collect(production):
 source=(ROOT/'deploy/ops_probe.py').read_text()
 def one(node):
  try:
   result=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=5',node['ssh_alias'],shlex.join(['/usr/bin/python3','-c',source])],
     input=json.dumps(node),text=True,capture_output=True,timeout=55)
   if result.returncode:raise OpsError('probe failed')
   return node['name'],json.loads(result.stdout)
  except Exception:return node['name'],{'reachable':False}
 with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:probes=dict(pool.map(one,production['nodes']))
 try:
  url='https://'+production['hostname']+'/health/ready'
  request=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0 CursusOperations/1'})
  with urllib.request.urlopen(request,timeout=5) as response:public=response.status==200 and json.load(response).get('status')=='ready'
 except Exception:public=False
 return probes,public


def prepare_state(path):
 path=path.expanduser().absolute()
 if path.is_symlink():raise OpsError('state directory cannot be a symlink')
 path=path.resolve()
 if path.is_relative_to(ROOT):raise OpsError('operational state and backups must stay outside the checkout')
 for parent in [path,*path.parents]:
  if (parent/'.git').exists():raise OpsError('operational state cannot be inside a Git checkout')
 path.mkdir(parents=True,exist_ok=True,mode=0o700)
 if path.is_symlink():raise OpsError('state directory cannot be a symlink')
 path.chmod(0o700);return path


def monitor(cfg,production,state_dir,notification_config=None):
 lock=os.fdopen(os.open(state_dir/'monitor.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600),'a')
 try:
  try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:return {'status':'already-running'}
  path=state_dir/'monitor-state.json';previous=read_json(path)
  probes,public=collect(production);now=time.time();checks=evaluate(cfg,production,probes,state_dir,public,now)
  state=reconcile(previous,checks,cfg,now);atomic_json(path,state)
  deliver(state,path,notification_config,now)
  report={'checked_at':now,'checks':checks,'probes':probes,'public_ready':public}
  atomic_json(state_dir/'monitor-report.json',report)
  return {'status':'healthy' if all(c['healthy'] or c.get('suppressed') for c in checks) else 'attention','active_incidents':sum(r['active'] for r in state['incidents'].values()),
          'delivery_configured':notification_config is not None,'pending_notifications':sum(e['delivery']=='pending' for e in state['notifications']),
          'ambiguous_notifications':sum(e['delivery']=='ambiguous' for e in state['notifications'])}
 finally:lock.close()


def verify_backup(cfg,production,state_dir,if_due=False):
 lock=os.fdopen(os.open(state_dir/'restore.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600),'a')
 try:
  try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:return {'status':'already-running'}
  previous=read_json(state_dir/'restore-attempt.json',{})
  if previous.get('cleanup_completed') is False:raise OpsError('previous restore cleanup requires review')
  wait=cfg['restore_interval_seconds'] if previous.get('status')=='passed' else cfg['restore_retry_seconds']
  if if_due and 0<=time.time()-previous.get('finished_at',0)<wait:return {'status':'not-due'}
  import ops_restore
  report=ops_restore.verify(production,state_dir)
  return {key:report.get(key) for key in ['status','run_id','duration_seconds','tables','cleanup_completed','production_writes']}
 finally:lock.close()


def main():
 os.umask(0o077)
 parser=argparse.ArgumentParser(description=__doc__)
 parser.add_argument('--config',type=Path,default=ROOT/'deploy/operations.json')
 parser.add_argument('--state-dir',type=Path,default=Path.home()/'.local/state/cursus-ops')
 parser.add_argument('--notifications',type=Path)
 commands=parser.add_subparsers(dest='command',required=True)
 commands.add_parser('monitor');commands.add_parser('status')
 backup=commands.add_parser('verify-backup');backup.add_argument('--if-due',action='store_true')
 schedule=commands.add_parser('schedule');schedule.add_argument('action',choices=['install','status','uninstall']);schedule.add_argument('--approve',action='store_true')
 args=parser.parse_args()
 try:
  if ROOT.parent.name=='runtime':
   pins=read_json(ROOT/'operations-source.json',{})
   if not pins.get('files') or any(hashlib.sha256((ROOT/name).read_bytes()).hexdigest()!=digest for name,digest in pins['files'].items()):raise OpsError('pinned operational source integrity failed')
  cfg,production=load_config(args.config);state_dir=prepare_state(args.state_dir)
  notification_error=False
  try:notification_config=notification_settings(args.notifications) if args.notifications else None
  except Exception:
   if args.command!='monitor':raise
   notification_config=None;notification_error=True
  if args.command=='monitor':
   result=monitor(cfg,production,state_dir,notification_config)
   if notification_error:result.update(status='attention',notification_configuration_failed=True)
  elif args.command=='verify-backup':result=verify_backup(cfg,production,state_dir,args.if_due)
  elif args.command=='status':result={'monitor':read_json(state_dir/'monitor-report.json',{}),'restore':read_json(state_dir/'restore-attempt.json',{})}
  else:
   import ops_schedule
   result=ops_schedule.manage(args.action,args.approve,cfg,state_dir,args.notifications,production=production)
  print(json.dumps(result));return 0 if result.get('status') not in ('failed','attention') else 1
 except Exception as error:
  message=str(error) if error.__class__.__name__ in ('OpsError','RestoreError') else 'Operational command failed; check prerequisites, private configuration and persisted reports.'
  print(json.dumps({'status':'failed','error':message}));return 2


if __name__=='__main__':raise SystemExit(main())
