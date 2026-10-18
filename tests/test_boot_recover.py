import importlib.util
import pathlib
import tempfile
import unittest
import json
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('boot_recover', pathlib.Path(__file__).parents[1] / 'deploy/boot-recover.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BootRecoveryTests(unittest.TestCase):
    def test_missing_port_is_detected_even_for_running_container(self):
        self.assertTrue(module.binding_missing({'NetworkSettings': {'Ports': {'5432/tcp': None}}}, '10.77.0.1', 55433))

    def test_matching_binding_is_idempotent(self):
        info = {'NetworkSettings': {'Ports': {'5432/tcp': [{'HostIp': '10.77.0.1', 'HostPort': '55433'}]}}}
        self.assertFalse(module.binding_missing(info, '10.77.0.1', 55433))
        self.assertTrue(module.binding_missing(info, '192.168.1.7', 55433))

    def test_interface_and_role_fail_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            env = {'CURSUS_POSTGRES_BIND_IP': '10.77.0.1', 'CURSUS_POSTGRES_DATA_PATH': temp}
            with self.assertRaises(ValueError):
                module.validate(env, 'primary', {'10.77.0.1'})
            (root / 'PG_VERSION').write_text('16')
            with self.assertRaises(ValueError):
                module.validate(env, 'primary', {'192.168.50.29'})
            module.validate(env, 'primary', {'10.77.0.1'})
            with self.assertRaises(ValueError):
                module.validate(env, 'secondary', {'10.77.0.1'})
            (root / 'standby.signal').touch()
            module.validate(env, 'secondary', {'10.77.0.1'})
            with self.assertRaises(ValueError):
                module.validate(env, 'primary', {'10.77.0.1'})

    def test_wildcard_binding_refused(self):
        with self.assertRaises(ValueError):
            module.validate({'CURSUS_POSTGRES_BIND_IP': '0.0.0.0'}, 'primary', {'0.0.0.0'})

    def exercise(self, missing=False, drift=False, check_only=False, paused=False):
        commands = []
        with tempfile.TemporaryDirectory() as temp:
            env = pathlib.Path(temp) / '.env.production'
            env.write_text('COMPOSE_PROJECT_NAME=demo\nCURSUS_POSTGRES_BIND_IP=10.77.0.1\nCURSUS_POSTGRES_HOST_PORT=55433\nCURSUS_POSTGRES_DATA_PATH=/existing-db\n')
            if paused:
                (env.parent / '.boot-recover-paused').touch()
            def command(argv):
                commands.append(argv)
                if argv[0] == 'ip':
                    return json.dumps([{'addr_info': [{'local': '10.77.0.1'}]}])
                if argv[:2] == ['docker', 'inspect']:
                    ports = None if missing else [{'HostIp': '10.77.0.1', 'HostPort': '55433'}]
                    return json.dumps([{'Image': 'sha256:old', 'State': {'Running': True}, 'Config': {'Labels': {'com.docker.compose.project': 'demo'}}, 'NetworkSettings': {'Ports': {'5432/tcp': ports}}}])
                if argv[:2] == ['docker', 'run']:
                    self.assertIn('readonly', argv[argv.index('--mount') + 1])
                    self.assertIn('--network', argv)
                    return 'primary\n'
                if argv[:3] == ['docker', 'image', 'inspect']:
                    return json.dumps([{'Id': 'sha256:new' if drift else 'sha256:old'}])
                if 'config' in argv:
                    self.assertIn('database-primary', argv)
                    return json.dumps({'services': {s: {'image': 'pinned:local'} for s in ['postgres', 'velo', 'carta', 'cursus']}})
                return ''
            argv = ['boot-recover', '--env-file', str(env), '--role', 'primary'] + (['--check-only'] if check_only else [])
            with patch('sys.argv', argv), patch.object(module, 'run', side_effect=command):
                if drift:
                    with self.assertRaises(ValueError):
                        module.main()
                else:
                    module.main()
        return commands

    def test_missing_binding_recreates_only_existing_database(self):
        calls = self.exercise(missing=True)
        forced = [c for c in calls if '--force-recreate' in c]
        self.assertEqual(len(forced), 1)
        self.assertEqual(forced[0][-1], 'postgres')
        self.assertIn('--no-deps', forced[0])

    def test_healthy_database_is_not_recreated(self):
        self.assertFalse(any('--force-recreate' in c for c in self.exercise()))

    def test_image_drift_never_starts_services(self):
        self.assertFalse(any('up' in c for c in self.exercise(drift=True)))

    def test_check_only_validates_even_when_paused_without_starting_services(self):
        calls = self.exercise(check_only=True, paused=True)
        self.assertTrue(any('config' in c for c in calls))
        self.assertFalse(any('up' in c for c in calls))

    def test_pause_prevents_all_runtime_commands(self):
        self.assertEqual([], self.exercise(paused=True))
