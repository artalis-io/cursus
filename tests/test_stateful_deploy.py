import importlib.util
import json
import datetime as dt
import tempfile
import unittest
from pathlib import Path
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
                'browser': {'expected': 7, 'unexpected': 0, 'flaky': 0, 'skipped': 0},
                'runtime': {'migrations': [1], 'native': {name: 'd' * 64 for name in ['surge', 'matrix', 'nexus']}}}

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
        ssh.side_effect = [
            type("R", (), {"stdout": "1|1|sha256:candidate\n"})(),
            type("R", (), {"stdout": "1|1|sha256:candidate\n"})(), type("R", (), {"stdout": ""})(),
            type("R", (), {"stdout": '{"status":"ready"}'})(),
            type("R", (), {"stdout": ""})(),
            type("R", (), {"stdout": '{"status":"ready"}'})(),
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'acceptance.json'; path.write_text(json.dumps(self.acceptance()))
            result = deploy.update_application(self.config(), "cursus-app:test", True, "rollout", path)
        self.assertEqual([n["role"] for n in result["nodes"]], ["standby", "primary"])
        self.assertEqual(ssh.call_args_list[0].args[0]["name"], "spark-3eb0")

    def test_release_gate_rejects_missing_failed_dirty_skipped_and_old_evidence(self):
        with self.assertRaisesRegex(deploy.DeploymentError, '--acceptance-report'):
            deploy.acceptance_evidence(None, 'sha256:candidate')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'report.json'
            for field, value in [('status', 'failed'), ('checkout_dirty', True), ('image_id', 'sha256:different'),
                                 ('harness_sha256', 'c' * 64),
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


if __name__ == "__main__": unittest.main()
