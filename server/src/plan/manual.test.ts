import test from 'node:test';
import assert from 'node:assert/strict';
import { applyManualBatch, assertManualLayout, ManualCommandError, type ManualLayout, type ManualCommand, type ManualBatch } from './manual.js';

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

test('layout validation rejects every invalid inventory and ownership boundary', () => {
  const cases: [string, (input: ManualLayout) => void][] = [
    ['checksum', x => { x.datasetSha256 = 'not-a-checksum'; }],
    ['request inventory', x => { x.requestIds.push(91); }],
    ['request inventory', x => { x.requestIds.push(-1); }],
    ['vehicle inventory', x => { x.vehicleIds.push(7); }],
    ['vehicle inventory', x => { x.vehicleIds.push(1.5); }],
    ['vehicle restriction', x => { x.excludedVehicleIds.push(123); }],
    ['vehicle restriction', x => { x.lockedVehicleIds.push(123); }],
    ['unknown vehicle', x => { x.routes[0]!.vehicleId = 123; }],
    ['invalid trip', x => { x.routes[0]!.tripId = '../invalid'; }],
    ['duplicate trip', x => { x.routes.push(structuredClone(x.routes[0]!)); }],
    ['duplicate assignment', x => { x.routes[0]!.requestIds.push(91); }],
    ['unknown or duplicate assignment', x => { x.routes[0]!.requestIds.push(123); }],
    ['unassigned request', x => { x.unassigned.push(123); }],
    ['unassigned request', x => { x.unassigned.push(93); }],
    ['decision identity', x => { x.decisions['123'] = { kind: 'unassigned' }; }],
    ['decision identity', x => { x.decisions['091'] = { kind: 'unassigned' }; }],
    ['retained decision', x => { x.decisions['91'] = { kind: 'vehicle', vehicleId: 123 }; }],
    ['retained decision', x => { x.decisions['91'] = { kind: 'invalid' } as never; }],
  ];
  for (const [message, mutate] of cases) {
    const input = layout(); mutate(input);
    assert.throws(() => assertManualLayout(input), error => error instanceof ManualCommandError && error.message.includes(message), message);
  }
  const valid = layout(); valid.decisions = { '91': { kind: 'vehicle', vehicleId: 7 }, '93': { kind: 'unassigned' } };
  assert.doesNotThrow(() => assertManualLayout(valid));
});

test('invalid actor, timestamp, operation and batch boundaries fail without mutation', () => {
  const input = layout(), before = structuredClone(input);
  const batch: ManualBatch = { operationId: 'valid', datasetSha256: input.datasetSha256, commands: [{ op: 'release', requestId: 91 }] };
  for (const operationId of ['', 'x'.repeat(129), '../escape', 12]) {
    assert.throws(() => applyManualBatch(input, { ...batch, operationId } as ManualBatch, actor), /operation identity/);
  }
  for (const actorId of ['', 'x'.repeat(129), 12]) {
    assert.throws(() => applyManualBatch(input, batch, { ...actor, actorId } as typeof actor), /actor required/);
  }
  for (const at of ['', 'invalidZ', '2026-10-26T12:00:00', 12]) {
    assert.throws(() => applyManualBatch(input, batch, { ...actor, at } as typeof actor), /timestamp/);
  }
  for (const commands of [null, [], Array.from({ length: 1001 }, () => batch.commands[0]!)]) {
    assert.throws(() => applyManualBatch(input, { ...batch, commands } as ManualBatch, actor), /batch size/);
  }
  assert.deepEqual(input, before);
  assert.doesNotThrow(() => applyManualBatch(input, { ...batch, operationId: 'x'.repeat(128) },
    { actorId: 'x'.repeat(128), at: '2026-10-26T16:00:00+04:00' }));
});

test('command validation rejects unsafe IDs, operations, trip keys and positions', () => {
  for (const requestId of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => apply(layout(), [{ op: 'release', requestId }]), /unknown request/);
  }
  assert.throws(() => apply(layout(), [{ op: 'unknown', requestId: 91 } as never]), /unknown manual command/);
  for (const tripId of ['', '../path', 'x'.repeat(81), 12]) {
    assert.throws(() => apply(layout(), [{ op: 'assign', requestId: 93, vehicleId: 42, tripId, position: 0 } as ManualCommand]), /target trip/);
  }
  for (const position of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => apply(layout(), [{ op: 'assign', requestId: 93, vehicleId: 7, tripId: 'trip-1', position }]), /insertion position/);
  }
  const out = apply(layout(), [{ op: 'assign', requestId: 93, vehicleId: 42, tripId: 'x'.repeat(80), position: 0 }]);
  assert.equal(out.routes[1]!.tripId.length, 80);
});

test('1000-command boundary preserves event order and does not collapse audit history', () => {
  const out = apply(layout(), Array.from({ length: 1000 }, () => ({ op: 'release' as const, requestId: 91 })));
  assert.equal(out.history.length, 1000);
  assert.deepEqual(out.history.map(e => e.index), Array.from({ length: 1000 }, (_, i) => i));
  assert.deepEqual(out.routes, layout().routes);
});

test('numeric zero IDs, repeated deassignment and multiple trips remain unambiguous', () => {
  const input = layout(); input.vehicleIds.push(0); input.requestIds.push(0); input.unassigned.push(0);
  const out = apply(input, [
    { op: 'assign', requestId: 0, vehicleId: 0, tripId: 'first', position: 0 },
    { op: 'assign', requestId: 91, vehicleId: 0, tripId: 'second', position: 0 },
    { op: 'deassign', requestId: 93 }, { op: 'deassign', requestId: 93 },
  ]);
  assert.deepEqual(out.routes.filter(r => r.vehicleId === 0).map(r => r.requestIds), [[0], [91]]);
  assert.equal(out.unassigned.filter(id => id === 93).length, 1);
  assert.deepEqual(out.decisions['0'], { kind: 'vehicle', vehicleId: 0 });
});

test('output and event history do not alias parent or later command objects', () => {
  const input = layout();
  const first = apply(input, [{ op: 'assign', requestId: 91, vehicleId: 42, tripId: 'new', position: 0 }]);
  const firstSnapshot = structuredClone(first);
  const second = apply(first, [{ op: 'deassign', requestId: 91 }], 'second');
  second.history[0]!.to!.vehicleId = 123;
  second.origins['91'] = 'manual';
  second.routes[0]!.requestIds.push(123);
  assert.deepEqual(first, firstSnapshot);
  assert.deepEqual(input, layout());
});

test('two pure branches remain independent; publication concurrency is not simulated', () => {
  const parent = layout();
  const a = apply(parent, [{ op: 'deassign', requestId: 91 }], 'a');
  const b = apply(parent, [{ op: 'assign', requestId: 91, vehicleId: 42, tripId: 'new', position: 0 }], 'b');
  assert.deepEqual(a.decisions['91'], { kind: 'unassigned' });
  assert.deepEqual(b.decisions['91'], { kind: 'vehicle', vehicleId: 42 });
  assert.deepEqual(parent, layout());
});

test('seeded model-based history preserves exact request locations and retained decisions', () => {
  let seed = 1701;
  const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  let state = layout();
  const expected = new Map<number, number | null>([[91, 7], [92, 7], [93, null]]);
  const decisions = new Map<number, number | null>();
  const original = structuredClone(state.origins);
  const touched = new Set<number>();
  for (let step = 0; step < 500; step++) {
    const id = [91, 92, 93][random(3)]!, op = random(3);
    let command: ManualCommand;
    if (op === 0) {
      const vehicleId = [7, 42][random(2)]!;
      command = { op: 'assign', requestId: id, vehicleId, tripId: 'model', position: 0 };
      expected.set(id, vehicleId); decisions.set(id, vehicleId);
    } else if (op === 1) {
      command = { op: 'deassign', requestId: id };
      expected.set(id, null); decisions.set(id, null);
    } else {
      command = { op: 'release', requestId: id }; decisions.delete(id);
    }
    const previous = structuredClone(state);
    touched.add(id);
    const result = apply(state, [command], `model-${step}`);
    assert.deepEqual(state, previous);
    state = result;
    // Independent reference model: request-to-vehicle map, not command-core helpers.
    const observed = new Map<number, number | null>();
    for (const route of state.routes) for (const request of route.requestIds) {
      assert.equal(observed.has(request), false); observed.set(request, route.vehicleId);
    }
    for (const request of state.unassigned) { assert.equal(observed.has(request), false); observed.set(request, null); }
    assert.deepEqual([...observed].sort(), [...expected].sort());
    for (const request of state.requestIds) {
      const retained = state.decisions[String(request)];
      assert.deepEqual(retained, !decisions.has(request) ? undefined : decisions.get(request) === null
        ? { kind: 'unassigned' } : { kind: 'vehicle', vehicleId: decisions.get(request) });
      assert.equal(state.origins[String(request)], original[String(request)] ?? (touched.has(request) ? 'historical' : undefined));
    }
    assert.equal(state.history.length, step + 1);
    assert.deepEqual(state.history.at(-1)?.actorId, actor.actorId);
  }
});
