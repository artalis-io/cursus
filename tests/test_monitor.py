import copy
import datetime as dt
import importlib.util
import contextlib
import io
import json
from pathlib import Path
import subprocess
import unittest
import tempfile
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('monitor', Path(__file__).parents[1]/'deploy/monitor.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
NOW = dt.datetime(2026,10,21,tzinfo=dt.timezone.utc)
NODE = {'name':'test','role':'primary','project':'test','postgres_service':'postgres','ssh_alias':'test'}
SAMPLE = {'ready':True,'disk_free_bytes':100*1024**3,'disk_free_fraction':.5,
          'database':{'recovery':False,'standbys':[{'state':'streaming','sync_state':'async','lag_bytes':0}],
                      'slots':[{'wal_status':'reserved'}],
                      'archive':{'last_failed_time':None,'last_archived_time':None}},
          'base_backup':{'completed_at':NOW.isoformat()}}


class MonitorTests(unittest.TestCase):
    def codes(self, sample, node=NODE):
        return {a['code'] for a in m.evaluate(node,sample,NOW)}

    def test_healthy_idle_primary(self):
        self.assertEqual(set(),self.codes(SAMPLE))

    def test_missing_standby(self):
        sample=copy.deepcopy(SAMPLE); sample['database']['standbys']=[]
        self.assertIn('replication_unhealthy',self.codes(sample))

    def test_lag_and_state(self):
        for change in ({'lag_bytes':None},{'lag_bytes':100*1024**2},{'state':'catchup'},{'sync_state':'sync'}):
            sample=copy.deepcopy(SAMPLE); sample['database']['standbys'][0].update(change)
            self.assertIn('replication_unhealthy',self.codes(sample))

    def test_backup_invalid(self):
        for value in ('2026-10-13T00:00:00Z','2026-10-22T00:00:00Z','2026-10-21T00:00:00',None):
            sample=copy.deepcopy(SAMPLE); sample['base_backup']['completed_at']=value
            self.assertIn('base_backup_stale',self.codes(sample))
        sample=copy.deepcopy(SAMPLE); del sample['base_backup']
        self.assertIn('base_backup_stale',self.codes(sample))

    def test_disk(self):
        for change in ({'disk_free_bytes':1},{'disk_free_fraction':.01}):
            sample=copy.deepcopy(SAMPLE); sample.update(change)
            self.assertIn('disk_low',self.codes(sample))

    def test_readiness_role(self):
        sample=copy.deepcopy(SAMPLE); sample['ready']=False; sample['database']['recovery']=True
        self.assertTrue({'app_unready','database_role_mismatch'} <= self.codes(sample))

    def test_slot_lost(self):
        sample=copy.deepcopy(SAMPLE); sample['database']['slots'][0]['wal_status']='lost'
        self.assertIn('wal_slot_at_risk',self.codes(sample))

    def test_archiver_failure_recovery(self):
        sample=copy.deepcopy(SAMPLE)
        sample['database']['archive']['last_failed_time']='2026-10-20T00:00:00Z'
        self.assertIn('wal_archive_failed',self.codes(sample))
        sample['database']['archive']['last_archived_time']='2026-10-20T01:00:00Z'
        self.assertNotIn('wal_archive_failed',self.codes(sample))

    def test_standby_archive_failure_not_ignored(self):
        sample=copy.deepcopy(SAMPLE); sample['database']['recovery']=True; sample['replay_paused']=False
        node={**NODE,'role':'standby'}
        self.assertEqual(set(),self.codes(sample,node))
        sample['replay_paused']=True
        sample['database']['archive']['last_failed_time']='2026-10-20T00:00:00Z'
        self.assertEqual({'replay_paused','wal_archive_failed'},self.codes(sample,node))

    def test_ssh_error_redacted(self):
        with patch.object(m.subprocess,'run',return_value=subprocess.CompletedProcess([],1,'','SECRET')):
            with self.assertRaisesRegex(RuntimeError,'^SSH or remote probe failed$'): m.probe(NODE)

    def test_probe_contract(self):
        with patch.object(m.subprocess,'run',return_value=subprocess.CompletedProcess([],0,'{}','')) as run:
            self.assertEqual({},m.probe(NODE))
            self.assertEqual(55,run.call_args.kwargs['timeout'])
            self.assertIn('BatchMode=yes',run.call_args.args[0])
        for forbidden in ('pg_promote','ALTER ','INSERT ','UPDATE ','DELETE ','docker restart','docker compose','pg_switch_wal'):
            self.assertNotIn(forbidden,m.REMOTE)

    def test_webhook_no_redirect(self):
        self.assertIsNone(m.NoRedirect().redirect_request(None,None,None,None,None,None))

    def test_no_notification_by_default(self):
        cfg={'nodes':[NODE]}
        sample=copy.deepcopy(SAMPLE)
        sample['base_backup']['completed_at']=dt.datetime.now(dt.timezone.utc).isoformat()
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'config.json'; path.write_text(json.dumps(cfg))
            with patch('sys.argv',['monitor','--config',str(path)]), patch.object(m,'probe',return_value=sample), \
                 patch.object(m.urllib.request,'build_opener') as opener, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(0,m.main())
                opener.assert_not_called()

    def test_failed_probe_actionable_without_secret(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'config.json'; path.write_text(json.dumps({'nodes':[NODE]}))
            out=io.StringIO()
            with patch('sys.argv',['monitor','--config',str(path)]), patch.object(m,'probe',side_effect=RuntimeError('SECRET')), contextlib.redirect_stdout(out):
                self.assertEqual(1,m.main())
            self.assertNotIn('SECRET',out.getvalue())
            self.assertEqual('probe_failed',json.loads(out.getvalue())['alerts'][0]['code'])

    def test_notification_failure_redacted(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'config.json'; path.write_text(json.dumps({'nodes':[NODE]}))
            out=io.StringIO()
            with patch('sys.argv',['monitor','--config',str(path),'--notify']), patch.object(m,'probe',return_value=SAMPLE), \
                 patch.dict(m.os.environ,{'CURSUS_ALERT_WEBHOOK_FILE':str(Path(folder)/'SECRET')}), contextlib.redirect_stdout(out):
                self.assertEqual(1,m.main())
            self.assertNotIn('SECRET',out.getvalue())
            self.assertEqual('failed',json.loads(out.getvalue())['notification'])

    def test_notification_delivery_and_insecure_file(self):
        from unittest.mock import MagicMock
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'config.json'; path.write_text(json.dumps({'nodes':[NODE]}))
            secret=Path(folder)/'webhook'; secret.write_text('https://example.invalid/SECRET'); secret.chmod(0o600)
            opener=MagicMock()
            opener.open.return_value.__enter__.return_value.status=204
            for mode,expected in ((0o600,'delivered'),(0o644,'failed')):
                secret.chmod(mode); out=io.StringIO(); opener.reset_mock()
                with patch('sys.argv',['monitor','--config',str(path),'--notify']), patch.object(m,'probe',return_value=SAMPLE), \
                     patch.dict(m.os.environ,{'CURSUS_ALERT_WEBHOOK_FILE':str(secret)}), \
                     patch.object(m.urllib.request,'build_opener',return_value=opener), contextlib.redirect_stdout(out):
                    m.main()
                self.assertEqual(expected,json.loads(out.getvalue())['notification'])
                self.assertNotIn('SECRET',out.getvalue())
                if mode == 0o600:
                    request=opener.open.call_args.args[0]
                    self.assertEqual('POST',request.method)
                    self.assertEqual(10,opener.open.call_args.kwargs['timeout'])
                    self.assertIn('alerts',json.loads(request.data))
                else: opener.open.assert_not_called()
