import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/* The store writes JSON under config.dataDir, which config.ts captures from
 * DISPATCH_DATA_DIR at module load. So we set the env to a fresh temp dir
 * BEFORE dynamically importing config/store. We import the Store CLASS (not
 * the module-level singleton) so each run is clean, but it still reads/writes
 * the temp dir via the same captured config. */

let tmp: string;
// Loaded lazily after env is set.
let StoreCtor: typeof import('./store.js').Store;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), `dispatch-store-${randomUUID().slice(0, 8)}-`));
  process.env.DISPATCH_DATA_DIR = tmp;
  // Dynamic import AFTER env is set so config captures the temp dir.
  const mod = await import('./store.js');
  StoreCtor = mod.Store;
  // Sanity: config must have picked up our dir.
  const { config } = await import('./config.js');
  assert.equal(config.dataDir, tmp, 'config.dataDir did not capture DISPATCH_DATA_DIR');
});

after(() => {
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

test('ensureBaseScenario is idempotent and revision 0', () => {
  const store = new StoreCtor();
  const a = store.ensureBaseScenario('day1', 'Base Day 1');
  assert.equal(a.id, 'day1-base');
  assert.equal(a.kind, 'base');
  assert.equal(a.parentId, null);
  assert.equal(a.revision, 0);
  assert.deepEqual(a.removedVehicleIds, []);

  // Idempotent: same object identity, no duplicate.
  const b = store.ensureBaseScenario('day1', 'Different Label');
  assert.equal(b, a, 'second call should return the SAME cached scenario');
  assert.equal(b.label, 'Base Day 1', 'label must not change on re-ensure');

  // Persisted to disk and re-loadable by a fresh Store from the same dir.
  const path = join(tmp, 'scenarios', 'day1-base.json');
  assert.ok(existsSync(path), 'base scenario should be persisted');
  const reloaded = new StoreCtor();
  const r = reloaded.getScenario('day1-base');
  assert.ok(r);
  assert.equal(r!.revision, 0);
});

test('createCopy produces a new scenario; parent stays immutable', () => {
  const store = new StoreCtor();
  const base = store.ensureBaseScenario('day1', 'Base Day 1');
  const baseRemovedBefore = [...base.removedVehicleIds];

  const copy = store.createCopy(base, { removeVehicleId: 7 });

  // New distinct scenario.
  assert.notEqual(copy.id, base.id);
  assert.match(copy.id, /^scn_/);
  assert.equal(copy.kind, 'copy');
  assert.equal(copy.parentId, base.id);
  assert.equal(copy.revision, 1); // bumped from base revision 0
  assert.deepEqual(copy.removedVehicleIds, [7]);
  assert.equal(copy.day, base.day);

  // Parent unchanged (immutability): removedVehicleIds not mutated in place.
  assert.deepEqual(base.removedVehicleIds, baseRemovedBefore);
  assert.deepEqual(base.removedVehicleIds, []);
  assert.equal(base.revision, 0);

  // Copy persisted.
  assert.ok(existsSync(join(tmp, 'scenarios', `${copy.id}.json`)));
});

test('a second createCopy accumulates removedVehicleIds', () => {
  const store = new StoreCtor();
  const base = store.ensureBaseScenario('day2', 'Base Day 2');

  const c1 = store.createCopy(base, { removeVehicleId: 7 });
  assert.deepEqual(c1.removedVehicleIds, [7]);

  // Chain off the first copy -> accumulates.
  const c2 = store.createCopy(c1, { removeVehicleId: 9 });
  assert.deepEqual([...c2.removedVehicleIds].sort((a, b) => a - b), [7, 9]);

  // Re-removing the same id is a no-op (no duplicate).
  const c3 = store.createCopy(c2, { removeVehicleId: 7 });
  assert.deepEqual([...c3.removedVehicleIds].sort((a, b) => a - b), [7, 9]);

  // First copy unchanged.
  assert.deepEqual(c1.removedVehicleIds, [7]);
});

test('createJob records scenarioRevision and persists (stale-job association)', () => {
  const store = new StoreCtor();
  const base = store.ensureBaseScenario('day1', 'Base Day 1');
  const copy = store.createCopy(base, { removeVehicleId: 42 });

  // Deliberately pass a revision different from the scenario's current one to
  // prove the job stores the revision it was created against (the UI relies on
  // this to detect staleness), not re-derived from the scenario later.
  const job = store.createJob(copy.id, copy.revision);
  assert.match(job.id, /^job_/);
  assert.equal(job.scenarioId, copy.id);
  assert.equal(job.scenarioRevision, copy.revision);
  assert.equal(job.status, 'pending');
  assert.equal(job.planId, null);

  // Persisted and reloadable with the revision intact.
  const path = join(tmp, 'jobs', `${job.id}.json`);
  assert.ok(existsSync(path));
  const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { scenarioRevision: number };
  assert.equal(onDisk.scenarioRevision, copy.revision);

  const reloaded = new StoreCtor();
  const rj = reloaded.getJob(job.id);
  assert.ok(rj);
  assert.equal(rj!.scenarioRevision, copy.revision);
  assert.equal(rj!.scenarioId, copy.id);
});

test('reconcileInterruptedJobs: pending/running jobs become failed on restart', () => {
  const s1 = new StoreCtor();
  const j = s1.createJob('scn-x', 0);      // persisted as 'pending'
  j.status = 'running'; s1.saveJob(j);     // simulate an in-flight solve
  assert.equal(s1.getJob(j.id)!.status, 'running');

  // A fresh Store over the same data dir simulates a process restart: the
  // in-memory queue and child handles are gone, so the job can never finish.
  const s2 = new StoreCtor();
  const rj = s2.getJob(j.id)!;
  assert.equal(rj.status, 'failed');
  assert.match(rj.error ?? '', /interrupted/);
  assert.ok(rj.finishedAt);
});

test('scenario workspace: list by day, rename, delete copies (base protected)', () => {
  const store = new StoreCtor();
  const base = store.ensureBaseScenario('day1', 'Base Day 1');
  const copy = store.forkForEdit(base, 'What-if A');
  assert.ok(store.scenariosForDay('day1').some((s) => s.id === copy.id));
  assert.ok(store.scenariosForDay('day1').some((s) => s.id === base.id));
  store.renameScenario(copy.id, 'Drop subcontractor');
  assert.equal(store.getScenario(copy.id)!.label, 'Drop subcontractor');
  assert.equal(store.deleteScenario(copy.id), true);
  assert.equal(store.getScenario(copy.id), undefined);
  assert.throws(() => store.deleteScenario(base.id), /base scenario/);
});

test('parseScenarioImport: validates + cleans an untrusted bundle', async () => {
  const { parseScenarioImport } = await import('./store.js');
  const r = parseScenarioImport({ otto_scenario: 1, day: 'day1', label: 'Shared',
    edits: { removedVehicleIds: [3, 'x'], pins: [{ orderNo: 'O1', vehicleId: 2 }, { bad: 1 }],
      forbids: [], vehicleOverrides: [{ vehicleId: 1, maxTrips: 3, capacityKg: 999999999 }],
      sequences: [{ vehicleId: 0, orderNos: ['A', 'B'], locked: true }] } });
  assert.ok(!('error' in r));
  if (!('error' in r)) {
    assert.deepEqual(r.edits.removedVehicleIds, [3]);            // non-int dropped
    assert.equal(r.edits.pins.length, 1);                       // malformed pin dropped
    assert.equal(r.edits.vehicleOverrides[0]!.maxTrips, 3);
    assert.equal(r.edits.vehicleOverrides[0]!.capacityKg, undefined); // out of bounds dropped
    assert.equal(r.edits.sequences[0]!.locked, true);
  }
  assert.ok('error' in parseScenarioImport({ day: 'day1' }));   // missing otto_scenario marker
  assert.ok('error' in parseScenarioImport({ otto_scenario: 1 })); // missing day
});
