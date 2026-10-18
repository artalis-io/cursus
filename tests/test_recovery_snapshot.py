"""Actual Compose rendering only: no daemon, images, containers or credentials."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('real_snapshot_test', Path(__file__).parents[1] / 'deploy/boot-recover.py')
module = importlib.util.module_from_spec(spec)
with patch('sys.path', [str(Path(spec.origin).parent), *sys.path]):
    spec.loader.exec_module(module)


class ComposeSnapshotTests(unittest.TestCase):
    def test_real_renderer_preserves_dollars_and_ignores_changed_live_inputs(self):
        if not shutil.which('docker') or subprocess.run(['docker', 'compose', 'version'], capture_output=True).returncode:
            self.skipTest('Docker Compose renderer unavailable; no daemon is required')
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            env = root / '.env.production'
            env.write_text('COMPOSE_PROJECT_NAME=cursus-snapshot-test\nFOO=original\n')
            source = root / 'compose.stateful.yaml'
            source.write_text('services:\n  postgres:\n    image: postgres:16.6-alpine\n    environment:\n'
                              '      LITERAL: "cost$$FOO"\n      EXPANDED: "${FOO}"\n'
                              '    command: ["sh", "-c", "echo $$FOO"]\n')
            folder = root / 'private'
            folder.mkdir(mode=0o700)
            _, command, model = module.frozen_compose(env, 'cursus-snapshot-test', 'primary', folder)
            hashes = module.run(command + ['config', '--hash', '*'])
            env.write_text('COMPOSE_PROJECT_NAME=wrong\nFOO=changed\n')
            source.write_text('services: invalid\n')
            self.assertEqual(model, json.loads(module.run(command + ['config', '--format', 'json'])))
            self.assertEqual(hashes, module.run(command + ['config', '--hash', '*']))
            self.assertEqual('cost$$FOO', model['services']['postgres']['environment']['LITERAL'])
            self.assertEqual('original', model['services']['postgres']['environment']['EXPANDED'])
            self.assertTrue(all(p.stat().st_mode & 0o777 == 0o600 for p in folder.iterdir()))
