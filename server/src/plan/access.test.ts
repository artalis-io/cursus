import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyAccessLimits, grossTonnage, hasTailLift, withHardAccessValidation } from './access.js';
import { applyOverrides, applySequences } from '../solve.js';
import { nativeSolveRequest } from '../state/solver-ids.js';
import { toSurgeFleet } from '../data/fleet.js';
import type { OrderInfo, VehicleInfo } from '../data/dataset.js';
import type { Scenario } from '../store.js';
import type { Plan, SurgeRequest, SurgeSolution } from '../types.js';

function fixture(): SurgeRequest {
  return { config: { max_time_seconds: 0.1, seed: 42, hard_capacity: true, hard_time_windows: true },
    dimension_count: 2, demand_sign_convention: 1,
    locations: [{ x: 19, y: 47 }, { x: 19.01, y: 47 }],
    depots: [{ location_id: 0, tw_early: 0, tw_late: 86400 }],
    vehicles: [{ id: 7, ref: 'HEAVY', gross_weight_kg: 24000, capacity: [20000, 30], start_depot_id: 0, end_depot_id: 0 },
      { id: 42, ref: 'SMALL', gross_weight_kg: 3500, capacity: [1000, 10], start_depot_id: 0, end_depot_id: 0 }],
    tasks: [{ id: 12, ref: 'ORDER', type: 'delivery', location_id: 1, demand: [100, 1], tw_early: 0, tw_late: 86400, service_seconds: 60 }],
    requests: [{ id: 91, delivery_task_id: 12 }],
    travel: { location_count: 2, distances: [0, 1000, 1000, 0], durations: [0, 60, 60, 0] } };
}
const orders = (maxTonnage: number | null) => new Map([['ORDER', { maxTonnage } as OrderInfo]]);
const scenario = (over: Partial<Scenario>): Scenario => ({ id: 'test', day: 'day2', kind: 'copy', parentId: 'day2-base',
  revision: 1, label: 'test', createdAt: '', removedVehicleIds: [], pins: [], forbids: [], sequences: [], vehicleOverrides: [], ...over });

test('historical access advisories become hard errors on read without mutating persisted data', () => {
  const stored = { provenance: { validation: { valid: true, violations: [{ type: 'VEHICLE_SIZE', soft: true, actual: 24, limit: 7.5 },
    { type: 'TAIL_LIFT', soft: true }] } } } as Plan;
  const original = structuredClone(stored);
  const view = withHardAccessValidation(stored);
  assert.equal(view.provenance.validation.valid, false);
  assert.equal((view.provenance.validation.violations[0] as { soft: boolean }).soft, false);
  assert.equal((view.provenance.validation.violations[1] as { soft: boolean }).soft, false);
  assert.deepEqual(stored, original);
});

test('GVW access excludes oversize vehicles, accepts exact limit, and is idempotent', () => {
  const request = fixture(); request.requests[0]!.forbidden_vehicles = [99];
  applyAccessLimits(request, orders(3.5), new Map());
  applyAccessLimits(request, orders(3.5), new Map());
  assert.deepEqual(request.requests[0]!.forbidden_vehicles, [99, 7]);
  const native = nativeSolveRequest(request).request;
  assert.deepEqual(native.requests[0]!.forbidden_vehicles, [0]);
});

test('unknown GVW fails closed only for restricted destinations; never infer from payload or partial plate', () => {
  const request = fixture(); delete request.vehicles[0]!.gross_weight_kg;
  const info = new Map([['OTHERHEAVY', { tonnage: 1 } as VehicleInfo]]);
  assert.equal(grossTonnage(request.vehicles[0]!, info), null);
  applyAccessLimits(request, orders(3.5), info);
  assert.deepEqual(request.requests[0]!.forbidden_vehicles, [7]);
  const unrestricted = fixture(); applyAccessLimits(unrestricted, orders(null), info);
  assert.equal(unrestricted.requests[0]!.forbidden_vehicles, undefined);
  info.set('HEAVY', { tonnage: 7.5 } as VehicleInfo);
  assert.equal(grossTonnage(request.vehicles[0]!, info), 7.5);
  request.vehicles[0]!.gross_weight_kg = 0;
  assert.equal(grossTonnage(request.vehicles[0]!, info), null);
});

test('hard access survives manual pins, stop reorder and locked routes', () => {
  for (const edit of [scenario({ pins: [{ orderNo: 'ORDER', vehicleId: 7 }] }),
    scenario({ sequences: [{ vehicleId: 7, orderNos: ['ORDER'], locked: true }] })]) {
    const request = fixture(); applyOverrides(request, edit); applySequences(request, edit);
    applyAccessLimits(request, orders(7.5), new Map());
    assert.deepEqual(request.requests[0]!.allowed_vehicles, [7]);
    assert.deepEqual(request.requests[0]!.forbidden_vehicles, [7]);
  }
});

test('no eligible vehicle uses explicit forbids, never an empty unrestricted allowlist', () => {
  const request = fixture(); request.vehicles = request.vehicles.filter(v => v.id !== 42);
  applyAccessLimits(request, orders(7.5), new Map());
  assert.deepEqual(request.requests[0]!.forbidden_vehicles, [7]);
  assert.equal(request.requests[0]!.allowed_vehicles, undefined);
});

test('uploaded fleet retains GVW independently of capacity and records unknown explicitly', () => {
  const fleet = toSurgeFleet([{ id: 'A', gross_weight_kg: 24000, capacity_kg: 10000 }, { id: 'B', capacity_kg: 24000 }]);
  assert.equal(fleet.vehicles[0]!.gross_weight_kg, 24000);
  assert.equal(fleet.vehicles[0]!.capacity[0], 10000);
  assert.equal(fleet.vehicles[1]!.gross_weight_kg, 0);
});

test('tail-lift exclusions are hard, idempotent and independent of GVW restrictions', () => {
  const request = fixture(); request.vehicles[0]!.has_tail_lift = false; request.vehicles[1]!.has_tail_lift = true;
  const required = new Map([['ORDER', { requiresTailLift: true, maxTonnage: null } as OrderInfo]]);
  applyAccessLimits(request, required, new Map()); applyAccessLimits(request, required, new Map());
  assert.deepEqual(request.requests[0]!.forbidden_vehicles, [7]);
  applyAccessLimits(request, new Map([['ORDER', { requiresTailLift: true, maxTonnage: 3.5 } as OrderInfo]]), new Map());
  assert.deepEqual(request.requests[0]!.forbidden_vehicles, [7]);
});

test('equipment requires exact legacy identity, explicit false wins, and unknown fails closed', () => {
  const request = fixture(), v = request.vehicles[0]!;
  const info = new Map([['OTHERHEAVY', { hasTailLift: true } as VehicleInfo]]);
  assert.equal(hasTailLift(v, info), false);
  info.set('HEAVY', { hasTailLift: true } as VehicleInfo);
  assert.equal(hasTailLift(v, info), true); v.has_tail_lift = false;
  assert.equal(hasTailLift(v, info), false);
  applyAccessLimits(request, new Map([['ORDER', { requiresTailLift: true } as OrderInfo]]), info);
  assert.deepEqual(request.requests[0]!.forbidden_vehicles, [7, 42]);
  const unrestricted = fixture(); applyAccessLimits(unrestricted, orders(null), new Map());
  assert.equal(unrestricted.requests[0]!.forbidden_vehicles, undefined);
});

test('historical tail-lift-only advisory invalidates read view without rewriting saved plan', () => {
  const plan = { provenance: { validation: { valid: true, violations: [{ type: 'TAIL_LIFT', soft: true }] } } } as Plan;
  assert.equal(withHardAccessValidation(plan).provenance.validation.valid, false);
  assert.equal(plan.provenance.validation.valid, true);
});

test('native Surge enforces tail-lift for ordinary, pinned, locked and no-equipped-fleet cases',
  { skip: !process.env.CURSUS_TEST_SURGE_BIN }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cursus-tail-lift-test-'));
    try {
      for (const mode of ['eligible', 'pinned', 'locked', 'none']) {
        const request = fixture(); request.vehicles[0]!.has_tail_lift = false;
        request.vehicles[1]!.has_tail_lift = mode !== 'none';
        const edit = scenario(mode === 'pinned' ? { pins: [{ orderNo: 'ORDER', vehicleId: 7 }] }
          : mode === 'locked' ? { sequences: [{ vehicleId: 7, orderNos: ['ORDER'], locked: true }] } : {});
        applyOverrides(request, edit); applySequences(request, edit);
        applyAccessLimits(request, new Map([['ORDER', { requiresTailLift: true } as OrderInfo]]), new Map());
        const native = nativeSolveRequest(request, edit.sequences), path = join(dir, mode+'.json');
        await writeFile(path, JSON.stringify(native.request));
        const { stdout } = await promisify(execFile)(process.env.CURSUS_TEST_SURGE_BIN!, [path], { timeout: 30000 });
        const result = native.restore(JSON.parse(stdout) as SurgeSolution);
        assert.ok(!result.routes.some(r => r.vehicle_id === 7 && r.stops.length), mode);
        if (mode === 'eligible') { assert.equal(result.routes[0]?.vehicle_id, 42); assert.deepEqual(result.unassigned, []); }
        else assert.deepEqual(result.unassigned, [91], mode);
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

test('native Surge respects GVW exclusions including conflicting route seeds and all-unassigned results',
  { skip: !process.env.CURSUS_TEST_SURGE_BIN }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cursus-access-test-'));
    try {
      for (const mode of ['eligible', 'pinned', 'locked', 'no-fleet-fit']) {
        const request = fixture();
        const edit = scenario(mode === 'pinned' ? { pins: [{ orderNo: 'ORDER', vehicleId: 7 }] }
          : mode === 'locked' ? { sequences: [{ vehicleId: 7, orderNos: ['ORDER'], locked: true }] } : {});
        if (mode === 'no-fleet-fit') request.vehicles = request.vehicles.filter(v => v.id === 7);
        applyOverrides(request, edit); applySequences(request, edit);
        applyAccessLimits(request, orders(7.5), new Map());
        const native = nativeSolveRequest(request, edit.sequences);
        const path = join(dir, mode + '.json'); await writeFile(path, JSON.stringify(native.request));
        const { stdout } = await promisify(execFile)(process.env.CURSUS_TEST_SURGE_BIN!, [path], { timeout: 30000 });
        const solution = native.restore(JSON.parse(stdout) as SurgeSolution);
        assert.ok(!solution.routes.some(r => r.vehicle_id === 7 && r.stops.length > 0), mode);
        if (mode === 'eligible') { assert.equal(solution.routes[0]?.vehicle_id, 42); assert.deepEqual(solution.unassigned, []); }
        else assert.deepEqual(solution.unassigned, [91], mode);
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
