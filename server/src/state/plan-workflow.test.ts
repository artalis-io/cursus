import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Plan } from '../types.js';
import { approvalBlockers, planDigest } from './plan-workflow.js';

export function validPlan(): Plan {
  return { id: 'review-plan', scenarioId: 'review-scenario', scenarioRevision: 1,
    day: '2026-05-06', createdAt: '2026-05-06T00:00:00.000Z', source: 'live', objective: 'distance', cost: null,
    depot: { name: 'Test depot', lon: 19, lat: 47 },
    provenance: { inputSha256: 'a'.repeat(64), solverConfig: {}, termination: 'OK', validation: { valid: true, violations: [] } },
    stats: { servedOrders: 1, totalOrders: 1, deliveryStops: 1, vehiclesUsed: 1, trips: 1, totalDistanceKm: 10, solveElapsedSeconds: 1 }, unassigned: [],
    vehicles: [{ id: 1, ref: 'TEST-1', color: '#123456', vehicleClass: null, isSubcontractor: false,
      distanceKm: 10, tripCount: 1, finishTimeSec: 300, capacityKg: 1000, capacityPallets: 10, tonnage: 12, hasTailLift: true,
      trips: [{ index: 0, startSec: 0, endSec: 300, distanceKm: 10, reloadSecAfter: 0, loadKg: 100, loadPallets: 1, stops: [{ orderNo: 'ORDER', maxTonnage: 12, requiresTailLift: true,
        seq: 1, lon: 19.1, lat: 47.1, weightKg: 100, pallets: 1, serviceMin: 1, lateBySec: 0, departureSec: 160,
        arrivalSec: 90, serviceStartSec: 100, twStartSec: 100, twEndSec: 200 }] }] }],
  } as unknown as Plan;
}
test('approval hashes are independent of JSON object key order and include all immutable plan bytes', () => {
  assert.equal(planDigest({ b: 2, a: { d: 4, c: 3 } }), planDigest({ a: { c: 3, d: 4 }, b: 2 }));
  assert.notEqual(planDigest(validPlan()), planDigest({ ...validPlan(), scenarioRevision: 2 }));
});
test('approval fails closed on stale, incomplete and missing evidence and hard constraint violations', () => {
  assert.deepEqual(approvalBlockers(validPlan(), 1), []);
  assert.ok(approvalBlockers(validPlan(), 2).length);
  for (const mutate of [
    (p: Plan) => { p.stats.servedOrders = 0; },
    (p: Plan) => { p.vehicles = []; },
    (p: Plan) => { p.provenance.validation.valid = false; },
    (p: Plan) => { p.provenance.validation.violations = [{ type: 'TAIL_LIFT', soft: true }]; },
    (p: Plan) => { p.provenance.inputSha256 = ''; },
    (p: Plan) => { p.vehicles[0]!.tonnage = 24; },
    (p: Plan) => { p.vehicles[0]!.hasTailLift = false; },
    (p: Plan) => { p.vehicles[0]!.trips[0]!.loadKg = 2000; },
    (p: Plan) => { p.vehicles[0]!.trips[0]!.stops[0]!.arrivalSec = 201.1; },
    (p: Plan) => { p.vehicles[0]!.trips[0]!.stops[0]!.maxTonnage = undefined as unknown as null; },
  ]) { const p = validPlan(); mutate(p); assert.ok(approvalBlockers(p, 1).length); }
});
