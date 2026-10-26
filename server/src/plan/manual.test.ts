import test from 'node:test';
import assert from 'node:assert/strict';
import { applyManualBatch, assertManualLayout, type ManualLayout, type ManualCommand } from './manual.js';

const actor = { actorId: 'planner-1', at: '2026-10-26T12:00:00Z' };
function layout(): ManualLayout {
  return { datasetSha256: 'a'.repeat(64), requestIds: [91, 92, 93], vehicleIds: [7, 42, 99],
    excludedVehicleIds: [99], lockedVehicleIds: [],
    routes: [{ vehicleId: 7, tripId: 'trip-1', requestIds: [91, 92] }], unassigned: [93],
    decisions: {}, origins: { '91': 'optimizer', '92': 'import' }, history: [] };
}
const apply = (input: ManualLayout, commands: ManualCommand[], operationId = 'edit-1') =>
  applyManualBatch(input, { operationId, datasetSha256: input.datasetSha256, commands }, actor);

test('assign available vehicle: exact identity coverage, attribution and immutable input', () => {
  const input = layout(), before = structuredClone(input);
  const out = apply(input, [{ op: 'assign', requestId: 93, vehicleId: 42, tripId: 'new', position: 0 }]);
  assert.deepEqual(input, before);
  assert.deepEqual(out.unassigned, []);
  assert.deepEqual(out.decisions['93'], { kind: 'vehicle', vehicleId: 42 });
  assert.equal(out.origins['93'], 'historical');
  assert.deepEqual(out.history[0], { operationId: 'edit-1', index: 0, requestId: 93, action: 'assign',
    ...actor, from: null, to: { vehicleId: 42, tripId: 'new', position: 0 } });
});

test('move/deassign/release retain provenance and release does not move order', () => {
  let out = apply(layout(), [{ op: 'assign', requestId: 91, vehicleId: 42, tripId: 'new', position: 0 }]);
  assert.equal(out.origins['91'], 'optimizer');
  assert.deepEqual(out.routes[0]!.requestIds, [92]);
  out = apply(out, [{ op: 'deassign', requestId: 91 }], 'edit-2');
  assert.deepEqual(out.decisions['91'], { kind: 'unassigned' });
  assert.equal(out.routes.length, 1);
  const released = apply(out, [{ op: 'release', requestId: 91 }], 'edit-3');
  assert.equal(released.decisions['91'], undefined);
  assert.deepEqual(released.unassigned, out.unassigned);
  assert.equal(released.history.length, 3);
});

test('same-trip insertion position is interpreted after removal', () => {
  const out = apply(layout(), [{ op: 'assign', requestId: 91, vehicleId: 7, tripId: 'trip-1', position: 1 }]);
  assert.deepEqual(out.routes[0]!.requestIds, [92, 91]);
});

test('all-unassigned outcome removes empty trips but retains available fleet', () => {
  const out = apply(layout(), [{ op: 'deassign', requestId: 91 }, { op: 'deassign', requestId: 92 }]);
  assert.deepEqual(out.routes, []);
  assert.deepEqual(out.vehicleIds, [7, 42, 99]);
  assert.deepEqual([...out.unassigned].sort(), [91, 92, 93]);
});

test('invalid second command does not partially mutate input', () => {
  const input = layout(), before = structuredClone(input);
  assert.throws(() => apply(input, [{ op: 'deassign', requestId: 91 },
    { op: 'assign', requestId: 92, vehicleId: 99, tripId: 'new', position: 0 }]), /excluded/);
  assert.deepEqual(input, before);
});

test('locked source and target reject movement, release preserves route lock', () => {
  const input = layout(); input.lockedVehicleIds = [7];
  assert.throws(() => apply(input, [{ op: 'deassign', requestId: 91 }]), /unlock source/);
  assert.throws(() => apply(input, [{ op: 'assign', requestId: 93, vehicleId: 7, tripId: 'trip-1', position: 0 }]), /unlock target/);
  assert.deepEqual(apply(input, [{ op: 'release', requestId: 91 }]).routes, input.routes);
});

test('unknown request, vehicle and out-of-bounds position fail', () => {
  assert.throws(() => apply(layout(), [{ op: 'deassign', requestId: 123 }]), /unknown request/);
  assert.throws(() => apply(layout(), [{ op: 'assign', requestId: 93, vehicleId: 123, tripId: 'new', position: 0 }]), /unknown target/);
  assert.throws(() => apply(layout(), [{ op: 'assign', requestId: 93, vehicleId: 42, tripId: 'new', position: 1 }]), /position/);
});

test('dataset mismatch and reapplying operation require publisher conflict handling', () => {
  assert.throws(() => applyManualBatch(layout(), { datasetSha256: 'b'.repeat(64), operationId: 'x', commands: [{ op: 'deassign', requestId: 91 }] }, actor), /dataset changed/);
  const out = apply(layout(), [{ op: 'deassign', requestId: 91 }]);
  assert.throws(() => apply(out, [{ op: 'deassign', requestId: 91 }]), /already applied/);
});

test('duplicate or missing identity coverage is rejected, never inferred from labels', () => {
  const input = layout(); input.unassigned.push(91);
  assert.throws(() => assertManualLayout(input), /duplicate/);
  const missing = layout(); missing.unassigned = [];
  assert.throws(() => assertManualLayout(missing), /incomplete/);
});

test('batch keeps stable identities through many edits and preserves initial origin', () => {
  const out = apply(layout(), [
    { op: 'assign', requestId: 91, vehicleId: 42, tripId: 'new', position: 0 },
    { op: 'assign', requestId: 92, vehicleId: 42, tripId: 'new', position: 0 },
    { op: 'deassign', requestId: 91 },
    { op: 'assign', requestId: 93, vehicleId: 7, tripId: 'trip-1', position: 0 },
  ]);
  assert.deepEqual(out.routes.map(route => route.requestIds), [[93], [92]]);
  assert.deepEqual(out.unassigned, [91]);
  assert.equal(out.origins['92'], 'import');
  assert.deepEqual(out.history.map(event => event.index), [0, 1, 2, 3]);
});
