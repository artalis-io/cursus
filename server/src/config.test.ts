import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { missingConfigPaths } from './config.js';
import { populationConfig } from './solver-config.js';

test('population search cannot be disabled by stored dataset settings', () => {
  const previous = { population: false, population_threads: 0, population_generations: 1,
    max_time_seconds: 360, hard_capacity: true, hard_time_windows: true, lexicographic_objective: true };
  const result = populationConfig(previous);
  assert.equal(result.population, true);
  assert.equal(result.population_generations, 3);
  assert.ok(Number.isInteger(result.population_threads));
  assert.ok(Number(result.population_threads) >= 1 && Number(result.population_threads) <= 16);
  assert.equal(result.max_time_seconds, 360);
  assert.equal(result.hard_capacity, true);
  assert.equal(result.hard_time_windows, true);
  assert.equal(result.lexicographic_objective, true);
  assert.equal(previous.population, false, 'immutable dataset settings must not be mutated');
});

test('population thread configuration is bounded and rejects unsafe values', () => {
  for (const value of ['0', '-1', '1.5', '17', 'NaN']) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval',
      "await import('./src/config.ts')"], { cwd: process.cwd(), env: { ...process.env, DISPATCH_SOLVE_THREADS: value }, encoding: 'utf8' });
    assert.notEqual(result.status, 0, value);
    assert.match(result.stderr, /DISPATCH_SOLVE_THREADS must be an integer from 1 to 16/);
  }
});

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

test('importing the stateful conversion worker has no legacy filesystem side effects', () => {
  const root = mkdtempSync(join(tmpdir(), 'cursus-stateful-import-'));
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval',
      "await import('./src/state/conversion.ts')"], {
      cwd: process.cwd(), env: { ...process.env, CURSUS_DATA_DIR: root }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(root, 'scenarios')), false);
    assert.equal(existsSync(join(root, 'uploads')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
