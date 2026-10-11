import { test } from 'node:test';
import assert from 'node:assert/strict';

import { vehicleCost, vehicleCostFor, type Tariff } from './cost.js';

const TARIFF: Tariff = {
  currency: 'HUF', source: 'demo', model: 'per_vehicle',
  perKmDefault: 200, fixedPerVehicle: 30_000,
  perKmByClass: { SEMI: 300 }, fixedByClass: { SEMI: 50_000 },
  perTripBase: 49_000, perKm: 337, perDrop: 7_200, includedDrops: 2,
  subcontractorMultiplier: 1.1, ownFleetMultiplier: 1.0,
};

test('vehicleCost: default rates when class is unknown', () => {
  const c = vehicleCost(TARIFF, null, false, 100);
  assert.equal(c.fixed, 30_000);
  assert.equal(c.variable, 200 * 100);
  assert.equal(c.total, 30_000 + 20_000);
});

test('vehicleCost: per-class override applies (substring match)', () => {
  const c = vehicleCost(TARIFF, 'SEMI_TRAILER', false, 100);
  assert.equal(c.fixed, 50_000);
  assert.equal(c.variable, 300 * 100);
});

test('vehicleCost: subcontractor multiplier applies to fixed and variable', () => {
  const c = vehicleCost(TARIFF, null, true, 100);
  assert.equal(c.fixed, Math.round(30_000 * 1.1));
  assert.equal(c.variable, Math.round(200 * 100 * 1.1));
  assert.equal(c.total, c.fixed + c.variable);
});

const TRIP_TARIFF: Tariff = { ...TARIFF, model: 'per_trip', ownFleetMultiplier: 0.8, subcontractorMultiplier: 1.0 };

test('vehicleCostFor: per_trip charges base + per-km per trip, plus per-drop beyond included', () => {
  // two trips: 100km/3 drops, 50km/2 drops. own fleet (mult 0.8).
  const c = vehicleCostFor(TRIP_TARIFF, { vehicleClass: null, isSubcontractor: false, distanceKm: 150,
    trips: [{ distanceKm: 100, drops: 3 }, { distanceKm: 50, drops: 2 }] });
  const fixed = Math.round((49_000 + 49_000) * 0.8);
  const variable = Math.round((337 * 100 + 7_200 * 1 /*3-2*/ + 337 * 50 + 7_200 * 0) * 0.8);
  assert.equal(c.fixed, fixed);
  assert.equal(c.variable, variable);
  assert.equal(c.total, fixed + variable);
});

test('vehicleCostFor: subcontractor uses subcontractorMultiplier, not own-fleet', () => {
  const own = vehicleCostFor(TRIP_TARIFF, { vehicleClass: null, isSubcontractor: false, distanceKm: 100, trips: [{ distanceKm: 100, drops: 2 }] });
  const sub = vehicleCostFor(TRIP_TARIFF, { vehicleClass: null, isSubcontractor: true, distanceKm: 100, trips: [{ distanceKm: 100, drops: 2 }] });
  assert.ok(sub.total > own.total); // mult 1.0 > 0.8
});

test('vehicleCostFor: per_vehicle model falls back to vehicleCost', () => {
  const a = vehicleCostFor(TARIFF, { vehicleClass: null, isSubcontractor: false, distanceKm: 100, trips: [{ distanceKm: 100, drops: 5 }] });
  const b = vehicleCost(TARIFF, null, false, 100);
  assert.deepEqual(a, b);
});
