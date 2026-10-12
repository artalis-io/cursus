import json
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
INVENTORY = json.loads((ROOT / "deploy/stateful-inventory.json").read_text())


class StatefulDesignGuardrails(unittest.TestCase):
    def test_current_state_is_not_claimed_multi_replica_safe(self):
        safety = INVENTORY["current_safety"]
        self.assertEqual("single-writer-only", safety["mode"])
        self.assertFalse(safety["two_application_replicas_safe"])
        self.assertFalse(safety["automatic_database_failover_safe"])

    def test_inventory_ids_and_locations_are_unique(self):
        state = INVENTORY["state"]
        self.assertEqual(len(state), len({x["id"] for x in state}))
        self.assertEqual(len(state), len({x["location"] for x in state}))

    def test_every_state_item_has_ownership_and_replica_decision(self):
        required = {"id", "location", "owner", "classification", "authoritative", "writers", "multi_replica", "target"}
        for item in INVENTORY["state"]:
            self.assertFalse(required - item.keys(), item["id"])
            self.assertTrue(item["target"].strip(), item["id"])

    def test_authoritative_mutable_state_has_a_shared_target(self):
        for item in INVENTORY["state"]:
            if not item["authoritative"] or item["classification"] == "immutable-input": continue
            target = item["target"].lower()
            self.assertTrue("postgresql" in target or "object storage" in target, item["id"])

    def test_all_background_work_has_duplicate_control(self):
        expected = {"solve", "dataset-admit", "retention-gc", "magic-link-email-proposed"}
        work = INVENTORY["background_execution"]
        self.assertEqual(expected, {x["id"] for x in work})
        for item in work:
            self.assertTrue(item["duplicate_risk"])
            self.assertRegex(item["required_control"], r"lease|transaction|idempot")

    def test_pending_auth_and_resend_are_not_omitted(self):
        by_id = {x["id"]: x for x in INVENTORY["state"]}
        self.assertEqual("unsafe", by_id["auth-sqlite-proposed"]["multi_replica"])
        self.assertIn("idempotency", by_id["resend-delivery-proposed"]["multi_replica"])

    def test_dual_writer_gate_covers_database_jobs_email_and_restore(self):
        gates = " ".join(INVENTORY["required_before_two_writers"]).lower()
        for term in ("postgresql", "leased jobs", "resend outbox", "backup restore", "tenant-key"):
            self.assertIn(term, gates)


if __name__ == "__main__": unittest.main()
