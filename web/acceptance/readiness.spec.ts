import { test, expect } from '@playwright/test';
import { reviewComparison, reviewReadiness } from '../src/lib/readiness';
import type { Plan, Scenario } from '../src/types';

function fixture(): { plan: Plan; scenario: Scenario } {
  const scenario: Scenario = { id: 'scenario', day: 'day1', kind: 'base', parentId: null, revision: 1, label: 'Day',
    removedVehicleIds: [], pins: [], forbids: [], vehicleOverrides: [], sequences: [], createdAt: '' };
  const plan: Plan = {
    id: 'plan', scenarioId: 'scenario', scenarioRevision: 1, day: '2026-05-06', createdAt: '', source: 'saved', objective: 'vehicles',
    provenance: { inputSha256: 'a'.repeat(64), solverConfig: {}, termination: 'OK', validation: { valid: true, violations: [] } },
    stats: { servedOrders: 1, totalOrders: 1, deliveryStops: 1, vehiclesUsed: 1, trips: 1, totalDistanceKm: 100, solveElapsedSeconds: 1 },
    cost: { currency: 'HUF', source: 'external', total: 10000, fixed: 1000, variable: 9000, perVehicle: [] },
    depot: { name: 'Depot', lon: 19, lat: 47 }, unassigned: [],
    vehicles: [{ id: 7, ref: 'TRUCK', vehicleClass: null, isSubcontractor: false, tonnage: 12, hasTailLift: true,
      color: '', capacityKg: 5000, capacityPallets: 10, tripCount: 1, finishTimeSec: 150, peakKg: 1000, peakPallets: 1, distanceKm: 100,
      trips: [{ index: 0, startSec: 0, endSec: 150, distanceKm: 100, reloadSecAfter: 0, loadKg: 1000, loadPallets: 1, costFt: null, geometry: null,
        stops: [{ orderId: '1', orderNo: 'ORDER', customer: 'Customer', city: '', lon: 19, lat: 47, seq: 1, type: 'delivery',
          arrivalSec: 90, serviceStartSec: 100, departureSec: 120, twStartSec: 100, twEndSec: 200,
          pallets: 1, weightKg: 1000, serviceMin: 1, waitSec: 10, travelToSec: 90, lateBySec: 0, requiresTailLift: true, maxTonnage: 12 }] }] }],
  };
  return { plan, scenario };
}

test('readiness: valid snapshot passes; waiting until opening and exact GVW limit are legal', () => {
  const { plan, scenario } = fixture();
  const before = structuredClone(plan);
  expect(reviewReadiness(plan, scenario).status).toBe('passed');
  expect(plan).toEqual(before);
});

for (const key of ['gvw', 'tailLift', 'capacity', 'timeWindows'] as const) {
  test(`readiness: ${key} snapshot violation blocks even with stale valid=true provenance`, () => {
    const { plan, scenario } = fixture();
    const vehicle = plan.vehicles[0], trip = vehicle.trips[0], stop = trip.stops[0];
    if (key === 'gvw') vehicle.tonnage = 24;
    if (key === 'tailLift') vehicle.hasTailLift = false;
    if (key === 'capacity') trip.loadKg = 6000;
    if (key === 'timeWindows') stop.arrivalSec = 201.1;
    const review = reviewReadiness(plan, scenario);
    expect(review.status).toBe('blocked');
    expect(review.checks.find(c => c.key === key)?.state).toBe('failed');
  });
}

test('readiness: missing GVW or validation is not evidence of feasibility', () => {
  const { plan, scenario } = fixture();
  plan.vehicles[0].tonnage = null;
  expect(reviewReadiness(plan, scenario).checks.find(c => c.key === 'gvw')?.state).toBe('unknown');
  expect(reviewReadiness(plan, scenario).status).toBe('review');
  delete (plan.provenance as Partial<Plan['provenance']>).validation;
  expect(reviewReadiness(plan, scenario).status).toBe('review');
  expect(reviewReadiness(plan, scenario).checks.filter(c => c.state === 'unknown')).toHaveLength(4);
});

test('readiness: authoritative and unknown violations cannot be hidden by snapshot checks', () => {
  const { plan, scenario } = fixture();
  plan.provenance.validation.violations = [{ type: 'TAIL_LIFT', soft: true }];
  expect(reviewReadiness(plan, scenario).status).toBe('blocked');
  plan.provenance.validation.violations = [{ type: 'FUTURE_HARD_CONSTRAINT' }];
  expect(reviewReadiness(plan, scenario).status).toBe('blocked');
  plan.provenance.validation.violations = [];
  plan.provenance.validation.valid = false;
  expect(reviewReadiness(plan, scenario).status).toBe('review');
});

test('readiness: source scenario identity, revision, queued edits and running solves matter', () => {
  const { plan, scenario } = fixture();
  expect(reviewReadiness(plan, { ...scenario, id: 'another-scenario' }).fresh).toBe(false);
  expect(reviewReadiness(plan, { ...scenario, revision: 2 }).status).toBe('blocked');
  expect(reviewReadiness(plan, scenario, true).status).toBe('blocked');
});

test('readiness: locked routes verify exact vehicle and sequence only on a fresh snapshot', () => {
  const { plan, scenario } = fixture();
  scenario.sequences = [{ vehicleId: 7, orderNos: ['ORDER'], locked: true }];
  expect(reviewReadiness(plan, scenario).checks.at(-1)?.state).toBe('passed');
  scenario.sequences[0].orderNos = ['OTHER'];
  expect(reviewReadiness(plan, scenario).status).toBe('blocked');
  scenario.revision++;
  expect(reviewReadiness(plan, scenario).checks.at(-1)?.state).toBe('unknown');
});

test('readiness: approved exceptions are visible but never erase a real violation', () => {
  const { plan, scenario } = fixture();
  plan.provenance.planningPolicy = { id: 'approved', date: '2026-05-06', exceptions: [{ orderNo: 'ORDER', requiresTailLift: false, reason: 'Customer unloads' }] };
  expect(reviewReadiness(plan, scenario).status).toBe('review');
  expect(reviewReadiness(plan, scenario).exceptions[0].reason).toBe('Customer unloads');
  plan.vehicles[0].hasTailLift = false;
  expect(reviewReadiness(plan, scenario).status).toBe('blocked');
});

test('readiness: explicit unassigned list blocks; inconsistent task counts also block', () => {
  const { plan, scenario } = fixture();
  plan.unassigned = [{ orderId: '2', orderNo: 'OTHER', customer: null, city: null, lon: null, lat: null, reason: null, reasonCode: 'CONSTRAINED' }];
  expect(reviewReadiness(plan, scenario).coverageConsistent).toBe(false);
  plan.stats.totalOrders = 2;
  expect(reviewReadiness(plan, scenario).coverageConsistent).toBe(true);
  expect(reviewReadiness(plan, scenario).status).toBe('blocked');
});

test('readiness: duplicate display references never undercount served loads', () => {
  const { plan, scenario } = fixture();
  plan.vehicles[0].trips[0].stops.push({ ...plan.vehicles[0].trips[0].stops[0], seq: 2, orderId: '2' });
  plan.stats.servedOrders = plan.stats.totalOrders = plan.stats.deliveryStops = 2;
  expect(reviewReadiness(plan, scenario).coverageConsistent).toBe(true);
});

test('readiness comparison: reduced or exchanged service is never efficiency savings', () => {
  const { plan } = fixture();
  const revised = structuredClone(plan);
  revised.stats.totalDistanceKm = 10;
  revised.cost!.total = 100;
  revised.stats.servedOrders = 0;
  expect(reviewComparison(plan, revised).lostService).toBe(true);
  revised.stats.servedOrders = 1;
  revised.vehicles[0].trips[0].stops[0].orderNo = 'OTHER';
  expect(reviewComparison(plan, revised).lostService).toBe(true);
  expect(reviewComparison(plan, revised).sameScope).toBe(false);
});

test('readiness comparison: cross-day, currency and cost-source mismatches suppress cost delta', () => {
  const { plan } = fixture();
  const revised = structuredClone(plan);
  expect(reviewComparison(plan, revised).comparableCost).toBe(true);
  revised.cost!.currency = 'EUR';
  expect(reviewComparison(plan, revised).comparableCost).toBe(false);
  revised.cost!.currency = 'HUF'; revised.cost!.source = 'demo';
  expect(reviewComparison(plan, revised).comparableCost).toBe(false);
  revised.day = '2026-05-07';
  expect(reviewComparison(plan, revised).sameScope).toBe(false);
});
