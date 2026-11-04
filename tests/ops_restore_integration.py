"""Opt-in actual PostgreSQL snapshot/restore test; accepts only the disposable CI source."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'deploy'))
import ops_restore as restore

SOURCE='cursus-ci-stateful-postgres-1'


def sql(query):
 return subprocess.check_output(['docker','exec',SOURCE,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','cursus','-d','cursus','-c',query],text=True).strip()


class LocalSnapshot(restore.Snapshot):
 def __init__(self,node,container):
  assert container==SOURCE
  args=restore.psql_args(container);args.insert(2,'-i');self.buffer=b''
  self.process=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True)


class LocalRunner(restore.Runner):
 def __init__(self):super().__init__();self.mutated=False
 def ssh(self,node,args,**kwargs):
  if 'pg_dump' in args and not self.mutated:
   # This write is solely in the disposable CI fixture after export. A correct
   # dump must preserve the old snapshot rather than mixing this later row in.
   sql("INSERT INTO ops_restore_probe VALUES(2,'after snapshot')");self.mutated=True
  return self.run(args,**kwargs)


def main():
 if os.environ.get('CURSUS_OPS_DISPOSABLE_INTEGRATION')!='1':raise SystemExit('explicit disposable-fixture opt-in required')
 info=json.loads(subprocess.check_output(['docker','inspect',SOURCE],text=True))[0]
 assert info['Config']['Labels']['com.docker.compose.project']=='cursus-ci-stateful'
 assert SOURCE==info['Name'].lstrip('/')
 sql("CREATE TABLE ops_restore_probe(id integer primary key,value text); INSERT INTO ops_restore_probe VALUES(1,'before snapshot')")
 nodes=[{'name':role,'role':role,'ssh_alias':'disposable-local','project':'cursus-ci-stateful','postgres_service':'postgres'} for role in ['primary','standby']]
 try:
  with tempfile.TemporaryDirectory(prefix='cursus-ops-restore-test-') as temp,patch.object(restore,'Snapshot',LocalSnapshot):
   report=restore.verify({'nodes':nodes},Path(temp),runner=LocalRunner())
   assert report['status']=='passed',json.dumps({k:report.get(k) for k in ['status','stage','error']})
   assert report['cleanup_completed'] is True and report['snapshot_consistent'] is True
   assert report['inventory']['ops_restore_probe']['count']==1
   assert sql('SELECT count(*) FROM ops_restore_probe')=='2'
   print(json.dumps({'status':'passed','concurrent_write_snapshot_verified':True,'all_table_checksums_verified':True,'cleanup_completed':True}))
 finally:sql('DROP TABLE ops_restore_probe')


if __name__=='__main__':main()
