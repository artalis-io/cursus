import importlib.util
import json
import datetime as dt
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("stateful_deploy", ROOT / "deploy/stateful.py")
deploy = importlib.util.module_from_spec(spec); spec.loader.exec_module(deploy)


class StatefulDeploymentTests(unittest.TestCase):
    def config(self): return json.loads((ROOT / "deploy/stateful.json").read_text())

    def acceptance(self):
        return {'schema_version': 1, 'suite': 'stateful-production-image', 'status': 'passed',
                'image_id': 'sha256:candidate', 'checkout_dirty': False, 'cleanup_completed': True,
                'finished_at': dt.datetime.now(dt.timezone.utc).isoformat(),
                'image_revision': 'a' * 40, 'otto_revision': 'b' * 40, 'harness_sha256': deploy.current_harness_digest(),
                'browser': {'expected': 8, 'unexpected': 0, 'flaky': 0, 'skipped': 0},
                'runtime': {'migrations': [1], 'native': {name: 'd' * 64 for name in ['surge', 'matrix', 'nexus']}}}

    def responder(self, ssh, *, minimum=1, maximum=5, histories=None):
        histories = histories or {}
        def respond(node, command, **kwargs):
            if command[:3] == ['docker', 'image', 'inspect']:
                return SimpleNamespace(stdout=f'{minimum}|{maximum}|sha256:candidate\n')
            if command[:2] == ['docker', 'exec']:
                history = histories.get(node['name'], list(deploy.SUPPORTED_SCHEMAS))
                return SimpleNamespace(stdout=json.dumps(history))
            if command[0] == 'curl':
                return SimpleNamespace(stdout='{"status":"ready"}')
            if command[:2] == ['sh', '-c']:
                return SimpleNamespace(stdout='')
            raise AssertionError(f'unexpected command: {command}')
        ssh.side_effect = respond

    def run_update(self, *, action='rollout', migrations=None):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'report.json'
            report = self.acceptance()
            report['runtime']['migrations'] = migrations if migrations is not None else list(deploy.SUPPORTED_SCHEMAS)
            path.write_text(json.dumps(report))
            return deploy.update_application(self.config(), 'cursus-app:test', True, action, path)

    def assert_no_mutation(self, ssh):
        self.assertFalse(any('compose' in ' '.join(call.args[1]) for call in ssh.call_args_list))

    def test_checked_in_inventory_and_compose_are_safe(self):
        cfg = deploy.load(ROOT / "deploy/stateful.json")
        self.assertTrue(deploy.command_validate(cfg)["valid"])

    def test_prepared_public_osm_assets_are_readable_by_runtime_uids(self):
        script = (ROOT / "deploy/osm-prepare.sh").read_text()
        self.assertIn('chmod -R a+rX "$stage"', script)
        self.assertIn('chmod -R a+rX "$version"', script)
        self.assertIn('chmod a+rx "$root/cursus"', script)

    def test_recovery_jobs_use_postgres_uid_and_backup_loopback(self):
        compose = (ROOT / "compose.stateful.yaml").read_text()
        self.assertGreaterEqual(compose.count('user: "70:70"'), 2)
        self.assertIn('network_mode: service:postgres', compose)
        self.assertIn('CURSUS_PRIMARY_HOST: 127.0.0.1', compose)

    def test_runtime_overlay_does_not_duplicate_base_security_lists(self):
        base = (ROOT / "compose.yaml").read_text()
        overlay = (ROOT / "compose.stateful.yaml").read_text()
        runtime_anchor = overlay.split("x-runtime-security:", 1)[1].split("x-otto-build:", 1)[0]
        self.assertIn("cap_drop: [ALL]", base)
        self.assertIn("security_opt: [no-new-privileges:true]", base)
        self.assertNotIn("cap_drop:", runtime_anchor)
        self.assertNotIn("security_opt:", runtime_anchor)

    def test_solve_queue_limit_is_wired_into_runtime(self):
        compose = (ROOT / "compose.stateful.yaml").read_text()
        self.assertIn('DISPATCH_MAX_SOLVE_QUEUE: ${DISPATCH_MAX_SOLVE_QUEUE:-8}', compose)

    def test_replication_is_explicitly_asynchronous(self):
        compose = (ROOT / "compose.stateful.yaml").read_text()
        self.assertIn('synchronous_standby_names=', compose)
        self.assertNotIn('synchronous_standby_names=\'*\'', compose)

    def test_production_port_is_rejected(self):
        cfg = self.config(); cfg["nodes"][0]["app_port"] = 8080
        with tempfile.NamedTemporaryFile("w", suffix=".json") as handle:
            json.dump(cfg, handle); handle.flush()
            with self.assertRaises(deploy.DeploymentError): deploy.load(handle.name)

    def test_production_project_is_rejected(self):
        cfg = self.config(); cfg["nodes"][0]["project"] = "cursus"
        with tempfile.NamedTemporaryFile("w", suffix=".json") as handle:
            json.dump(cfg, handle); handle.flush()
            with self.assertRaises(deploy.DeploymentError): deploy.load(handle.name)

    def test_promotion_requires_approval_and_fence(self):
        cfg = self.config()
        with self.assertRaisesRegex(deploy.DeploymentError, "--approve"):
            deploy.promote(cfg, False, None, Path("unused"))
        with self.assertRaisesRegex(deploy.DeploymentError, "fence-command"):
            deploy.promote(cfg, True, None, Path("unused"))

    def test_rollout_requires_explicit_approval(self):
        with self.assertRaisesRegex(deploy.DeploymentError, "--approve"):
            deploy.update_application(self.config(), "cursus-app:test", False, "rollout")

    @patch.object(deploy, "ssh")
    def test_rollout_is_secondary_first_and_requires_schema_label(self, ssh):
        self.responder(ssh)
        result = self.run_update()
        self.assertEqual([n["role"] for n in result["nodes"]], ["standby", "primary"])
        self.assertTrue(all(n['database_schema'] == [1, 2, 3, 4, 5] and n['image_schema_range'] == [1, 5]
                            for n in result['nodes']))
        self.assertEqual(ssh.call_args_list[0].args[0]["name"], "spark-3eb0")
        commands = [call.args[1][2] for call in ssh.call_args_list if call.args[1][:2] == ['sh', '-c']]
        self.assertEqual(len(commands), 2)
        self.assertIn('-p cursus-stateful-staging-secondary', commands[0])
        self.assertIn('-p cursus-stateful-staging-primary', commands[1])
        self.assertTrue(all('--no-build --pull never --wait --wait-timeout 120' in c for c in commands))

    def test_known_schemas_match_migrations_and_image_contract(self):
        versions = sorted(int(path.name.split('_', 1)[0]) for path in (ROOT / 'server/migrations').glob('*.sql'))
        self.assertEqual(list(deploy.SUPPORTED_SCHEMAS), versions)
        dockerfile = (ROOT / 'Dockerfile').read_text()
        self.assertIn(f'ARG CURSUS_SCHEMA_MIN={versions[0]}\n', dockerfile)
        self.assertIn(f'ARG CURSUS_SCHEMA_MAX={versions[-1]}\n', dockerfile)

    @patch.object(deploy, 'ssh')
    def test_schema_five_compatible_rollback_and_non_one_minimum(self, ssh):
        self.responder(ssh, minimum=3)
        result = self.run_update(action='rollback')
        self.assertEqual(len(result['nodes']), 2)

    @patch.object(deploy, 'ssh')
    def test_all_known_schema_versions_work_when_evidence_and_database_match(self, ssh):
        for version in deploy.SUPPORTED_SCHEMAS:
            with self.subTest(version=version):
                ssh.reset_mock()
                history = list(range(1, version + 1))
                self.responder(ssh, maximum=version, histories={n['name']: history for n in self.config()['nodes']})
                self.assertEqual(len(self.run_update(migrations=history)['nodes']), 2)

    def test_release_gate_rejects_missing_failed_dirty_skipped_and_old_evidence(self):
        with self.assertRaisesRegex(deploy.DeploymentError, '--acceptance-report'):
            deploy.acceptance_evidence(None, 'sha256:candidate')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'report.json'
            for field, value in [('status', 'failed'), ('checkout_dirty', True), ('image_id', 'sha256:different'),
                                 ('harness_sha256', 'c' * 64),
                                 ('browser', {'expected': 7, 'unexpected': 0, 'flaky': 0, 'skipped': 0}),
                                 ('finished_at', '2020-01-01T00:00:00+00:00')]:
                report = self.acceptance(); report[field] = value; path.write_text(json.dumps(report))
                with self.subTest(field=field), self.assertRaises(deploy.DeploymentError):
                    deploy.acceptance_evidence(path, 'sha256:candidate')
            for field in ['skipped', 'flaky', 'unexpected']:
                report = self.acceptance(); report['browser'][field] = 1; path.write_text(json.dumps(report))
                with self.subTest(field=field), self.assertRaises(deploy.DeploymentError):
                    deploy.acceptance_evidence(path, 'sha256:candidate')
            report = self.acceptance(); report['finished_at'] = '2020-01-01T00:00:00+00:00'
            path.write_text(json.dumps(report))
            self.assertEqual(deploy.acceptance_evidence(path, 'sha256:candidate', fresh=False)['status'], 'passed')

    @patch.object(deploy, 'ssh')
    def test_old_image_rollback_is_blocked_after_reviewer_migration(self, ssh):
        ssh.side_effect = [type('R', (), {'stdout': '1|1|sha256:candidate'})() for _ in range(2)] + [
            type('R', (), {'stdout': '[1,2]'})()]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'report.json'; path.write_text(json.dumps(self.acceptance()))
            with self.assertRaisesRegex(deploy.DeploymentError, 'incompatible'):
                deploy.update_application(self.config(), 'cursus-app:old', True, 'rollback', path)
        self.assertFalse(any('compose' in ' '.join(call.args[1]) for call in ssh.call_args_list))

    @patch.object(deploy, 'ssh')
    def test_reviewer_image_rollback_is_blocked_after_planner_migration(self, ssh):
        ssh.side_effect = [type('R', (), {'stdout': '1|2|sha256:candidate'})() for _ in range(2)] + [
            type('R', (), {'stdout': '[1,2,3]'})()]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'report.json'; path.write_text(json.dumps(self.acceptance()))
            with self.assertRaisesRegex(deploy.DeploymentError, 'incompatible'):
                deploy.update_application(self.config(), 'cursus-app:old', True, 'rollback', path)
        self.assertFalse(any('compose' in ' '.join(call.args[1]) for call in ssh.call_args_list))

    @patch.object(deploy, 'ssh')
    def test_every_pre_profile_or_handoff_image_cannot_roll_back_schema_five(self, ssh):
        for maximum in (1, 2, 3, 4):
            with self.subTest(maximum=maximum):
                ssh.reset_mock(); self.responder(ssh, maximum=maximum)
                with self.assertRaisesRegex(deploy.DeploymentError, 'incompatible'):
                    self.run_update(action='rollback', migrations=list(range(1, maximum + 1)))
                self.assert_no_mutation(ssh)

    @patch.object(deploy, 'ssh')
    def test_invalid_or_future_image_bounds_fail_before_mutation(self, ssh):
        for lower, upper in [('', '5'), ('1', '<no value>'), ('0', '5'), ('5', '4'), ('1', '6'), ('6', '6'), ('01', '5'), ('1', '5.0')]:
            with self.subTest(bounds=(lower, upper)):
                ssh.reset_mock();self.responder(ssh, minimum=lower, maximum=upper)
                with self.assertRaisesRegex(deploy.DeploymentError, 'schema compatibility'):
                    self.run_update()
                self.assert_no_mutation(ssh)

    @patch.object(deploy, 'ssh')
    def test_incomplete_unknown_or_malformed_database_history_fails_closed(self, ssh):
        for history in [[], [1, 3, 5], [1, 2, 3, 4, 5, 6], [1, True], ['1'], [1, 2, 2], {'max': 5}]:
            with self.subTest(history=history):
                ssh.reset_mock();self.responder(ssh, histories={'spark-7468': history})
                with self.assertRaises(deploy.DeploymentError):self.run_update()
                self.assert_no_mutation(ssh)

    @patch.object(deploy, 'ssh')
    def test_unmigrated_or_lagging_replica_blocks_rolling_upgrade(self, ssh):
        for node in self.config()['nodes']:
            with self.subTest(node=node['name']):
                ssh.reset_mock();self.responder(ssh, histories={node['name']: [1, 2, 3, 4]})
                with self.assertRaisesRegex(deploy.DeploymentError, 'reviewed migration'):
                    self.run_update()
                self.assert_no_mutation(ssh)

    @patch.object(deploy, 'ssh')
    def test_acceptance_schema_must_be_inside_declared_image_range(self, ssh):
        self.responder(ssh, maximum=4)
        with self.assertRaisesRegex(deploy.DeploymentError, 'acceptance schema'):
            self.run_update()
        self.assert_no_mutation(ssh)

    @patch.object(deploy, 'ssh')
    def test_schema_below_image_minimum_is_rejected(self, ssh):
        self.responder(ssh, minimum=4, histories={'spark-7468': [1, 2, 3]})
        with self.assertRaisesRegex(deploy.DeploymentError, 'incompatible'):
            self.run_update(action='rollback')
        self.assert_no_mutation(ssh)

    @patch.object(deploy, 'ssh')
    def test_schema_is_reread_before_the_first_compose_write(self, ssh):
        self.responder(ssh)
        respond = ssh.side_effect
        reads = 0
        def change_schema(node, command, **kwargs):
            nonlocal reads
            if command[:2] == ['docker', 'exec']:
                reads += 1
                if reads == 3:return SimpleNamespace(stdout='[1,2,3,4]')
            return respond(node, command, **kwargs)
        ssh.side_effect = change_schema
        with self.assertRaisesRegex(deploy.DeploymentError, 'changed after preflight'):
            self.run_update()
        self.assert_no_mutation(ssh)

    @patch.object(deploy, 'ssh')
    def test_database_probe_failure_on_peer_blocks_all_mutations(self, ssh):
        self.responder(ssh); respond = ssh.side_effect
        def fail_peer(node, command, **kwargs):
            if command[:2] == ['docker', 'exec'] and node['role'] == 'primary':
                raise deploy.DeploymentError('database unavailable')
            return respond(node, command, **kwargs)
        ssh.side_effect = fail_peer
        with self.assertRaisesRegex(deploy.DeploymentError, 'database unavailable'):
            self.run_update()
        self.assert_no_mutation(ssh)

    @patch.object(deploy, 'ssh')
    def test_schema_change_before_second_node_stops_further_updates(self, ssh):
        self.responder(ssh); respond = ssh.side_effect; reads = 0
        def change_schema(node, command, **kwargs):
            nonlocal reads
            if command[:2] == ['docker', 'exec']:
                reads += 1
                if reads == 4:return SimpleNamespace(stdout='[1,2,3,4]')
            return respond(node, command, **kwargs)
        ssh.side_effect = change_schema
        with self.assertRaisesRegex(deploy.DeploymentError, 'spark-7468: database schema changed'):
            self.run_update()
        writes = [call for call in ssh.call_args_list if call.args[1][:2] == ['sh', '-c']]
        self.assertEqual(len(writes), 1)
        self.assertEqual(writes[0].args[0]['role'], 'standby')

    @patch.object(deploy, 'ssh')
    def test_invalid_json_database_response_is_reported_without_writing(self, ssh):
        self.responder(ssh); respond = ssh.side_effect
        def invalid_json(node, command, **kwargs):
            return SimpleNamespace(stdout='[1,2,') if command[:2] == ['docker', 'exec'] else respond(node, command, **kwargs)
        ssh.side_effect = invalid_json
        with self.assertRaisesRegex(deploy.DeploymentError, 'database schema history'):
            self.run_update()
        self.assert_no_mutation(ssh)

    def test_acceptance_rejects_non_integer_or_incomplete_schema_history(self):
        for history in [[], [True], [1, 3], [1, 2, 3, 4, 5, 6], ['1']]:
            with self.subTest(history=history), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'acceptance.json'; report = self.acceptance()
                report['runtime']['migrations'] = history; path.write_text(json.dumps(report))
                with self.assertRaises(deploy.DeploymentError):deploy.acceptance_evidence(path, 'sha256:candidate')

    @patch.object(deploy, 'ssh')
    def test_peer_image_mismatch_prevents_all_deployment_mutations(self, ssh):
        ssh.side_effect = [type('R', (), {'stdout': '1|1|sha256:candidate'})(),
                           type('R', (), {'stdout': '1|1|sha256:wrong-peer'})()]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'report.json'; path.write_text(json.dumps(self.acceptance()))
            with self.assertRaises(deploy.DeploymentError):
                deploy.update_application(self.config(), 'cursus-app:test', True, 'rollout', path)
        self.assertEqual(ssh.call_count, 2)
        self.assertTrue(all(call.args[1][:3] == ['docker', 'image', 'inspect'] for call in ssh.call_args_list))

    @patch.object(deploy, "run")
    def test_fence_requires_matching_nonce_authority_and_evidence(self, run):
        run.return_value.stdout = json.dumps({"isolated": True, "node": "spark-7468", "nonce": "wrong"})
        with self.assertRaises(deploy.DeploymentError): deploy.fence("adapter", self.config()["nodes"][0], "expected")
        run.return_value.stdout = json.dumps({"isolated": True, "node": "spark-7468", "nonce": "expected",
                                              "authority": "herding-sparks", "evidence": "ticket-1"})
        self.assertTrue(deploy.fence("adapter", self.config()["nodes"][0], "expected")["isolated"])

    def test_acceptance_policy_must_match_the_requested_loading_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'acceptance.json'
            evidence = self.acceptance()
            evidence['hard_loading_enabled'] = True
            path.write_text(json.dumps(evidence))
            with self.assertRaises(deploy.DeploymentError):
                deploy.acceptance_evidence(path, 'sha256:candidate')
            self.assertEqual(deploy.acceptance_evidence(path, 'sha256:candidate', hard_loading_enabled=True)['status'], 'passed')
            evidence['hard_loading_enabled'] = False
            path.write_text(json.dumps(evidence))
            with self.assertRaises(deploy.DeploymentError):
                deploy.acceptance_evidence(path, 'sha256:candidate', hard_loading_enabled=True)


if __name__ == "__main__": unittest.main()
