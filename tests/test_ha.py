import copy
import contextlib
import importlib.util
import io
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path

MODULE = Path(__file__).parents[1] / "deploy/ha.py"
SPEC = importlib.util.spec_from_file_location("cursus_ha", MODULE)
ha = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ha)
CFG = ha.load_config(Path(__file__).parents[1] / "deploy/ha.json")


def converged_state():
    return {
        "lb": {"id": CFG["load_balancer"]["id"], **CFG["load_balancer"], "unknown": "keep"},
        "monitor": {"id": CFG["monitor"]["id"], **CFG["monitor"], "description": "keep"},
        "nodes": [{
            "pool": {"id": n["pool"]["id"], **ha.desired_pool(CFG, n), "unknown": "keep"},
            "tunnel": {"id": n["tunnel_id"], "status": "healthy"},
            "tunnel_config": {"ingress": [
                {"hostname": f"{n['ssh_alias']}.artalis.io", "service": "ssh://localhost:22", "originRequest": {"keepAlive": 30}},
                {"hostname": CFG["hostname"], "service": n["service"]},
                {"service": "http_status:404"}], "warp-routing": {"enabled": False}, "unknown": {"preserve": True}}
        } for n in CFG["nodes"]]
    }


class FakeClient:
    def __init__(self, state=None, fail_resource=None):
        self.state = copy.deepcopy(state or converged_state())
        self.fail_resource = fail_resource
        self.writes = []

    def _node(self, path):
        return next((i for i, n in enumerate(CFG["nodes"]) if n["pool"]["id"] in path or n["tunnel_id"] in path), None)

    def get(self, path):
        if path.endswith("/tokens/verify"): return {"status": "active"}
        if "/load_balancers/monitors/" in path: return copy.deepcopy(self.state["monitor"])
        if "/load_balancers/pools/" in path:
            item = self.state["nodes"][self._node(path)]
            if path.endswith("/health"): return {"pop_health": {"Budapest": {"healthy": True}}}
            return copy.deepcopy(item["pool"])
        if "/cfd_tunnel/" in path:
            item = self.state["nodes"][self._node(path)]
            if path.endswith("/configurations"): return {"config": copy.deepcopy(item["tunnel_config"])}
            return copy.deepcopy(item["tunnel"])
        if "/load_balancers/" in path: return copy.deepcopy(self.state["lb"])
        raise AssertionError(path)

    def patch(self, path, body):
        self.writes.append(("PATCH", path, copy.deepcopy(body)))
        if self.fail_resource and self.fail_resource in path: raise ha.APIError("injected failure")
        if "/monitors/" in path: self.state["monitor"].update(body)
        elif "/pools/" in path: self.state["nodes"][self._node(path)]["pool"].update(body)
        else: self.state["lb"].update(body)

    def put(self, path, body):
        self.writes.append(("PUT", path, copy.deepcopy(body)))
        if self.fail_resource and self.fail_resource in path: raise ha.APIError("injected failure")
        self.state["nodes"][self._node(path)]["tunnel_config"] = copy.deepcopy(body["config"])


class HATests(unittest.TestCase):
    def test_converged_plan_and_apply_are_idempotent(self):
        fake = FakeClient()
        self.assertEqual([], ha.build_plan(CFG, ha.fetch_state(fake, CFG)))
        with contextlib.redirect_stdout(io.StringIO()): ha.apply(fake, CFG, True)
        self.assertEqual([], fake.writes)

    def test_drift_reports_only_owned_fields(self):
        state = converged_state(); state["lb"]["enabled"] = False
        changes = ha.build_plan(CFG, state)
        self.assertEqual(["load_balancer"], [c["resource"] for c in changes])
        self.assertNotIn("unknown", changes[0]["desired"])

    def test_ingress_merge_preserves_ssh_catchall_warp_and_unknown(self):
        current = converged_state()["nodes"][0]["tunnel_config"]
        current["ingress"][1]["service"] = "http://localhost:9999"
        current["ingress"].insert(1, {"hostname": "other.artalis.io", "service": "http://localhost:7"})
        merged, changed = ha.merge_ingress(current, CFG["hostname"], "http://localhost:8080")
        self.assertTrue(changed)
        self.assertEqual("ssh://localhost:22", merged["ingress"][0]["service"])
        self.assertIn({"hostname": "other.artalis.io", "service": "http://localhost:7"}, merged["ingress"])
        self.assertEqual({"enabled": False}, merged["warp-routing"])
        self.assertEqual({"preserve": True}, merged["unknown"])
        self.assertEqual(1, sum(r.get("hostname") == CFG["hostname"] for r in merged["ingress"]))

    def test_pool_reconciliation_updates_existing_id_without_create(self):
        state = converged_state(); state["nodes"][0]["pool"]["origins"][0]["weight"] = 0.5
        fake = FakeClient(state)
        with contextlib.redirect_stdout(io.StringIO()): ha.apply(fake, CFG, True)
        self.assertEqual("PATCH", fake.writes[0][0])
        self.assertIn(CFG["nodes"][0]["pool"]["id"], fake.writes[0][1])
        self.assertEqual(2, sum(len(n["pool"]["origins"]) for n in fake.state["nodes"]))

    def test_config_rejects_duplicate_origins_and_quota_overflow(self):
        bad = copy.deepcopy(CFG)
        bad["nodes"][1]["pool"]["origin"]["address"] = bad["nodes"][0]["pool"]["origin"]["address"]
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "ha.json"; p.write_text(json.dumps(bad))
            with self.assertRaisesRegex(ha.HAError, "quota or duplicates"): ha.load_config(p)

    def test_apply_requires_approval(self):
        with self.assertRaisesRegex(ha.HAError, "requires --approve"): ha.apply(FakeClient(), CFG, False)

    def test_partial_update_failure_is_reported_and_successes_verified(self):
        state = converged_state()
        state["monitor"]["timeout"] = 4
        state["nodes"][0]["pool"]["enabled"] = False
        fake = FakeClient(state, fail_resource="monitors")
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaisesRegex(ha.HAError, "partial apply"):
                ha.apply(fake, CFG, True)
        self.assertTrue(fake.state["nodes"][0]["pool"]["enabled"])
        self.assertEqual(4, fake.state["monitor"]["timeout"])

    def test_api_read_failure_retries_and_redacts_token(self):
        class Opener:
            calls = 0
            def open(self, *_args, **_kwargs):
                self.calls += 1
                raise urllib.error.URLError("offline")
        opener = Opener(); client = ha.Cloudflare("SUPER_SECRET", base="https://invalid", opener=opener)
        old_sleep = ha.time.sleep; ha.time.sleep = lambda _: None
        try:
            with self.assertRaises(ha.APIError) as ctx: client.get("/resource")
        finally: ha.time.sleep = old_sleep
        self.assertEqual(3, opener.calls)
        self.assertNotIn("SUPER_SECRET", str(ctx.exception))


if __name__ == "__main__": unittest.main()
