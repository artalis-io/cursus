import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mapSolutionToPlan, classifyUnassigned, type MapInputs, type FleetLimits } from './mapper.js';
import type {
  SurgeRequest, SurgeSolution, SurgeTask, SurgeRequestVehicle,
} from '../types.js';
import type { LoadedDay, OrderInfo, VehicleInfo } from '../data/dataset.js';

/* ---- Synthetic fixture builders (no real dataset read) ----
 *
 * 4 locations: 0 = depot, 1/2/3 = customer stops. We hand-build a travel
 * matrix with KNOWN, distinct leg durations/distances so per-stop travelToSec
 * and per-trip distance assertions are exact.
 */

const N = 4;

/* Row-major N*N matrices. dur[a*N+b] = seconds, dist[a*N+b] = meters.
 * Asymmetric values chosen so a wrong index (e.g. b*N+a) would differ. */
function buildMatrices(): { durations: number[]; distances: number[] } {
  const durations = new Array<number>(N * N).fill(0);
  const distances = new Array<number>(N * N).fill(0);
  // Fill leg (a->b) = base so each ordered pair is unique.
  for (let a = 0; a < N; a++) {
    for (let b = 0; b < N; b++) {
      if (a === b) continue;
      durations[a * N + b] = 100 * a + 10 * b + 1; // e.g. 0->1 = 11, 1->2 = 112
      distances[a * N + b] = 1000 * (100 * a + 10 * b + 1); // meters, scaled
    }
  }
  return { durations, distances };
}

function mkTask(id: number, location_id: number, ref: string, over: Partial<SurgeTask> = {}): SurgeTask {
  return {
    id,
    type: 'delivery',
    location_id,
    tw_early: 0,
    tw_late: 86_400,
    service_seconds: 600, // 10 min
    demand: [100, 1], // [kg, pallets]
    ref,
    ...over,
  };
}

function mkVehicle(id: number, ref: string, capKg: number, capPal: number): SurgeRequestVehicle {
  return { id, ref, capacity: [capKg, capPal], start_depot_id: 0, end_depot_id: 0 };
}

interface BuildOpts {
  taskOver?: Record<number, Partial<SurgeTask>>; // keyed by task id
  vehCapKg?: number;
  vehCapPal?: number;
}

/* Returns a fully-wired request + default scope. Non-sequential vehicle ids
 * (17 and 42) so mapping BY ID vs array index is distinguishable. */
function buildRequest(opts: BuildOpts = {}): SurgeRequest {
  const { durations, distances } = buildMatrices();
  const over = opts.taskOver ?? {};
  const tasks: SurgeTask[] = [
    mkTask(1, 1, 'ORD-1', over[1]),
    mkTask(2, 2, 'ORD-2', over[2]),
    mkTask(3, 3, 'ORD-3', over[3]),
  ];
  return {
    config: { seed: 7 },
    dimension_count: 2,
    demand_sign_convention: 1,
    locations: [
      { x: 10.0, y: 50.0 }, // depot
      { x: 10.1, y: 50.1 },
      { x: 10.2, y: 50.2 },
      { x: 10.3, y: 50.3 },
    ],
    depots: [{ location_id: 0 }],
    vehicles: [
      mkVehicle(17, 'RIC-17', opts.vehCapKg ?? 10_000, opts.vehCapPal ?? 100),
      mkVehicle(42, 'RIC-42', opts.vehCapKg ?? 10_000, opts.vehCapPal ?? 100),
    ],
    tasks,
    requests: [
      { id: 101, delivery_task_id: 1 },
      { id: 102, delivery_task_id: 2 },
      { id: 103, delivery_task_id: 3 },
    ],
    travel: { location_count: N, distances, durations },
  };
}

function mkInputs(request: SurgeRequest, solution: SurgeSolution): MapInputs {
  const scope = new Set<number>(request.tasks.map((t) => t.id));
  const day = {
    def: {
      id: 'day1',
      date: '5/6/26',
      isoDate: '2026-05-06',
      label: 'Test day',
      requestFile: 'x',
      solutionFile: 'y',
    },
    request,
    solution,
    scopeTaskIds: scope,
    depot: { name: 'TestDepot', lon: 10.0, lat: 50.0 },
  } as unknown as LoadedDay;

  return {
    day,
    request,
    solution,
    enrichment: new Map<string, OrderInfo>(),
    vehicleInfo: new Map<string, VehicleInfo>(),
    scenarioId: 'scn_test',
    scenarioRevision: 3,
    planId: 'plan_test',
    source: 'live',
    createdAt: '2026-05-06T08:00:00.000Z',
  };
}

const okStats = {
  total_distance: 123_000,
  vehicles_used: 1,
  trips: 2,
  elapsed_seconds: 1.5,
};

/* ------------------------------------------------------------------ */

test('maps a multi-trip route: by-id vehicle lookup, trip grouping, legs, load, stats', () => {
  const request = buildRequest();
  // Vehicle 42 runs two trips: trip 0 visits tasks 1 then 2; trip 1 visits task 3.
  const solution: SurgeSolution = {
    status: 'OK',
    stats: okStats,
    routes: [
      {
        vehicle_id: 42,
        distance: 50_000,
        duration: 3_000,
        trip_count: 2,
        stops: [
          { request_id: 101, task_id: 1, type: 'delivery', trip_index: 0, arrival: 500, service_start: 520, departure: 1120 },
          { request_id: 102, task_id: 2, type: 'delivery', trip_index: 0, arrival: 1300, service_start: 1300, departure: 1900 },
          { request_id: 103, task_id: 3, type: 'delivery', trip_index: 1, arrival: 4000, service_start: 4010, departure: 4610 },
        ],
      },
    ],
    unassigned: [],
  };

  const plan = mapSolutionToPlan(mkInputs(request, solution));

  // --- Vehicle looked up BY ID, not array index. route.vehicle_id = 42,
  // which is request.vehicles[1] (index 1), ref RIC-42. If the code used the
  // array index 42 it would be undefined -> ref 'veh-42' and cap 0.
  assert.equal(plan.vehicles.length, 1);
  const v = plan.vehicles[0]!;
  assert.equal(v.id, 42);
  assert.equal(v.ref, 'RIC-42');
  assert.equal(v.capacityKg, 10_000);
  assert.equal(v.capacityPallets, 100);

  // --- Trips grouped by trip_index.
  assert.equal(v.trips.length, 2);
  assert.equal(v.trips[0]!.index, 0);
  assert.equal(v.trips[1]!.index, 1);
  assert.equal(v.trips[0]!.stops.length, 2);
  assert.equal(v.trips[1]!.stops.length, 1);

  // --- Per-stop travelToSec == matrix leg from previous location.
  // Trip 0: prev starts at depot (loc 0). First stop task1 at loc1:
  // dur[0*4+1] = 100*0 + 10*1 + 1 = 11.
  const t0 = v.trips[0]!;
  assert.equal(t0.stops[0]!.travelToSec, 11); // 0->1
  // Second stop task2 at loc2, prev loc1: dur[1*4+2] = 100*1+10*2+1 = 121.
  assert.equal(t0.stops[1]!.travelToSec, 121); // 1->2
  // Trip 1 resets prev to depot: task3 at loc3, dur[0*4+3] = 31.
  const t1 = v.trips[1]!;
  assert.equal(t1.stops[0]!.travelToSec, 31); // 0->3

  // --- waitSec = service_start - arrival (floored at 0).
  assert.equal(t0.stops[0]!.waitSec, 20);  // 520 - 500
  assert.equal(t0.stops[1]!.waitSec, 0);   // 1300 - 1300
  assert.equal(t1.stops[0]!.waitSec, 10);  // 4010 - 4000

  // --- loadKg / loadPallets summed from task demand per trip.
  assert.equal(t0.loadKg, 200);      // task1 + task2 = 100 + 100
  assert.equal(t0.loadPallets, 2);
  assert.equal(t1.loadKg, 100);      // task3
  assert.equal(t1.loadPallets, 1);

  // --- Stats.
  assert.equal(plan.stats.servedOrders, 3);
  assert.equal(plan.stats.totalOrders, 3);   // scopeTaskIds.size
  assert.equal(plan.stats.deliveryStops, 3); // total stops across trips
  assert.equal(plan.stats.trips, 2);         // from solution.stats.trips
  assert.equal(plan.stats.vehiclesUsed, 1);

  // --- scenario/plan passthrough + valid.
  assert.equal(plan.scenarioRevision, 3);
  assert.equal(plan.day, '2026-05-06');
  assert.equal(plan.provenance.validation.valid, true);
  assert.equal(plan.provenance.validation.violations.length, 0);
});

test('unassigned requests mapped via requests[].delivery_task_id', () => {
  const request = buildRequest();
  // Serve only task 1 (request 101). Requests 102 and 103 unassigned.
  const solution: SurgeSolution = {
    status: 'OK',
    stats: { ...okStats, vehicles_used: 1, trips: 1 },
    routes: [
      {
        vehicle_id: 17,
        distance: 10_000,
        duration: 1_000,
        trip_count: 1,
        stops: [
          { request_id: 101, task_id: 1, type: 'delivery', trip_index: 0, arrival: 100, service_start: 100, departure: 700 },
        ],
      },
    ],
    unassigned: [102, 103],
  };

  const plan = mapSolutionToPlan(mkInputs(request, solution));

  assert.equal(plan.unassigned.length, 2);
  // request 102 -> delivery_task_id 2 -> task.ref 'ORD-2'
  const orderNos = plan.unassigned.map((u) => u.orderNo).sort();
  assert.deepEqual(orderNos, ['ORD-2', 'ORD-3']);
  // coords come from the resolved task's location.
  const u2 = plan.unassigned.find((u) => u.orderNo === 'ORD-2')!;
  assert.equal(u2.lon, 10.2);
  assert.equal(u2.lat, 50.2);
  assert.equal(u2.reason, null);

  assert.equal(plan.stats.servedOrders, 1);
});

test('arrival past tw_late produces a HARD_TW violation and valid=false', () => {
  // task 1 has a tight window ending at 400; stop arrives at 500 -> late.
  const request = buildRequest({ taskOver: { 1: { tw_late: 400 } } });
  const solution: SurgeSolution = {
    status: 'OK',
    stats: { ...okStats, vehicles_used: 1, trips: 1 },
    routes: [
      {
        vehicle_id: 17,
        distance: 10_000,
        duration: 1_000,
        trip_count: 1,
        stops: [
          { request_id: 101, task_id: 1, type: 'delivery', trip_index: 0, arrival: 500, service_start: 500, departure: 1100 },
        ],
      },
    ],
    unassigned: [],
  };

  const plan = mapSolutionToPlan(mkInputs(request, solution));

  const violations = plan.provenance.validation.violations as Array<{ type: string }>;
  const tw = violations.find((x) => x.type === 'HARD_TW');
  assert.ok(tw, 'expected a HARD_TW violation');
  assert.equal(plan.provenance.validation.valid, false);
  // lateBySec surfaced on the stop too.
  assert.equal(plan.vehicles[0]!.trips[0]!.stops[0]!.lateBySec, 100); // 500 - 400
});

test('trip load over capacity produces a CAPACITY violation', () => {
  // Capacity 150kg; trip carries task1 (100) + task2 (100) = 200 > 150.
  const request = buildRequest({ vehCapKg: 150, vehCapPal: 100 });
  const solution: SurgeSolution = {
    status: 'OK',
    stats: { ...okStats, vehicles_used: 1, trips: 1 },
    routes: [
      {
        vehicle_id: 17,
        distance: 10_000,
        duration: 1_000,
        trip_count: 1,
        stops: [
          { request_id: 101, task_id: 1, type: 'delivery', trip_index: 0, arrival: 100, service_start: 100, departure: 700 },
          { request_id: 102, task_id: 2, type: 'delivery', trip_index: 0, arrival: 800, service_start: 800, departure: 1400 },
        ],
      },
    ],
    unassigned: [],
  };

  const plan = mapSolutionToPlan(mkInputs(request, solution));

  const violations = plan.provenance.validation.violations as Array<{ type: string; dimension?: string; actual?: number; limit?: number }>;
  const cap = violations.find((x) => x.type === 'CAPACITY' && x.dimension === 'kg');
  assert.ok(cap, 'expected a CAPACITY (kg) violation');
  assert.equal(cap!.actual, 200);
  assert.equal(cap!.limit, 150);
  assert.equal(plan.provenance.validation.valid, false);
});

test('classifyUnassigned: infers the blocking reason, pin/lock first', () => {
  const bigFleet: FleetLimits = { maxKg: 24000, maxPallets: 33, anyTailLift: false, minTonnage: 40 };
  // pin/sequence lock that failed wins over everything
  assert.equal(classifyUnassigned({ allowed_vehicles: [2] }, { demand: [999999, 999] }, { requiresTailLift: true }, bigFleet), 'PINNED_INFEASIBLE');
  // needs a tail lift, none in the fleet
  assert.equal(classifyUnassigned(undefined, { demand: [1, 1] }, { requiresTailLift: true }, bigFleet), 'NEEDS_TAIL_LIFT');
  // load exceeds every vehicle's capacity
  assert.equal(classifyUnassigned(undefined, { demand: [30000, 1] }, null, bigFleet), 'OVER_CAPACITY');
  assert.equal(classifyUnassigned(undefined, { demand: [1, 40] }, null, bigFleet), 'OVER_CAPACITY');
  // access tonnage: smallest vehicle (40t) exceeds the site's 7.5t limit
  assert.equal(classifyUnassigned(undefined, { demand: [1, 1] }, { maxTonnage: 7.5 }, bigFleet), 'OVERSIZE');
  // otherwise generic (time window / routing)
  assert.equal(classifyUnassigned(undefined, { demand: [1, 1] }, null, bigFleet), 'CONSTRAINED');
  assert.equal(classifyUnassigned({ allowed_vehicles: [] }, { demand: [1, 1] }, null, bigFleet), 'CONSTRAINED'); // empty lock != pinned
});
