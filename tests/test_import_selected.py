import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('selected_import', Path(__file__).parents[1] / 'deploy/import-selected.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)


class SelectedImportTests(unittest.TestCase):
    def batch(self):
        return {'tenant': 'production', 'datasetId': 'fixture', 'datasetManifest': {'schemaVersion': 1}, 'selectionSha256': 'a'*64,
                'plans': [{'previousScenario': {'revision': 0, 'body': {'id': 'day1-base'}},
                           'scenario': {'id': 'day1-base', 'revision': 1, 'planningPolicy': {'id': 'approved'}},
                           'plan': {'id': 'pln_selected_fixture', 'createdAt': '2026-01-01T00:00:00Z'}}]}

    def test_atomic_additive_import_has_drift_and_active_worker_guards(self):
        sql = module.build_sql(self.batch())
        self.assertTrue(sql.startswith('BEGIN;')); self.assertTrue(sql.endswith('COMMIT;'))
        for guard in ['FOR UPDATE', 'dataset drift', 'scenario changed', 'active solve', 'partial import', 'import identity drift']:
            self.assertIn(guard, sql)
        self.assertIn('INSERT INTO plans', sql); self.assertIn('INSERT INTO audit_events', sql)
        for forbidden in ['DELETE ', 'TRUNCATE ', 'UPDATE sessions', 'UPDATE email_outbox', 'UPDATE datasets']:
            self.assertNotIn(forbidden, sql)

    def test_idempotent_import_never_upserts_or_overwrites_existing_plans(self):
        sql = module.build_sql(self.batch())
        self.assertIn('IF existing_count=0 THEN', sql)
        self.assertIn('AND body=', sql)
        self.assertNotIn('ON CONFLICT', sql); self.assertNotIn('UPDATE plans', sql)

    def test_local_transaction_drill_can_rollback(self):
        self.assertTrue(module.build_sql(self.batch(), commit=False).endswith('ROLLBACK;'))

    def test_sql_quoting_and_canonical_identity(self):
        self.assertEqual(module.text("a'b"), "'a''b'")
        self.assertEqual(module.canonical({'z': 1, 'a': 2}), module.canonical({'a': 2, 'z': 1}))

    def test_floating_image_tags_rejected_before_inventory_or_archive_use(self):
        with self.assertRaisesRegex(ValueError, 'digest'):
            module.prepare('/does-not-exist', {}, 'latest')
