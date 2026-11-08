import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('acceptance', ROOT / 'deploy/acceptance.py')
acceptance = importlib.util.module_from_spec(spec); spec.loader.exec_module(acceptance)


class AcceptanceRunnerTests(unittest.TestCase):
    def test_retry_failure_invalidates_an_earlier_passing_report(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'report.json'
            path.write_text(json.dumps({'status': 'passed', 'image_id': 'old-image'}))
            results = [subprocess.CompletedProcess([], 0, stdout='a' * 40),
                       subprocess.CompletedProcess([], 0, stdout='b' * 40),
                       subprocess.CompletedProcess([], 0, stdout=''),
                       subprocess.CalledProcessError(1, ['docker', 'image', 'inspect', 'missing'])]
            with patch('sys.argv', ['acceptance', '--image', 'missing', '--report', str(path)]), \
                 patch.object(acceptance, 'run', side_effect=results), \
                 patch.object(acceptance.signal, 'signal'), self.assertRaises(subprocess.CalledProcessError):
                acceptance.main()
            report = json.loads(path.read_text())
            self.assertEqual(report['status'], 'failed')
            self.assertNotIn('image_id', report)

    def test_port_reservations_are_distinct_and_never_production(self):
        ports = acceptance.free_ports(4)
        self.assertEqual(len(set(ports)), 4)
        self.assertNotIn(8080, ports)

    def test_fixture_mounts_are_read_only_and_email_delivery_is_disabled(self):
        compose = (ROOT / 'compose.acceptance.yaml').read_text()
        self.assertIn('RESEND_API_KEY_FILE: ""', compose)
        self.assertIn('CURSUS_AUTH_REQUIRED: "1"', compose)
        self.assertIn('CURSUS_RUNTIME_MODE: stateful', compose)
        self.assertIn('read_only: true', compose)
        self.assertNotIn('/var/run/docker.sock', compose)
        self.assertNotIn('network_mode: host', compose)

    def test_s3_fixture_does_not_preallocate_customer_scale_disk_or_ram(self):
        compose = (ROOT / 'compose.integration.yaml').read_text()
        self.assertIn('-master.volumePreallocate=false', compose)
        self.assertIn('s3-test-data:/data', compose)
        self.assertNotIn('tmpfs: ["/data', compose)

    def test_loading_contract_and_oracle_are_bound_to_the_harness(self):
        original = Path.read_bytes
        for relative in ['tests/acceptance/native-loading.py',
                         'vendor/otto/surge/tests/test_loading_cli.py',
                         'vendor/otto/surge/benchmarks/loading_reference.py']:
            target = ROOT / relative
            before = acceptance.harness_digest()
            def changed(path):
                data = original(path)
                return data + b'\n# changed public test\n' if path == target else data
            with patch.object(Path, 'read_bytes', changed):
                self.assertNotEqual(acceptance.harness_digest(), before, relative)

    def test_loading_fixtures_are_read_only_and_native_identity_is_checked(self):
        compose = (ROOT / 'compose.acceptance.yaml').read_text()
        self.assertIn('/acceptance-otto/test_loading_cli.py:ro', compose)
        self.assertIn('/acceptance-otto/loading_reference.py:ro', compose)
        source = (ROOT / 'deploy/acceptance.py').read_text()
        self.assertIn("report['native_loading']['surge_sha256'] != report['runtime']['native']['surge']", source)
