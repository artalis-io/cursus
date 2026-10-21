import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Plan } from '../types.js';
import { approvalBlockers, planDigest } from './plan-workflow.js';

export function validPlan(): Plan {
  return { id: 'review-plan', scenarioId: 'review-scenario', scenarioRevision: 1,
    provenance: { inputSha256: 'a'.repeat(64), validation: { valid: true, violations: [] } },
    stats: { servedOrders: 1, totalOrders: 1, deliveryStops: 1 }, unassigned: [],
    vehicles: [{ id: 1, capacityKg: 1000, capacityPallets: 10, tonnage: 12, hasTailLift: true,
      trips: [{ loadKg: 100, loadPallets: 1, stops: [{ orderNo: 'ORDER', maxTonnage: 12, requiresTailLift: true,
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
