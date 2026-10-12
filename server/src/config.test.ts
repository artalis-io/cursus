import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

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

test('importing shared solve helpers does not initialize the legacy store', () => {
  const root = mkdtempSync(join(tmpdir(), 'cursus-stateful-import-'));
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval',
      "await import('./src/solve.ts')"], {
      cwd: process.cwd(), env: { ...process.env, CURSUS_DATA_DIR: root }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(root, 'scenarios')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
