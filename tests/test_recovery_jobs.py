import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('recovery_jobs', ROOT / 'deploy/recovery.py')
jobs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(jobs)


class RecoveryJobsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.env = self.root / '.env.production'
        self.env.write_text('COMPOSE_PROJECT_NAME=demo\n')
        self.p = jobs.paths(self.env)
        self.helper = self.root / 'source.py'
        self.helper.write_text('# version one\n')
        self.cron = '# unrelated task\n17 3 * * * /usr/bin/true\n'
        self.calls = []
        self.fail_write = False
        self.real_execute = jobs.execute
        self.real_prerequisites = jobs.prerequisites
        self.patch_execute = patch.object(jobs, 'execute', side_effect=self.execute).start()
        self.addCleanup(patch.stopall)
        self.prereq = patch.object(jobs, 'prerequisites').start()
        self.identity = {'project': 'demo', 'service': 'postgres', 'pgdata': '/db', 'system_identifier': '123'}
        self.prereq.return_value = self.identity

    def execute(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        if argv == ['crontab', '-l']:
            return self.cron
        if argv == ['crontab', '-']:
            if self.fail_write:
                self.fail_write = False
                raise jobs.RecoveryError('simulated write failure')
            self.cron = kwargs['input']
        return ''

    def action(self, action, **kwargs):
        return jobs.local(action, self.env, 'primary', 'demo', helper_source=self.helper, **kwargs)

    def test_install_idempotently_preserves_unrelated_entries_and_pins_sources(self):
        first = self.action('install')
        manifest = self.p['manifest'].read_bytes()
        cron = self.cron
        second = self.action('install')
        self.assertTrue(first['installed'] and first['checksums_valid'])
        self.assertEqual(first, second)
        self.assertEqual(manifest, self.p['manifest'].read_bytes())
        self.assertEqual(cron, self.cron)
        self.assertEqual(1, self.cron.count('# cursus-recovery:demo'))
        self.assertIn('17 3 * * * /usr/bin/true', self.cron)
        self.assertIn('deploy/recovery.py', self.cron)
        self.assertIn(' run ', self.cron)

    def test_adopts_existing_legacy_cron_without_duplicate(self):
        self.cron += ('*/2 * * * * /usr/bin/python3 ' + str(self.p['helper']) + ' --env-file ' + str(self.env) +
                      ' --role primary 2>&1 | /usr/bin/logger -t cursus-boot-recover # cursus-boot-recover-managed\n')
        self.action('install')
        self.assertNotIn('# cursus-boot-recover-managed', self.cron)
        self.assertEqual(1, self.cron.count('# cursus-recovery:demo'))

    def test_duplicate_owned_jobs_are_reconciled(self):
        line = jobs.cron_line(self.p, 'primary', 'demo')
        self.cron += line + '\n' + line + '\n'
        self.action('install')
        self.assertEqual(1, self.cron.count('# cursus-recovery:demo'))

    def test_unknown_helper_job_fails_closed(self):
        self.cron += '* * * * * python3 ' + str(self.p['helper']) + ' unexpected\n'
        before = self.cron
        with self.assertRaises(jobs.RecoveryError):
            self.action('install')
        self.assertEqual(before, self.cron)

    def test_pause_resume_and_uninstall_preserve_everything_else(self):
        before = self.cron
        self.action('install')
        self.assertTrue(self.action('pause')['paused'])
        self.calls.clear()
        self.assertEqual({'paused': True}, self.action('run'))
        self.assertFalse(self.calls)
        self.assertFalse(self.action('resume')['paused'])
        self.assertTrue(self.prereq.call_args.kwargs['allow_paused'])
        self.action('uninstall')
        self.assertEqual(before, self.cron)
        self.assertTrue(self.p['helper'].exists() and self.p['manifest'].exists())
        self.action('uninstall')
        self.assertEqual(before, self.cron)

    def test_status_read_only_detects_missing_outdated_and_tampered_helper(self):
        self.assertFalse(self.action('status')['installed'])
        self.action('install')
        self.calls.clear()
        self.assertFalse(self.action('status', expected={'helper': 'old', 'manager': 'old'})['version_current'])
        self.assertTrue(all(argv == ['crontab', '-l'] for argv, _ in self.calls))
        self.p['helper'].write_text('# unexpected change')
        self.assertFalse(self.action('status')['checksums_valid'])
        with self.assertRaises(jobs.RecoveryError):
            self.action('run')
        self.action('pause')
        with self.assertRaises(jobs.RecoveryError):
            self.action('resume')
        self.assertTrue(self.p['paused'].exists())

    def test_uncertainty_cannot_be_resumed_away(self):
        self.action('install')
        self.action('pause')
        self.p['uncertain'].write_text('interrupted Docker request')
        with self.assertRaisesRegex(jobs.RecoveryError, 'cannot resume'):
            self.action('resume')
        self.assertTrue(self.p['paused'].exists())

    def test_failed_prerequisite_does_not_change_cron(self):
        before = self.cron
        self.prereq.side_effect = jobs.RecoveryError('Docker missing')
        with self.assertRaises(jobs.RecoveryError):
            self.action('install')
        self.assertEqual(before, self.cron)
        self.assertFalse(self.p['manifest'].exists())

    def test_atomic_marker_persists_its_directory_entry(self):
        marker = self.root / 'durable-marker'
        with patch.object(jobs, 'sync_directory', wraps=jobs.sync_directory) as sync:
            jobs.atomic(marker, b'pending')
        sync.assert_called_once_with(self.root)
        self.assertEqual(b'pending', marker.read_bytes())

    def test_failed_crontab_write_rolls_back_deployed_sources(self):
        self.action('install')
        before = self.cron
        previous = self.p['helper'].read_bytes()
        manifest = self.p['manifest'].read_bytes()
        self.helper.write_text('# version two')
        self.fail_write = True
        with self.assertRaises(jobs.RecoveryError):
            self.action('install')
        self.assertEqual(before, self.cron)
        self.assertEqual(previous, self.p['helper'].read_bytes())
        self.assertEqual(manifest, self.p['manifest'].read_bytes())

    def test_schedule_executes_helper_only_after_integrity_validation(self):
        self.action('install')
        self.calls.clear()
        self.assertEqual({'reconciled': True}, self.action('run'))
        self.assertEqual(['/usr/bin/python3', str(self.p['helper']), '--env-file', str(self.env), '--role', 'primary',
                          '--expected-project', 'demo', '--expected-identity', json.dumps(self.identity)], self.calls[-1][0])

    def test_mutation_requires_approval_before_ssh(self):
        with self.assertRaises(jobs.RecoveryError):
            jobs.manage({'nodes': []}, 'install')

    def test_existing_inventory_role_mapping_and_partial_failure_reporting(self):
        cfg = json.loads((ROOT / 'deploy/production.json').read_text())
        with patch.object(jobs, 'execute', side_effect=['{}', jobs.RecoveryError('SSH unavailable')]) as command:
            with self.assertRaisesRegex(jobs.RecoveryError, '1 nodes completed'):
                jobs.manage(cfg, 'status')
            self.assertIn('spark-7468', command.call_args_list[0].args[0])
            self.assertIn('--role secondary', command.call_args_list[1].args[0][-1])

    def test_controller_never_resolves_remote_linux_paths_locally(self):
        cfg = json.loads((ROOT / 'deploy/production.json').read_text())
        with patch.object(jobs, 'execute', return_value='{}') as command, \
             patch.object(jobs.Path, 'resolve', side_effect=AssertionError('remote filesystem is not local')):
            jobs.manage(cfg, 'status', node='spark-7468')
        self.assertIn('/home/lab/cursus-production/deploy/recovery.py', command.call_args.args[0][-1])
        self.assertNotIn('/System/Volumes', command.call_args.args[0][-1])

    def test_no_crontab_is_distinguished_from_permission_failure(self):
        # Exercise the real command wrapper, not this fixture's crontab model.
        with patch.object(jobs, 'bounded_run', return_value=subprocess.CompletedProcess([], 1, '', 'no crontab for lab')):
            self.assertEqual('', self.real_execute(['crontab', '-l'], allow_missing_crontab=True))
        with patch.object(jobs, 'bounded_run', return_value=subprocess.CompletedProcess([], 1, '', 'permission denied')):
            with self.assertRaises(RuntimeError):
                self.real_execute(['crontab', '-l'], allow_missing_crontab=True)

    def test_cron_minimal_path_still_exposes_system_network_tools(self):
        with patch.dict(jobs.os.environ, {'PATH': '/opt/homebrew/bin:/usr/bin:/bin'}), \
             patch.object(jobs, 'bounded_run', return_value=subprocess.CompletedProcess([], 0, '', '')) as command:
            self.real_execute(['true'])
        self.assertIn('/usr/sbin', command.call_args.kwargs['env']['PATH'].split(':'))
        self.assertIn('/opt/homebrew/bin', command.call_args.kwargs['env']['PATH'].split(':'))

    def test_missing_host_tools_fail_without_provisioning(self):
        with patch.object(jobs.shutil, 'which', return_value=None):
            with self.assertRaisesRegex(jobs.RecoveryError, 'missing host prerequisite'):
                self.real_prerequisites(self.p, 'primary', 'demo', self.helper)
        self.assertFalse(self.calls)

    def test_explicit_checksum_mismatch_rejects_install(self):
        before = self.cron
        with self.assertRaises(jobs.RecoveryError):
            self.action('install', expected={'helper': 'wrong', 'manager': 'wrong'})
        self.assertEqual(before, self.cron)
        self.prereq.assert_not_called()

    def test_role_mismatch_refuses_running_existing_installation(self):
        self.action('install')
        with self.assertRaises(jobs.RecoveryError):
            jobs.local('run', self.env, 'secondary', 'demo')

    def test_uncertain_operation_blocks_recovery_and_pause_reports_not_safe(self):
        self.action('install')
        self.p['uncertain'].write_text('interrupted Docker request')
        self.assertTrue(self.action('status')['uncertain_operation'])
        with self.assertRaisesRegex(jobs.RecoveryError, 'unresolved Docker'):
            self.action('run')
        with self.assertRaisesRegex(jobs.RecoveryError, 'inspect before maintenance'):
            self.action('pause')
        self.assertTrue(self.p['paused'].exists())
