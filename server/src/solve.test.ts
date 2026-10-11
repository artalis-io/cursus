import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyOverrides, applyVehicleOverrides, applySequences } from './solve.js';
import type { SurgeRequest } from './types.js';
import type { Scenario } from './store.js';

/* Minimal request: two orders (O1->task 10->req 100, O2->task 11->req 101),
 * three vehicles (1,2,3). Only the override-relevant fields are populated. */
function mkRequest(): SurgeRequest {
  return {
    config: {}, dimension_count: 2, demand_sign_convention: 1,
    locations: [], depots: [],
    vehicles: [
      { id: 1, ref: 'V1', capacity: [1, 1], start_depot_id: 0, end_depot_id: 0 },
      { id: 2, ref: 'V2', capacity: [1, 1], start_depot_id: 0, end_depot_id: 0 },
      { id: 3, ref: 'V3', capacity: [1, 1], start_depot_id: 0, end_depot_id: 0 },
    ],
    tasks: [
      { id: 10, type: 'delivery', location_id: 1, tw_early: 0, tw_late: 0, service_seconds: 0, demand: [1, 1], ref: 'O1' },
      { id: 11, type: 'delivery', location_id: 2, tw_early: 0, tw_late: 0, service_seconds: 0, demand: [1, 1], ref: 'O2' },
    ],
    requests: [
      { id: 100, delivery_task_id: 10 },
      { id: 101, delivery_task_id: 11 },
    ],
    travel: { location_count: 0, distances: [], durations: [] },
  };
}

function mkScenario(over: Partial<Scenario> = {}): Scenario {
  return {
    id: 'scn', day: 'day1', kind: 'copy', parentId: 'day1-base', revision: 1,
    label: 'edited', removedVehicleIds: [], pins: [], forbids: [], vehicleOverrides: [], sequences: [], createdAt: '',
    ...over,
  };
}

test('applyOverrides: pin sets allowed_vehicles to the single pinned vehicle', () => {
  const req = mkRequest();
  applyOverrides(req, mkScenario({ pins: [{ orderNo: 'O1', vehicleId: 2 }] }));
  assert.deepEqual(req.requests[0]!.allowed_vehicles, [2]);
  assert.equal(req.requests[1]!.allowed_vehicles, undefined);
});

test('applyOverrides: forbid appends to forbidden_vehicles', () => {
  const req = mkRequest();
  applyOverrides(req, mkScenario({ forbids: [{ orderNo: 'O2', vehicleId: 1 }, { orderNo: 'O2', vehicleId: 3 }] }));
  assert.deepEqual(req.requests[1]!.forbidden_vehicles, [1, 3]);
  assert.equal(req.requests[1]!.allowed_vehicles, undefined);
});

test('applyOverrides: pin on an order supersedes a forbid on the same order', () => {
  const req = mkRequest();
  applyOverrides(req, mkScenario({
    pins: [{ orderNo: 'O1', vehicleId: 2 }],
    forbids: [{ orderNo: 'O1', vehicleId: 3 }],
  }));
  assert.deepEqual(req.requests[0]!.allowed_vehicles, [2]);
  assert.equal(req.requests[0]!.forbidden_vehicles, undefined);
});

test('applyOverrides: overrides naming an unavailable vehicle are skipped', () => {
  const req = mkRequest();
  const avail = new Set([1, 3]); // vehicle 2 removed from the fleet
  applyOverrides(req, mkScenario({
    pins: [{ orderNo: 'O1', vehicleId: 2 }],
    forbids: [{ orderNo: 'O2', vehicleId: 2 }],
  }), avail);
  assert.equal(req.requests[0]!.allowed_vehicles, undefined);
  assert.equal(req.requests[1]!.forbidden_vehicles, undefined);
});

test('applyVehicleOverrides: applies capacity/shift/max with unit conversion', () => {
  const req = mkRequest();
  applyVehicleOverrides(req, mkScenario({ vehicleOverrides: [
    { vehicleId: 1, capacityKg: 5000, capacityPallets: 20, shiftEarlySec: 21600, shiftLateSec: 64800, maxTrips: 2, maxDistanceKm: 300, maxDurationMin: 600 },
  ] }));
  const v = req.vehicles.find((x) => x.id === 1)!;
  assert.deepEqual(v.capacity, [5000, 20]);
  assert.equal(v.shift_early, 21600);
  assert.equal(v.shift_late, 64800);
  assert.equal(v.max_trips, 2);
  assert.equal(v.max_distance, 300_000); // km -> m
  assert.equal(v.max_duration, 36_000);  // min -> s
  // unset vehicle untouched
  assert.equal(req.vehicles.find((x) => x.id === 2)!.max_trips, undefined);
});

test('applyVehicleOverrides: partial patch leaves other fields at defaults', () => {
  const req = mkRequest();
  applyVehicleOverrides(req, mkScenario({ vehicleOverrides: [{ vehicleId: 2, capacityPallets: 10 }] }));
  const v = req.vehicles.find((x) => x.id === 2)!;
  assert.deepEqual(v.capacity, [1, 10]); // kg kept, pallets overridden
  assert.equal(v.shift_early, undefined);
});

test('applySequences: locks orders to the vehicle and chains precedence in order', () => {
  const req = mkRequest();
  // dispatcher wants O2 before O1 on vehicle 1
  applySequences(req, mkScenario({ sequences: [{ vehicleId: 1, orderNos: ['O2', 'O1'] }] }));
  const byId = new Map(req.requests.map((r) => [r.id, r]));
  assert.deepEqual(byId.get(100)!.allowed_vehicles, [1]); // O1 locked to v1
  assert.deepEqual(byId.get(101)!.allowed_vehicles, [1]); // O2 locked to v1
  // precedence: req(O2)=101 before req(O1)=100
  assert.deepEqual(req.precedences, [{ before: 101, after: 100 }]);
});

test('applySequences: skips a sequence on an unavailable vehicle', () => {
  const req = mkRequest();
  applySequences(req, mkScenario({ sequences: [{ vehicleId: 1, orderNos: ['O1', 'O2'] }] }), new Set([2, 3]));
  assert.equal(req.precedences, undefined);
  assert.equal(req.requests.find((r) => r.id === 100)!.allowed_vehicles, undefined);
});

test('applySequences: a single-order sequence adds no precedence', () => {
  const req = mkRequest();
  applySequences(req, mkScenario({ sequences: [{ vehicleId: 1, orderNos: ['O1'] }] }));
  assert.equal(req.precedences, undefined);
});

test('applySequences: a locked sequence forbids the vehicle for all other orders (true freeze)', () => {
  const req = mkRequest();
  applySequences(req, mkScenario({ sequences: [{ vehicleId: 1, orderNos: ['O1'], locked: true }] }));
  const byId = new Map(req.requests.map((r) => [r.id, r]));
  assert.deepEqual(byId.get(100)!.allowed_vehicles, [1]);   // O1 kept on v1
  assert.deepEqual(byId.get(101)!.forbidden_vehicles, [1]); // O2 cannot be added to v1
});
