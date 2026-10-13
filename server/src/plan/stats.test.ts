import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withNormalizedPlanStats } from './stats.js';
import type { Plan } from '../types.js';

test('normalizes legacy served count without collapsing duplicate display references', () => {
  const plan = {
    stats: { servedOrders: 145, totalOrders: 146 },
    unassigned: [],
  } as unknown as Plan;
  const normalized = withNormalizedPlanStats(plan);
  assert.equal(normalized.stats.servedOrders, 146);
  assert.equal(plan.stats.servedOrders, 145);
});

test('subtracts explicit unassigned requests from the authoritative total', () => {
  const plan = {
    stats: { servedOrders: 0, totalOrders: 146 },
    unassigned: [{}, {}],
  } as unknown as Plan;
  assert.equal(withNormalizedPlanStats(plan).stats.servedOrders, 144);
});
