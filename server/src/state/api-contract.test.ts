import test from 'node:test';
import assert from 'node:assert/strict';
import { statefulDaySummaries, statefulJobResponse } from './api.js';
import type { Scenario } from '../store.js';
import type { Plan } from '../types.js';

const scenario = (id: string, day: string, kind: 'base' | 'copy' = 'base'): Scenario => ({
  id, day, kind, parentId: null, revision: 0, label: `${day} label`, createdAt: '2026-05-01T00:00:00Z',
  removedVehicleIds: [], pins: [], forbids: [], vehicleOverrides: [], sequences: [],
});
const plan = (id: string, scenarioId: string, day: string, createdAt = '2026-05-02T00:00:00Z', source: 'saved' | 'live' = 'saved') => ({
  id, scenarioId, scenarioRevision: 0, day, createdAt, source, objective: 'vehicles',
  stats: { servedOrders: 7, totalOrders: 8, deliveryStops: 7, trips: 2, vehiclesUsed: 1, totalDistanceKm: 10, solveElapsedSeconds: 1 },
  vehicles: [{ id: 1 }], unassigned: [],
} as unknown as Plan);

test('day summaries expose real published plan ids and omit unsolved days', () => {
  const days = statefulDaySummaries(
    [scenario('day1-base', 'day1'), scenario('day2-base', 'day2'), scenario('copy', 'day1', 'copy')],
    [plan('pln-old', 'day1-base', '2026-05-06', '2026-05-02T00:00:00Z'), plan('pln-current', 'day1-base', '2026-05-06', '2026-05-03T00:00:00Z')],
  );
  assert.deepEqual(days, [{ id: 'day1', isoDate: '2026-05-06', label: 'day1 label', datasetLabel: null,
    orders: 8, vehicles: 1, baseScenarioId: 'day1-base', baselinePlanId: 'pln-current' }]);
});

test('day summaries prefer the saved baseline over a newer live replan', () => {
  const days = statefulDaySummaries([scenario('day1-base', 'day1')], [
    plan('day1-baseline', 'day1-base', '2026-05-06', '1970-01-01T00:00:00Z'),
    plan('pln-live', 'day1-base', '2026-05-06', '2026-05-03T00:00:00Z', 'live'),
  ]);
  assert.equal(days[0]?.baselinePlanId, 'day1-baseline');
});

test('job response maps durable state and result to the SPA contract', () => {
  const job = statefulJobResponse({ id: 'job-1', state: 'succeeded', payload: { scenarioId: 'day1-base', scenarioRevision: 2 },
    result: { planId: 'pln-1' }, createdAt: '2026-05-01T00:00:00Z', updatedAt: '2026-05-01T00:00:03Z' });
  assert.equal(job.status, 'completed');
  assert.equal(job.planId, 'pln-1');
  assert.equal(job.scenarioId, 'day1-base');
  assert.equal(job.elapsedSec, 3);
});
