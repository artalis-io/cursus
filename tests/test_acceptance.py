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
