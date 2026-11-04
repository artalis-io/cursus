import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'deploy'))
import ops
import ops_restore as restore
import ops_schedule as schedule


class OperationsTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
  self.state=Path(self.temp.name)/'state';self.state.mkdir()
  disk=patch.object(ops.shutil,'disk_usage',return_value=SimpleNamespace(total=100,free=80));disk.start();self.addCleanup(disk.stop)
  self.cfg,self.production=ops.load_config(ROOT/'deploy/operations.json')
  self.bad=[ops.check('primary.ready',False,'ready','Readiness failed')]
 def test_incident_and_recovery_are_deduplicated_with_hysteresis(self):
  state=None
  for stamp in [0,60,120,180]:state=ops.reconcile(state,self.bad,self.cfg,stamp)
  self.assertEqual(len(state['notifications']),1)
  state['notifications'][0]['delivery']='delivered'
  healthy=[ops.check('primary.ready',True,'ready','Readiness failed')]
  state=ops.reconcile(state,healthy,self.cfg,240);self.assertTrue(state['incidents']['primary.ready']['active'])
  for stamp in [300,360,420]:state=ops.reconcile(state,healthy,self.cfg,stamp)
  self.assertEqual([e['event'] for e in state['notifications']],['incident','recovery'])
 def test_rapid_manual_checks_do_not_turn_a_blip_into_a_sustained_incident(self):
  state=None
  for stamp in [0,1,2,3,4]:state=ops.reconcile(state,self.bad,self.cfg,stamp)
  self.assertEqual(len(state['notifications']),0)
 def test_disabled_delivery_does_not_mail_resolved_setup_incidents_later(self):
  state=None
  for stamp in [0,60,120]:state=ops.reconcile(state,self.bad,self.cfg,stamp)
  for stamp in [180,240]:state=ops.reconcile(state,[ops.check('primary.ready',True,'ready','Ready')],self.cfg,stamp)
  self.assertEqual(state['notifications'][0]['delivery'],'resolved-before-delivery')
  self.assertEqual(len(state['notifications']),1)
 def test_unknown_check_cannot_silently_remove_an_incident(self):
  state=ops.reconcile(None,self.bad,self.cfg,0)
  state=ops.reconcile(state,[],self.cfg,60)
  state=ops.reconcile(state,[],self.cfg,120)
  self.assertTrue(state['incidents']['primary.ready']['active'])
 def test_failed_delivery_reuses_body_destination_and_id_after_acceptance_crash(self):
  path=self.state/'monitor.json';state=ops.reconcile(None,[ops.check('restore.last',False,'restore','Restore failed')],self.cfg,10)
  accepted=set();calls=[]
  def sender(event,config):calls.append((event['id'],copy.deepcopy(config)));accepted.add(event['id'])
  original=ops.atomic_json
  def crash(path,data):
   if any(e['delivery']=='delivered' for e in data['notifications']):raise RuntimeError('crash after acceptance')
   original(path,data)
  with patch.object(ops,'atomic_json',side_effect=crash):
   with self.assertRaises(RuntimeError):ops.deliver(state,path,{'backend':'resend','to':['operator@example.test']},10,sender)
  reloaded=ops.read_json(path);ops.deliver(reloaded,path,{'backend':'resend','to':['changed@example.test']},70,sender)
  self.assertEqual(len(accepted),1);self.assertEqual(calls[0],calls[1])
 def test_ambiguous_provider_delivery_stops_after_23_hours(self):
  state=ops.reconcile(None,[ops.check('restore.last',False,'restore','Restore failed')],self.cfg,0)
  state['notifications'][0]['first_attempt_at']=0
  sender=lambda *_:self.fail('must not send outside provider safety window')
  ops.deliver(state,self.state/'monitor.json',{'backend':'resend'},23*3600,sender)
  self.assertEqual(state['notifications'][0]['delivery'],'ambiguous')
 def test_local_delivery_has_no_provider_idempotency_expiry(self):
  state=ops.reconcile(None,[ops.check('restore.last',False,'restore','Restore failed')],self.cfg,0)
  state['notifications'][0]['first_attempt_at']=0;delivered=[]
  ops.deliver(state,self.state/'monitor.json',{'backend':'local'},24*3600,lambda event,config:delivered.append(event['id']))
  self.assertEqual(len(delivered),1);self.assertEqual(state['notifications'][0]['delivery'],'delivered')
 def test_corrupt_state_and_insecure_secrets_fail_closed(self):
  p=self.state/'secret';p.write_text('{bad');p.chmod(0o644)
  with self.assertRaises(ops.OpsError):ops.private_file(p)
  with self.assertRaises(ops.OpsError):ops.read_json(p)
  p.chmod(0o600);self.assertEqual(ops.private_file(p),p)
  link=self.state/'link';link.symlink_to(p)
  with self.assertRaises(ops.OpsError):ops.private_file(link)
 def test_state_and_backup_cannot_be_created_in_source_even_through_symlink(self):
  with self.assertRaises(ops.OpsError):ops.prepare_state(ROOT/'private-ops-state')
  link=self.state/'source';link.symlink_to(ROOT/'docs')
  with self.assertRaises(ops.OpsError):ops.prepare_state(link/'private-ops-state')
 def healthy_probes(self):
  return {n['name']:{'reachable':True,'ready':True,'expected_system_id':'same','database':{'in_recovery':n['role']=='standby','system_id':'same','standbys':[{'state':'streaming','lag_bytes':0}],
    'receiver':'streaming','pending_wal':0,'unsafe_slots':0},'disk_free_percent':80,'recovery_uncertain':False,'r2_signals_available':True,'r2_failures':0,
    'containers':{'cursus':{'status':'running','health':'healthy'}}} for n in self.production['nodes']}
 def test_idle_wal_is_not_stale_archiving_and_lag_roles_identity_and_restore_are_checked(self):
  ops.atomic_json(self.state/'verified-restore.json',{'status':'passed','snapshot_consistent':True,'cleanup_completed':True,'finished_at':100})
  ops.atomic_json(self.state/'restore-attempt.json',{'status':'passed'})
  probes=self.healthy_probes();checks=ops.evaluate(self.cfg,self.production,probes,self.state,True,100)
  self.assertTrue(all(c['healthy'] for c in checks))
  primary=probes[self.production['nodes'][0]['name']];primary['database']['standbys'][0]['lag_bytes']=self.cfg['replication_lag_bytes']+1
  primary['database']['pending_wal']=1;primary['database']['oldest_pending_wal_age']=600
  checks=ops.evaluate(self.cfg,self.production,probes,self.state,True,100)
  failed={c['id'] for c in checks if not c['healthy']};self.assertTrue(any(k.endswith('.archive') for k in failed));self.assertTrue(any(k.endswith('.replication') for k in failed))
 def test_maintenance_suppresses_only_short_app_maintenance_not_database_or_public_failure(self):
  probes=self.healthy_probes();n=probes[self.production['nodes'][0]['name']];n.update(maintenance=True,maintenance_age_seconds=10,ready=False)
  n['database']=None
  checks=ops.evaluate(self.cfg,self.production,probes,self.state,False,100)
  self.assertTrue(next(c for c in checks if c['id'].endswith('.ready') and c['id']!='public.ready')['suppressed'])
  self.assertFalse(next(c for c in checks if c['id'].endswith('.database'))['healthy']);self.assertFalse(checks[0]['healthy'])
 def test_scheduler_contract_uses_existing_user_domain_and_no_production_mutations(self):
  conf=schedule.plist('verify-backup','/usr/bin/python3',Path('/pinned'),self.state,None,self.cfg)
  self.assertIn('--if-due',conf['ProgramArguments']);self.assertNotIn('sudo',conf['ProgramArguments'])
  self.assertEqual(conf['StartInterval'],self.cfg['restore_retry_seconds']);self.assertTrue(conf['RunAtLoad'])
  independent=schedule.plist('verify-backup','/usr/bin/python3',Path('/pinned'),self.state,Path('/missing-notifications'),self.cfg)
  self.assertNotIn('--notifications',independent['ProgramArguments'])
 def test_scheduler_installs_idempotently_and_refuses_unknown_jobs(self):
  loaded=set();calls=[];home=self.state/'home';self.state.mkdir(exist_ok=True)
  def run(args,**_):
   calls.append(args)
   if args[1]=='print':return subprocess.CompletedProcess(args,0 if args[2].count('/')==1 or args[2].split('/')[-1] in loaded else 1,b'',b'')
   if args[1]=='bootstrap':loaded.add(__import__('plistlib').loads(Path(args[3]).read_bytes())['Label'])
   if args[1]=='bootout':loaded.discard(Path(args[3]).stem)
   return subprocess.CompletedProcess(args,0,b'',b'')
  schedule.manage('install',True,self.cfg,self.state,self.state/'notifications',home=home,system='darwin',run=run)
  count=len([c for c in calls if c[1]=='bootstrap'])
  schedule.manage('install',True,self.cfg,self.state,self.state/'notifications',home=home,system='darwin',run=run)
  self.assertEqual(count,len([c for c in calls if c[1]=='bootstrap']))
  path=home/'Library/LaunchAgents'/('io.artalis.cursus.operations.monitor.plist');path.write_text('unknown data')
  with self.assertRaises(ops.OpsError):schedule.manage('install',True,self.cfg,self.state,self.state/'notifications',home=home,system='darwin',run=run)


class RestoreSafetyTests(unittest.TestCase):
 def test_inventory_rejects_untrusted_identifiers(self):
  with self.assertRaises(restore.RestoreError):restore.inventory_sql(['orders; DROP TABLE plans'])
  sql=restore.inventory_sql(['plans']);self.assertIn('COLLATE "C"',sql);self.assertIn('checksum',sql)
 def test_cleanup_removes_only_the_exact_nonce_labelled_temporary_container(self):
  class Runner:
   def __init__(self,label):self.label=label;self.removed=[]
   def ssh(self,node,args):
    if args[1]=='ps':return 'a'*64
    if args[1]=='inspect':return self.label
    if args[1]=='rm':self.removed.append(args);return ''
  own=Runner('own');self.assertTrue(restore.cleanup_restore(own,{},'temporary','own'))
  self.assertEqual(own.removed,[['docker','rm','-f','-v','a'*64]])
  foreign=Runner('someone-else')
  with self.assertRaises(restore.RestoreError):restore.cleanup_restore(foreign,{},'temporary','own')
  self.assertEqual(foreign.removed,[])



if __name__=='__main__':unittest.main()
