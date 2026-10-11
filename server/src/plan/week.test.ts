import { test } from 'node:test';
import assert from 'node:assert/strict';

import { weekSummary, type WeekDayInput } from './week.js';
import type { Plan, PlanVehicle } from '../types.js';

function veh(id: number, ref: string, km: number, trips: number, cost: number): PlanVehicle {
  return { id, ref, vehicleClass: 'rigid', isSubcontractor: false, tonnage: 12, hasTailLift: false, color: '#000',
    capacityKg: 1, capacityPallets: 1, tripCount: trips, finishTimeSec: 0, peakKg: 0, peakPallets: 0, distanceKm: km, trips: [] };
}
function plan(vehicles: PlanVehicle[], served: number, total: number, costTotal: number): Plan {
  return {
    id: 'p', scenarioId: 's', scenarioRevision: 0, day: '2026-05-06', createdAt: '', source: 'saved', objective: 'vehicles',
    provenance: { inputSha256: '', solverConfig: {}, termination: 'OK', validation: { valid: true, violations: [] } },
    stats: { servedOrders: served, totalOrders: total, deliveryStops: served, trips: vehicles.reduce((n, v) => n + v.tripCount, 0), vehiclesUsed: vehicles.length, totalDistanceKm: vehicles.reduce((n, v) => n + v.distanceKm, 0), solveElapsedSeconds: null },
    cost: { currency: 'HUF', source: 'external', total: costTotal, fixed: 0, variable: costTotal, perVehicle: vehicles.map((v) => ({ vehicleId: v.id, ref: v.ref, vehicleClass: v.vehicleClass, distanceKm: v.distanceKm, fixedCost: 0, variableCost: 0, totalCost: Math.round(costTotal / vehicles.length) })) },
    depot: { name: 'D', lon: 0, lat: 0 }, vehicles, unassigned: [],
  };
}

test('weekSummary: totals, distinct vehicles, and per-vehicle two-day rollup', () => {
  // day1: A(100km), B(50km); day2: A(80km), C(20km). A works both days.
  const d1 = plan([veh(1, 'A', 100, 2, 200_000), veh(2, 'B', 50, 1, 100_000)], 10, 12, 300_000);
  const d2 = plan([veh(1, 'A', 80, 1, 160_000), veh(3, 'C', 20, 1, 40_000)], 8, 8, 200_000);
  const days: WeekDayInput[] = [
    { dayId: 'day1', isoDate: '2026-05-06', label: 'Wed', plan: d1 },
    { dayId: 'day2', isoDate: '2026-05-07', label: 'Thu', plan: d2 },
  ];
  const w = weekSummary(days);

  assert.equal(w.totals.servedOrders, 18);
  assert.equal(w.totals.totalOrders, 20);
  assert.equal(w.totals.vehiclesUsed, 3);        // A, B, C distinct
  assert.equal(w.totals.totalDistanceKm, 250);   // 100+50+80+20
  assert.equal(w.totals.costTotal, 500_000);
  assert.equal(w.days.length, 2);

  const a = w.vehicles.find((v) => v.ref === 'A')!;
  assert.equal(a.daysWorked, 2);
  assert.equal(a.totalKm, 180);
  assert.ok(a.perDay.day1 && a.perDay.day2);
  const b = w.vehicles.find((v) => v.ref === 'B')!;
  assert.equal(b.daysWorked, 1);
  assert.equal(b.perDay.day2, null);
  // sorted by total km desc: A(180) first
  assert.equal(w.vehicles[0]!.ref, 'A');
});
