import test from 'node:test';
import assert from 'node:assert/strict';
import { statefulDatasetSummary, statefulDaySummaries, statefulImportSummary, statefulJobResponse, statefulPlanSummaries, statefulWeekSummary } from './api.js';
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

test('plan summaries preserve the history dialog contract and day filter', () => {
  const scenarios = [scenario('day1-base', 'day1'), scenario('day2-base', 'day2')];
  const plans = [plan('day1-baseline', 'day1-base', '2026-05-06'), plan('day2-baseline', 'day2-base', '2026-05-07')];
  const summaries = statefulPlanSummaries(scenarios, plans, 'day1');
  assert.equal(summaries.length, 1);
  assert.deepEqual(summaries[0], {
    id: 'day1-baseline', scenarioId: 'day1-base', day: 'day1', label: 'day1 label', source: 'saved',
    createdAt: '2026-05-02T00:00:00Z', termination: 'UNKNOWN', servedOrders: 7, totalOrders: 8,
    vehiclesUsed: 1, totalDistanceKm: 10,
  });
});

test('week summary rolls up both stateful base plans', () => {
  const scenarios = [scenario('day1-base', 'day1'), scenario('day2-base', 'day2')];
  const summary = statefulWeekSummary(scenarios, [
    plan('day1-baseline', 'day1-base', '2026-05-06'), plan('day2-baseline', 'day2-base', '2026-05-07'),
  ]);
  assert.equal(summary.days.length, 2);
  assert.equal(summary.totals.servedOrders, 14);
  assert.equal(summary.totals.totalDistanceKm, 20);
});

test('replaced input cycles remain navigable but are excluded from weekly totals',()=>{
  const old={...scenario('old-base','old'),supersededBy:{scenarioId:'new-base',planId:'new-plan',at:'2026-10-30T00:00:00Z'}};
  const current=scenario('new-base','new');
  const plans=[plan('old-plan',old.id,'2026-05-06'),plan('new-plan',current.id,'2026-05-06')];
  const days=statefulDaySummaries([old,current],plans);
  assert.equal(days.length,2);assert.equal(days.find(d=>d.id==='old')?.archived,true);
  const week=statefulWeekSummary([old,current],plans);
  assert.equal(week.days.length,1);assert.equal(week.days[0]?.dayId,'new');assert.equal(week.totals.servedOrders,7);
});

test('job response maps durable state and result to the SPA contract', () => {
  const job = statefulJobResponse({ id: 'job-1', state: 'succeeded', payload: { scenarioId: 'day1-base', scenarioRevision: 2 },
    result: { planId: 'pln-1' }, createdAt: '2026-05-01T00:00:00Z', updatedAt: '2026-05-01T00:00:03Z' });
  assert.equal(job.status, 'completed');
  assert.equal(job.planId, 'pln-1');
  assert.equal(job.scenarioId, 'day1-base');
  assert.equal(job.elapsedSec, 3);
});

test('active job elapsed time advances independently of heartbeat timestamps', () => {
  const createdAt = new Date(Date.now() - 5_000).toISOString();
  const job = statefulJobResponse({ id: 'job-live', state: 'running', payload: {}, result: {}, createdAt, updatedAt: createdAt });
  assert.ok(job.elapsedSec >= 4.5, `expected live elapsed time, got ${job.elapsedSec}`);
});

test('stateful dataset and provenance adapters preserve the SPA contract', () => {
  const source = { key: 'tenants/t/sha256/abc', sha256: 'abc', size: 42, mediaType: 'text/csv' };
  const row = { id: 'ds_1', createdAt: '2026-05-01T00:00:00Z', manifest: { label: 'Gyermelyi', source,
    days: [{ dayId: 'd1', isoDate: '2026-05-06', orders: 10 }, { dayId: 'd2', isoDate: '2026-05-07', orders: 12 }], stats: { routable: 22 } } };
  assert.deepEqual(statefulDatasetSummary(row), { id: 'ds_1', label: 'Gyermelyi', createdAt: row.createdAt,
    days: [{ dayId: 'd1', isoDate: '2026-05-06', orders: 10 }, { dayId: 'd2', isoDate: '2026-05-07', orders: 12 }], totalOrders: 22 });
  const summary = statefulImportSummary([row]);
  assert.equal(summary.sources[0]?.sha256, 'abc'); assert.equal(summary.scope.day1, 10); assert.equal(summary.scope.day2, 12);
  assert.ok(summary.pipeline.length > 0); assert.ok(summary.rules.length > 0);
});
