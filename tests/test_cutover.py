import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, call, patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("cursus_cutover", ROOT / "deploy/cutover.py")
cutover = importlib.util.module_from_spec(spec); spec.loader.exec_module(cutover)


class Result:
    def __init__(self, stdout="", returncode=0, stderr=""):
        self.stdout, self.returncode, self.stderr = stdout, returncode, stderr


class CutoverTests(unittest.TestCase):
    def config(self): return cutover.load(ROOT / "deploy/production.json")

    def test_inventory_reuses_ha_nodes_and_isolated_candidate_ports(self):
        cfg = self.config()
        self.assertTrue(cutover.validate(cfg)["valid"])
        self.assertEqual({18101, 18102}, {n["candidate_port"] for n in cfg["nodes"]})
        self.assertEqual({8080}, {n["active_port"] for n in cfg["nodes"]})

    def test_recovery_adapter_is_network_isolated_and_backup_read_only(self):
        adapter = (ROOT / "deploy/recovery-adapter.py").read_text()
        self.assertIn("--network none", adapter)
        self.assertIn("postgres-backups:/backup:ro", adapter)
        self.assertIn("backup_manifest_sha256", adapter)

    def test_all_mutating_stages_require_distinct_approval(self):
        cfg = self.config()
        with self.assertRaisesRegex(cutover.CutoverError, "approve-provision"):
            cutover.provision(cfg, False, None)
        with self.assertRaisesRegex(cutover.CutoverError, "approve-migration"):
            cutover.migrate(cfg, False, None, None)
        with self.assertRaisesRegex(cutover.CutoverError, "approve-cutover"):
            cutover.activate(cfg, False)

    def test_cutover_rejects_missing_acceptance_before_cloudflare_access(self):
        with patch.object(cutover, 'read_evidence', return_value={'nodes': [{'image_id': 'sha256:candidate'}]}), \
             patch.object(cutover, 'candidate_status', return_value={'ready': True, 'image_id': 'sha256:candidate'}), \
             patch.object(cutover, 'load_ha') as cloudflare:
            with self.assertRaisesRegex(cutover.CutoverError, '--acceptance-report'):
                cutover.activate(self.config(), True)
            cloudflare.assert_not_called()

    def test_migration_requires_prior_gate_freeze_and_adapter(self):
        cfg = self.config()
        with patch.object(cutover, "read_evidence", return_value={"success": True}):
            with self.assertRaisesRegex(cutover.CutoverError, "freeze-evidence"):
                cutover.migrate(cfg, True, None, None)
            with tempfile.NamedTemporaryFile("w", suffix=".json") as handle:
                json.dump({"frozen": True}, handle); handle.flush()
                with self.assertRaisesRegex(cutover.CutoverError, "authority"):
                    cutover.migrate(cfg, True, Path(handle.name), "adapter")

    @patch.object(cutover, "ssh")
    def test_preflight_inventory_does_not_read_secret_values(self, ssh):
        ssh.return_value = Result("arch=aarch64\ndocker=29.6.2\ncompose=5.2.0\n"
                                  "disk_kb=1\nmemory_kb=1\nport8080=ready\n"
                                  "hello_pids=123\ncloudflared=active\n")
        with patch.object(cutover.Path, "home", return_value=ROOT / "tests"), \
             patch.object(cutover.Path, "is_file", return_value=True), \
             patch.object(cutover.Path, "stat") as stat:
            stat.return_value.st_mode = 0o100600
            result = cutover.preflight(self.config())
        self.assertEqual([], result["mutations"])
        self.assertEqual(2, len(result["nodes"]))
        self.assertEqual(5, len(result["controller_secret_files"]))
        self.assertNotIn("value", result["controller_secret_files"][0])

    @patch.object(cutover, "ssh")
    def test_hello_stop_targets_exact_allowlisted_process(self, ssh):
        cutover.stop_hello(self.config()["nodes"][0], self.config())
        command = ssh.call_args.args[1]
        self.assertIn("^python3 /tmp/cursus-hello.py$", command)
        self.assertNotIn("pkill", command)
        self.assertIn("/proc/$pid/cmdline", command)

    @patch.object(cutover, "ssh")
    def test_hello_start_backgrounds_only_nohup_branch(self, ssh):
        cutover.start_hello(self.config()["nodes"][0], self.config())
        command = ssh.call_args.args[1]
        self.assertIn("|| { nohup", command)
        self.assertIn("</dev/null & }", command)

    @patch.object(cutover, "ssh")
    def test_persisted_port_update_is_exact_and_atomic_enough(self, ssh):
        node = self.config()["nodes"][0]
        cutover.set_app_port(node, 8080)
        command = ssh.call_args.args[1]
        self.assertIn("grep -c '^CURSUS_STAGING_PORT='", command)
        self.assertIn("CURSUS_STAGING_PORT=8080", command)
        self.assertIn("sed -i.bak", command)

    @patch.object(cutover, "start_hello")
    @patch.object(cutover, "set_app_port")
    @patch.object(cutover, "compose")
    @patch.object(cutover, "stop_hello")
    @patch.object(cutover, "ssh")
    def test_failed_node_activation_restores_candidate_and_hello(self, ssh, stop, compose, set_port, start):
        ssh.side_effect = cutover.CutoverError("not ready")
        node = self.config()["nodes"][1]
        with self.assertRaises(cutover.CutoverError): cutover.activate_node(node, self.config())
        self.assertEqual([call(node, 8080), call(node, 18102)], set_port.call_args_list)
        start.assert_called_once_with(node, self.config())

    def test_cloudflare_health_wait_requires_every_location(self):
        unhealthy = {"nodes": [{"health": {"pop_health": {"a": {"healthy": True}, "b": {"healthy": False}}}}]}
        healthy = {"nodes": [{"health": {"pop_health": {"a": {"healthy": True}, "b": {"healthy": True}}}}]}
        ha = Mock(); ha.fetch_state.side_effect = [unhealthy, healthy]
        with patch.object(cutover.time, "sleep"):
            cutover.wait_origin_healthy(ha, object(), {"nodes": [{"name": "primary"}]}, "primary", 1)
        self.assertEqual(2, ha.fetch_state.call_count)


if __name__ == "__main__": unittest.main()
