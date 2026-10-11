import { test } from 'node:test';
import assert from 'node:assert/strict';

import { comparePlans } from './compare.js';
import type { Plan, PlanStop, PlanTrip, PlanVehicle, PlanStats } from '../types.js';

/* ---- Minimal, type-correct Plan builders (synthetic) ---- */

function mkStop(orderNo: string, over: Partial<PlanStop> = {}): PlanStop {
  return {
    orderId: null,
    orderNo,
    customer: `Cust-${orderNo}`,
    city: `City-${orderNo}`,
    lon: 10,
    lat: 50,
    seq: 1,
    type: 'delivery',
    arrivalSec: 0,
    serviceStartSec: 0,
    departureSec: 0,
    twStartSec: 0,
    twEndSec: 86_400,
    pallets: 1,
    weightKg: 100,
    serviceMin: 10,
    waitSec: 0,
    travelToSec: 0,
    lateBySec: 0,
    requiresTailLift: false,
    maxTonnage: null,
    ...over,
  };
}

function mkTrip(stops: PlanStop[]): PlanTrip {
  return {
    index: 0,
    startSec: 0,
    endSec: 0,
    distanceKm: 0,
    reloadSecAfter: 0,
    loadKg: 0,
    loadPallets: 0,
    costFt: null,
    stops,
    geometry: null,
  };
}

function mkVehicle(ref: string, stops: PlanStop[]): PlanVehicle {
  return {
    id: 0,
    ref,
    vehicleClass: null,
    isSubcontractor: false,
    tonnage: null,
    hasTailLift: false,
    color: '#000000',
    capacityKg: 10_000,
    capacityPallets: 100,
    tripCount: 1,
    finishTimeSec: 0,
    peakKg: 0,
    peakPallets: 0,
    distanceKm: 0,
    trips: [mkTrip(stops)],
  };
}

function mkPlan(
  id: string,
  vehicles: PlanVehicle[],
  stats: PlanStats,
  unassignedOrderNos: string[],
): Plan {
  return {
    id,
    scenarioId: 'scn',
    scenarioRevision: 0,
    day: '2026-05-06',
    createdAt: '2026-05-06T08:00:00.000Z',
    source: 'saved',
    objective: 'vehicles',
    provenance: {
      inputSha256: 'deadbeef',
      solverConfig: {},
      termination: 'OK',
      validation: { valid: true, violations: [] },
    },
    stats,
    cost: null,
    depot: { name: 'D', lon: 10, lat: 50 },
    vehicles,
    unassigned: unassignedOrderNos.map((orderNo) => ({
      orderId: null, orderNo, customer: null, city: null, lon: null, lat: null, reason: null, reasonCode: null,
    })),
  };
}

function stats(over: Partial<PlanStats>): PlanStats {
  return {
    servedOrders: 0,
    totalOrders: 0,
    deliveryStops: 0,
    trips: 0,
    vehiclesUsed: 0,
    totalDistanceKm: 0,
    solveElapsedSeconds: null,
    ...over,
  };
}

/* ------------------------------------------------------------------
 * Base:
 *   VAN-A: A1, A2
 *   VAN-B: B1          (B1 moves to VAN-A in revised)
 *   VAN-C: C1          (VAN-C removed entirely in revised)
 * Revised:
 *   VAN-A: A1, B1      (A2 newly unassigned; B1 moved from VAN-B)
 *   VAN-D: D1          (added vehicle, D1 now served)
 * ------------------------------------------------------------------ */

test('comparePlans: deltas, moved/unassigned/removed/added', () => {
  const base = mkPlan(
    'plan_base',
    [
      mkVehicle('VAN-A', [mkStop('A1'), mkStop('A2')]),
      mkVehicle('VAN-B', [mkStop('B1')]),
      mkVehicle('VAN-C', [mkStop('C1')]),
    ],
    stats({ servedOrders: 4, vehiclesUsed: 3, trips: 3, totalDistanceKm: 100.0 }),
    [], // nothing unassigned in base
  );

  const revised = mkPlan(
    'plan_rev',
    [
      mkVehicle('VAN-A', [mkStop('A1'), mkStop('B1')]), // B1 moved here
      mkVehicle('VAN-D', [mkStop('D1')]),               // added vehicle
    ],
    stats({ servedOrders: 3, vehiclesUsed: 2, trips: 2, totalDistanceKm: 87.4 }),
    ['A2'], // A2 newly unassigned
  );

  const cmp = comparePlans(base, revised);

  // --- deltas ---
  assert.equal(cmp.deltas.servedOrders, 3 - 4); // -1
  assert.equal(cmp.deltas.vehiclesUsed, 2 - 3); // -1
  assert.equal(cmp.deltas.trips, 2 - 3);        // -1
  assert.equal(cmp.deltas.totalDistanceKm, -12.6); // 87.4 - 100.0, rounded to .1
  assert.equal(cmp.deltas.unassigned, 1 - 0);   // +1

  // --- newlyUnassigned: A2 (was on VAN-A) and C1 (its vehicle VAN-C vanished).
  // Both are in base placements but absent from revised placements. C1 shows
  // up here AND under removedVehicles (its whole vehicle went away).
  assert.equal(cmp.newlyUnassigned.length, 2);
  const byOrder = new Map(cmp.newlyUnassigned.map((u) => [u.orderNo, u]));
  assert.deepEqual([...byOrder.keys()].sort(), ['A2', 'C1']);
  assert.equal(byOrder.get('A2')!.fromVehicleRef, 'VAN-A');
  assert.equal(byOrder.get('A2')!.customer, 'Cust-A2');
  assert.equal(byOrder.get('A2')!.city, 'City-A2');
  assert.equal(byOrder.get('C1')!.fromVehicleRef, 'VAN-C');

  // --- movedOrders: B1 from VAN-B to VAN-A ---
  assert.equal(cmp.movedOrders.length, 1);
  assert.equal(cmp.movedOrders[0]!.orderNo, 'B1');
  assert.equal(cmp.movedOrders[0]!.fromVehicleRef, 'VAN-B');
  assert.equal(cmp.movedOrders[0]!.toVehicleRef, 'VAN-A');

  // --- nowServed: D1 (not present in base placements) ---
  assert.equal(cmp.nowServed.length, 1);
  assert.equal(cmp.nowServed[0]!.orderNo, 'D1');
  assert.equal(cmp.nowServed[0]!.toVehicleRef, 'VAN-D');

  // --- removedVehicles: VAN-B and VAN-C (had orders in base, none in revised) ---
  assert.deepEqual([...cmp.removedVehicles].sort(), ['VAN-B', 'VAN-C']);

  // --- addedVehicles: VAN-D ---
  assert.deepEqual(cmp.addedVehicles, ['VAN-D']);

  // --- base/revised plan ids + stats echoed back ---
  assert.equal(cmp.base.planId, 'plan_base');
  assert.equal(cmp.revised.planId, 'plan_rev');
  assert.equal(cmp.base.stats.servedOrders, 4);
  assert.equal(cmp.revised.stats.servedOrders, 3);
});

test('comparePlans: identical plans yield empty diffs and zero deltas', () => {
  const build = (id: string): Plan =>
    mkPlan(
      id,
      [mkVehicle('VAN-A', [mkStop('A1')])],
      stats({ servedOrders: 1, vehiclesUsed: 1, trips: 1, totalDistanceKm: 10.0 }),
      [],
    );
  const cmp = comparePlans(build('b'), build('r'));

  assert.equal(cmp.deltas.servedOrders, 0);
  assert.equal(cmp.deltas.vehiclesUsed, 0);
  assert.equal(cmp.deltas.trips, 0);
  assert.equal(cmp.deltas.totalDistanceKm, 0);
  assert.equal(cmp.deltas.unassigned, 0);
  assert.equal(cmp.newlyUnassigned.length, 0);
  assert.equal(cmp.movedOrders.length, 0);
  assert.equal(cmp.nowServed.length, 0);
  assert.equal(cmp.removedVehicles.length, 0);
  assert.equal(cmp.addedVehicles.length, 0);
});
