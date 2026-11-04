#!/usr/bin/env python3
"""Install only two application-owned user LaunchAgents; never provision a host."""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile

ROOT=Path(__file__).resolve().parents[1]
LABELS={'monitor':'io.artalis.cursus.operations.monitor','verify-backup':'io.artalis.cursus.operations.restore'}
FILES=['deploy/ops.py','deploy/ops_probe.py','deploy/ops_restore.py','deploy/ops_schedule.py','deploy/operations.json','deploy/production.json']


def plist(command,python,release,state_dir,notifications,cfg):
 args=[python,str(release/'deploy/ops.py'),'--state-dir',str(state_dir)]
 if notifications and command=='monitor':args+=['--notifications',str(notifications.expanduser().absolute())]
 args+=[command]
 if command=='verify-backup':args+=['--if-due']
 return {'Label':LABELS[command],'ProgramArguments':args,'RunAtLoad':True,
   'StartInterval':cfg['monitor_interval_seconds'] if command=='monitor' else cfg['restore_retry_seconds'],
   'ProcessType':'Background','LowPriorityIO':True,'Nice':10,
   'StandardOutPath':str(state_dir/(command+'.log')),'StandardErrorPath':str(state_dir/(command+'.stderr.log')),
   'EnvironmentVariables':{'PATH':'/usr/bin:/bin:/usr/sbin:/sbin'}}


def manage(action,approved,cfg,state_dir,notifications,*,home=None,system=None,run=None,production=None):
 from ops import OpsError,atomic_json,read_json
 home=Path.home() if home is None else home;system=system or sys.platform;run=run or subprocess.run
 if system!='darwin':raise OpsError('managed scheduling currently requires controller macOS launchd; use documented CLI commands elsewhere')
 domain='gui/'+str(os.getuid());agents=home/'Library/LaunchAgents'
 manifest_path=state_dir/'schedule.json';manifest=read_json(manifest_path,{})
 def command(args,check=True):
  result=run(args,capture_output=True,timeout=15)
  if check and result.returncode:raise OpsError('user scheduler operation failed')
  return result
 if action=='status':
  release=Path(manifest.get('release','/nonexistent'))
  pins=read_json(release/'operations-source.json',{})
  try:sources_valid=bool(pins.get('files')) and all(hashlib.sha256((release/name).read_bytes()).hexdigest()==expected for name,expected in pins['files'].items())
  except OSError:sources_valid=False
  jobs=[{'label':label,'loaded':command(['launchctl','print',domain+'/'+label],False).returncode==0,
    'plist_matches':(agents/(label+'.plist')).exists() and hashlib.sha256((agents/(label+'.plist')).read_bytes()).hexdigest()==manifest.get('plists',{}).get(label)} for label in LABELS.values()]
  return {'status':'passed' if manifest and sources_valid and all(j['loaded'] and j['plist_matches'] for j in jobs) else 'failed',
    'installed':bool(manifest),'sources_valid':sources_valid,'jobs':jobs}
 if not approved:raise OpsError('schedule changes require --approve')
 command(['launchctl','print',domain])
 if action=='uninstall':
  for label in LABELS.values():
   path=agents/(label+'.plist')
   if path.exists():
    if hashlib.sha256(path.read_bytes()).hexdigest()!=manifest.get('plists',{}).get(label):raise OpsError('owned schedule drift; refusing removal')
    if command(['launchctl','print',domain+'/'+label],False).returncode==0:command(['launchctl','bootout',domain,str(path)])
    path.unlink()
  if manifest_path.exists():manifest_path.unlink()
  return {'installed':False,'data_preserved':True}
 if notifications is None:raise OpsError('configure an operator notification destination before enabling the monitor schedule')
 production=production or json.loads((ROOT/'deploy/production.json').read_text())
 pinned_cfg={**cfg,'production_config':'deploy/production.json'}
 contents={name:(ROOT/name).read_bytes() for name in FILES}
 contents['deploy/operations.json']=(json.dumps(pinned_cfg,sort_keys=True)+'\n').encode()
 contents['deploy/production.json']=(json.dumps(production,sort_keys=True)+'\n').encode()
 digest=hashlib.sha256()
 for name in FILES:digest.update(name.encode());digest.update(contents[name])
 release=state_dir/'runtime'/digest.hexdigest()
 if not release.exists():
  release.mkdir(parents=True,mode=0o700)
  for name in FILES:
   destination=release/name;destination.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
   destination.write_bytes(contents[name]);destination.chmod(0o600)
 atomic_json(release/'operations-source.json',{'files':{name:hashlib.sha256(contents[name]).hexdigest() for name in FILES}})
 for name in FILES:
  if (release/name).read_bytes()!=contents[name]:raise OpsError('pinned scheduler source differs')
 python=shutil.which('python3')
 if not python:raise OpsError('existing Python executable unavailable')
 # Inspect every conflict before changing any schedule. Unrelated agents are untouched.
 planned={}
 for task,label in LABELS.items():
  path=agents/(label+'.plist');raw=plistlib.dumps(plist(task,python,release,state_dir,notifications,cfg),sort_keys=True)
  if path.exists() and path.read_bytes()!=raw and hashlib.sha256(path.read_bytes()).hexdigest()!=manifest.get('plists',{}).get(label):raise OpsError('unknown schedule conflict')
  loaded=command(['launchctl','print',domain+'/'+label],False).returncode==0
  if loaded and not path.exists() and label not in manifest.get('plists',{}):raise OpsError('unknown loaded schedule conflicts')
  planned[label]=(path,raw)
 agents.mkdir(parents=True,exist_ok=True)
 installed=[]
 try:
  for label,(path,raw) in planned.items():
   loaded=command(['launchctl','print',domain+'/'+label],False).returncode==0
   if path.exists() and path.read_bytes()==raw and loaded:continue
   if loaded:command(['launchctl','bootout',domain,str(path)])
   fd,temporary=tempfile.mkstemp(prefix='.'+label,dir=agents);os.fchmod(fd,0o600)
   with os.fdopen(fd,'wb') as file:file.write(raw);file.flush();os.fsync(file.fileno())
   os.replace(temporary,path)
   command(['launchctl','bootstrap',domain,str(path)]);installed.append(label)
  manifest={'source_digest':digest.hexdigest(),'release':str(release),'plists':{label:hashlib.sha256(raw).hexdigest() for label,(_,raw) in planned.items()}}
  atomic_json(manifest_path,manifest)
 except Exception:
  # Do not claim success after a partial install; record exact managed paths for
  # inspection. Never remove an unknown or unrelated job to force convergence.
  atomic_json(state_dir/'schedule-partial.json',{'installed':installed,'requires_review':True})
  raise
 return {'installed':True,'source_digest':digest.hexdigest(),'jobs':list(LABELS.values())}
