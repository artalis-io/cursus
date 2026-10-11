import { test } from 'node:test';
import assert from 'node:assert/strict';

import { missingConfigPaths } from './config.js';

test('missingConfigPaths: reports dependency paths that do not exist, naming var + feature', () => {
  const missing = missingConfigPaths();
  // Shape contract (what the startup reporter relies on), regardless of which
  // paths happen to exist on this machine.
  for (const m of missing) {
    assert.equal(typeof m.variable, 'string');
    assert.ok(m.variable.length > 0);
    assert.equal(typeof m.path, 'string');
    assert.equal(typeof m.feature, 'string');
    assert.ok(m.feature.length > 0);
  }
  // Every reported var is one of the known external dependencies.
  const known = new Set(['SURGE_BIN', 'VELO_GRAPH', 'MATRIX_BUILD_BIN', 'NEXUS_DIR/nx_pipeline', 'DATASET_ROOT']);
  for (const m of missing) assert.ok(known.has(m.variable), `unexpected var ${m.variable}`);
});
