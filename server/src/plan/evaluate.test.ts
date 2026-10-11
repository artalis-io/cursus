import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateTrip } from './evaluate.js';
import type { SurgeRequest, SurgeTask } from '../types.js';
import type { LoadedDay, OrderInfo, VehicleInfo } from '../data/dataset.js';
import type { Tariff } from '../cost.js';

/* 4 locations: 0 = depot, 1/2/3 = customers. Asymmetric matrix with known legs
 * so arrival/distance are exact: dur[a->b] = 100a + 10b + 1, dist = x1000. */
const N = 4;
function matrices(): { durations: number[]; distances: number[] } {
  const durations = new Array<number>(N * N).fill(0);
  const distances = new Array<number>(N * N).fill(0);
  for (let a = 0; a < N; a++) for (let b = 0; b < N; b++) {
    if (a === b) continue;
    durations[a * N + b] = 100 * a + 10 * b + 1;
    distances[a * N + b] = 1000 * (100 * a + 10 * b + 1);
  }
  return { durations, distances };
}

function mkTask(id: number, location_id: number, ref: string, over: Partial<SurgeTask> = {}): SurgeTask {
  return { id, type: 'delivery', location_id, tw_early: 0, tw_late: 86_400, service_seconds: 600, demand: [100, 1], ref, ...over };
}

function request(taskOver: Record<number, Partial<SurgeTask>> = {}): SurgeRequest {
  const { durations, distances } = matrices();
  return {
    config: {}, dimension_count: 2, demand_sign_convention: 1,
    locations: [{ x: 10, y: 50 }, { x: 10.1, y: 50.1 }, { x: 10.2, y: 50.2 }, { x: 10.3, y: 50.3 }],
    depots: [{ location_id: 0 }],
    vehicles: [{ id: 7, ref: 'RIC-7', capacity: [10_000, 100], start_depot_id: 0, end_depot_id: 0 }],
    tasks: [mkTask(1, 1, 'ORD-1', taskOver[1]), mkTask(2, 2, 'ORD-2', taskOver[2]), mkTask(3, 3, 'ORD-3', taskOver[3])],
    requests: [{ id: 101, delivery_task_id: 1 }, { id: 102, delivery_task_id: 2 }, { id: 103, delivery_task_id: 3 }],
    travel: { location_count: N, distances, durations },
  };
}

const TARIFF: Tariff = {
  currency: 'HUF', source: 'demo', model: 'per_vehicle',
  perKmDefault: 100, fixedPerVehicle: 0, perKmByClass: {}, fixedByClass: {},
  perTripBase: 0, perKm: 0, perDrop: 0, includedDrops: 0, subcontractorMultiplier: 1, ownFleetMultiplier: 1,
};

function day(req: SurgeRequest): LoadedDay {
  return { request: req, enrichment: new Map<string, OrderInfo>() } as unknown as LoadedDay;
}
const noInfo = new Map<string, VehicleInfo>();

function evalOrder(req: SurgeRequest, orderNos: string[], startSec = 0) {
  return evaluateTrip({ day: day(req), request: req, vehicleId: 7, tripIndex: 0, startSec, tripCountOnVehicle: 1, reloadSecAfter: 0, orderNos, vehicleInfo: noInfo, tariff: TARIFF });
}

test('forward-simulates the schedule for a given order from the depot', () => {
  const trip = evalOrder(request(), ['ORD-1', 'ORD-2']);
  // leg 0->1 = 11; arrival 0+11; service 600s; then 1->2 = 121.
  assert.equal(trip.stops[0]!.travelToSec, 11);
  assert.equal(trip.stops[0]!.arrivalSec, 11);
  assert.equal(trip.stops[0]!.departureSec, 611);
  assert.equal(trip.stops[1]!.travelToSec, 121);
  assert.equal(trip.stops[1]!.arrivalSec, 732); // 611 + 121
  // round trip distance 0->1->2->0 = 11+121+201 = 333 (km, x1000 meters)
  assert.equal(trip.distanceKm, 333);
  assert.equal(trip.endSec, 1533);             // 1332 depart + 201 back to depot
  assert.equal(trip.stops[0]!.seq, 1);
  assert.equal(trip.stops[1]!.seq, 2);
  // per_km tariff: 100 Ft/km * 333 km
  assert.equal(trip.costFt, 33_300);
});

test('reordering changes arrivals (and, in general, distance)', () => {
  const fwd = evalOrder(request(), ['ORD-1', 'ORD-2']);
  const rev = evalOrder(request(), ['ORD-2', 'ORD-1']);
  assert.equal(rev.stops[0]!.arrivalSec, 21);  // 0->2 = 21
  assert.equal(rev.stops[1]!.arrivalSec, 832); // 621 + (2->1 = 211)
  assert.notEqual(fwd.stops[1]!.arrivalSec, rev.stops[1]!.arrivalSec);
});

test('respects time windows: wait at tw_early, lateness past tw_late', () => {
  // ORD-2 opens at 1000 and must close by 500 (already late on arrival 732).
  const trip = evalOrder(request({ 2: { tw_early: 1000, tw_late: 500 } }), ['ORD-1', 'ORD-2']);
  const s2 = trip.stops[1]!;
  assert.equal(s2.arrivalSec, 732);
  assert.equal(s2.serviceStartSec, 1000);      // waits for the window to open
  assert.equal(s2.waitSec, 268);               // 1000 - 732
  assert.equal(s2.lateBySec, 232);             // 732 - 500
  assert.equal(s2.departureSec, 1600);         // 1000 + 600 service
});
