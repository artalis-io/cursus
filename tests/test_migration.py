import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value


source = module("cursus_migration_source", "deploy/migration-source.py")
adapter = module("cursus_migration_adapter", "deploy/migration-adapter.py")


class MigrationSourceTests(unittest.TestCase):
    def test_classification_never_admits_all_files(self):
        cfg = json.loads((ROOT / "deploy/production-migration.json").read_text())
        self.assertEqual("raw-orders", source.classify("raw/gyermelyi_orders_raw.csv", cfg))
        self.assertEqual("regenerable-or-nonauthoritative", source.classify("results/run.json", cfg))
        self.assertEqual("supporting-source", source.classify("scripts/verify.py", cfg))
        self.assertEqual(5, len(cfg["authoritative_dataset_files"]))
        self.assertLess(len(cfg["authoritative_dataset_files"]), cfg["expected"]["dataset_files"])

    def test_manifest_detects_file_change(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); legacy = root / "legacy"; dataset = root / "dataset"
            for name in ("scenarios", "plans", "jobs"): (legacy / name).mkdir(parents=True)
            scenario = {"id": "s", "revision": 0, "createdAt": "2026-01-01T00:00:00Z"}
            plan = {"id": "p", "scenarioId": "s", "scenarioRevision": 0, "createdAt": "2026-01-01T00:00:00Z"}
            job = {"id": "j", "scenarioId": "s", "scenarioRevision": 0, "planId": "p"}
            (legacy / "scenarios/s.json").write_text(json.dumps(scenario)); (legacy / "plans/p.json").write_text(json.dumps(plan)); (legacy / "jobs/j.json").write_text(json.dumps(job))
            (dataset / "input").mkdir(parents=True); (dataset / "raw").mkdir()
            request = {name: [] for name in ("locations", "vehicles", "tasks", "requests")}
            (dataset / "request.json").write_text(json.dumps(request)); (dataset / "input/geocoded.json").write_text(json.dumps({"records": [{"delivery_date": "d"}]}))
            cfg = {"schema_version": 1, "legacy_state": str(legacy), "dataset_root": str(dataset),
                   "expected": {"scenarios": 1, "plans": 1, "jobs": 1, "dataset_files": 2},
                   "authoritative_dataset_files": [{"path": "request.json", "role": "solver-request"}, {"path": "input/geocoded.json", "role": "geocoded-orders"}],
                   "excluded_prefixes": [], "days": [{"date": "d"}]}
            value = source.manifest(cfg)
            self.assertTrue(source.verify(value, cfg)["valid"])
            (dataset / "request.json").write_text("changed")
            with self.assertRaisesRegex(source.SourceError, "source changed"):
                source.verify(value, cfg)


class MigrationAdapterTests(unittest.TestCase):
    def test_deterministic_legacy_job_mapping_and_atomic_empty_guard(self):
        cfg = {"tenant_id": "production", "dataset_id": "dataset"}
        scenarios = [{"id": "s", "revision": 0, "createdAt": "2026-01-01T00:00:00Z"}]
        plans = [{"id": "p", "scenarioId": "s", "scenarioRevision": 0, "createdAt": "2026-01-01T00:00:00Z"}]
        jobs = [{"id": "legacy", "scenarioId": "s", "scenarioRevision": 0, "planId": "p", "createdAt": "2026-01-01T00:00:00Z", "finishedAt": "2026-01-01T00:01:00Z"}]
        obj = {"key": "tenants/production/sha256/" + "a" * 64, "sha256": "a" * 64, "size": 1, "mediaType": "x"}
        first, mapping1 = adapter.build_sql(cfg, scenarios, plans, jobs, [({"role": "x"}, obj)], {}, ["admin@example.invalid"])
        second, mapping2 = adapter.build_sql(cfg, scenarios, plans, jobs, [({"role": "x"}, obj)], {}, ["admin@example.invalid"])
        self.assertEqual(mapping1, mapping2)
        self.assertIn("production tenant is not empty", first)
        self.assertTrue(first.startswith("BEGIN;")); self.assertIn("COMMIT;", first)
        self.assertNotIn("email_outbox", first.split("COMMIT;")[0])

    def test_object_key_is_tenant_checksum_addressed(self):
        with tempfile.NamedTemporaryFile() as handle:
            handle.write(b"payload"); handle.flush()
            value = adapter.object_descriptor(Path(handle.name), "application/octet-stream", "production")
        self.assertEqual("tenants/production/sha256/", value["key"][:26])
        self.assertEqual(64, len(value["sha256"]))


if __name__ == "__main__": unittest.main()
