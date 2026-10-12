import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("stateful_deploy", ROOT / "deploy/stateful.py")
deploy = importlib.util.module_from_spec(spec); spec.loader.exec_module(deploy)


class StatefulDeploymentTests(unittest.TestCase):
    def config(self): return json.loads((ROOT / "deploy/stateful.json").read_text())

    def test_checked_in_inventory_and_compose_are_safe(self):
        cfg = deploy.load(ROOT / "deploy/stateful.json")
        self.assertTrue(deploy.command_validate(cfg)["valid"])

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
            type("R", (), {"stdout": "1|1|sha256:secondary\n"})(), type("R", (), {"stdout": ""})(),
            type("R", (), {"stdout": '{"status":"ready"}'})(),
            type("R", (), {"stdout": "1|1|sha256:primary\n"})(), type("R", (), {"stdout": ""})(),
            type("R", (), {"stdout": '{"status":"ready"}'})(),
        ]
        result = deploy.update_application(self.config(), "cursus-app:test", True, "rollout")
        self.assertEqual([n["role"] for n in result["nodes"]], ["standby", "primary"])
        self.assertEqual(ssh.call_args_list[0].args[0]["name"], "spark-3eb0")

    @patch.object(deploy, "run")
    def test_fence_requires_matching_nonce_authority_and_evidence(self, run):
        run.return_value.stdout = json.dumps({"isolated": True, "node": "spark-7468", "nonce": "wrong"})
        with self.assertRaises(deploy.DeploymentError): deploy.fence("adapter", self.config()["nodes"][0], "expected")
        run.return_value.stdout = json.dumps({"isolated": True, "node": "spark-7468", "nonce": "expected",
                                              "authority": "herding-sparks", "evidence": "ticket-1"})
        self.assertTrue(deploy.fence("adapter", self.config()["nodes"][0], "expected")["isolated"])


if __name__ == "__main__": unittest.main()
