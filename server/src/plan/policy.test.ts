import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { withPlanningPolicy, type PlanningPolicy } from './policy.js';
import { applyAccessLimits } from './access.js';
import type { LoadedDay, OrderInfo } from '../data/dataset.js';
import { applyScenarioEdits, exportScenario, parseScenarioImport, type Scenario } from '../store.js';
import { ScenarioRepository } from '../state/scenarios.js';
import type { StatefulStore } from '../state/postgres.js';
import { loadConvertedDay } from '../state/conversion.js';
import { createStatefulApi } from '../state/api.js';

const policy = (): PlanningPolicy => ({ version: 1, id: 'public-test-approval', date: '2026-05-06', datasetRequestSha256: 'a'.repeat(64),
  approvedAt: '2026-05-01T00:00:00Z', approvedBy: 'operator', exceptions: [
    { orderNo: 'PUBLIC', reason: 'Operator-approved unloading arrangement', originalRequiresTailLift: true, requiresTailLift: false },
  ] });
function day(): LoadedDay {
  return { def: { id: 'day1', date: '2026-05-06', isoDate: '2026-05-06', label: 'Public fixture', requestFile: '', solutionFile: '' },
    datasetRequestSha256: 'a'.repeat(64), kind: 'uploaded', scopeTaskIds: new Set([0]), depot: { name: 'Depot', lon: 19, lat: 47 },
    solution: { status: 'OK', routes: [], unassigned: [0], stats: { vehicles_used: 0, total_distance: 0, unassigned: 1 } },
    enrichment: new Map([['PUBLIC', { maxTonnage: 5.5, requiresTailLift: true } as OrderInfo]]),
    request: { config: {}, dimension_count: 2, demand_sign_convention: 1, locations: [{ x: 19, y: 47 }],
      depots: [{ location_id: 0, tw_early: 0, tw_late: 86400 }],
      vehicles: [{ id: 7, ref: 'VAN', gross_weight_kg: 3500, has_tail_lift: false, capacity: [1000, 5], start_depot_id: 0, end_depot_id: 0 },
        { id: 42, ref: 'TRUCK', gross_weight_kg: 12000, has_tail_lift: true, capacity: [5000, 15], start_depot_id: 0, end_depot_id: 0 }],
      tasks: [{ id: 0, ref: 'PUBLIC', type: 'delivery', location_id: 0, demand: [100, 1], tw_early: 0, tw_late: 86400, service_seconds: 60 }],
      requests: [{ id: 0, delivery_task_id: 0 }], travel: { location_count: 1, distances: [0], durations: [0] } } };
}
const scenario = (): Scenario => ({ id: 'day1-base', day: 'day1', kind: 'base', parentId: null, revision: 0, label: 'Public',
  createdAt: '2026-05-01T00:00:00Z', removedVehicleIds: [], pins: [], forbids: [], sequences: [], vehicleOverrides: [], planningPolicy: policy() });

test('approved tail-lift waiver preserves hard GVW and never mutates source/cached enrichment', () => {
  const source = day(), effective = withPlanningPolicy(source, policy());
  assert.equal(source.enrichment.get('PUBLIC')!.requiresTailLift, true);
  assert.equal(effective.enrichment.get('PUBLIC')!.requiresTailLift, false);
  assert.equal(effective.enrichment.get('PUBLIC')!.maxTonnage, 5.5);
  applyAccessLimits(effective.request, effective.enrichment, new Map());
  assert.deepEqual(effective.request.requests[0]!.forbidden_vehicles, [42]);
  const gv = policy(); gv.exceptions = [{ orderNo: 'PUBLIC', reason: 'Approved gross-weight exception', originalMaxTonnage: 5.5, maxTonnage: 12 }];
  const other = withPlanningPolicy(day(), gv);
  applyAccessLimits(other.request, other.enrichment, new Map());
  assert.equal(other.enrichment.get('PUBLIC')!.requiresTailLift, true);
  assert.deepEqual(other.request.requests[0]!.forbidden_vehicles, [7]);
});

test('approval fails closed for a different day/dataset, stale source, invalid bounds and duplicate orders', () => {
  for (const mutate of [
    (p: PlanningPolicy) => { p.date = '2026-05-07'; },
    (p: PlanningPolicy) => { p.datasetRequestSha256 = 'b'.repeat(64); },
    (p: PlanningPolicy) => { p.exceptions[0]!.originalRequiresTailLift = false; },
    (p: PlanningPolicy) => { p.exceptions[0]!.orderNo = 'OTHER'; },
    (p: PlanningPolicy) => { p.exceptions.push({ ...p.exceptions[0]! }); },
    (p: PlanningPolicy) => { p.exceptions = [{ orderNo: 'PUBLIC', reason: 'bad', originalMaxTonnage: 5.5, maxTonnage: NaN }]; },
  ]) { const p = policy(); mutate(p); assert.throws(() => withPlanningPolicy(day(), p)); }
});

test('stateful copies, edits and exports retain server-owned approvals; imports cannot invent approval', async () => {
  const rows = new Map<string, Scenario>([['day1-base', scenario()]]);
  const store = { getScenario: async (_t: string, id: string) => rows.get(id),
    createScenario: async (_t: string, id: string, body: Scenario) => { rows.set(id, body); },
    updateScenario: async (_t: string, id: string, _r: number, body: Scenario) => { rows.set(id, body); return body.revision; } } as unknown as StatefulStore;
  const repo = new ScenarioRepository(store, 'test');
  const copy = await repo.copy(scenario()); assert.deepEqual(copy.planningPolicy, policy());
  const edited = applyScenarioEdits(copy, [{ op: 'clearOverrides' }]); assert.deepEqual(edited.planningPolicy, policy());
  const exported = exportScenario(edited); assert.equal(exported.edits.planningPolicyId, policy().id);
  const parsed = parseScenarioImport(exported); assert.ok(!('error' in parsed));
  if ('error' in parsed) return;
  assert.deepEqual((await repo.import(scenario(), 'Imported', parsed.edits)).planningPolicy, policy());
  await assert.rejects(repo.import(scenario(), 'Injected', { ...parsed.edits, planningPolicyId: 'unapproved' }));
});

test('real admitted dataset loader applies checksum-bound policy before solver preparation', async () => {
  const source = day(), request = Buffer.from(JSON.stringify(source.request));
  const sha = createHash('sha256').update(request).digest('hex');
  const geo = Buffer.from(JSON.stringify({ records: [{ order_no: 'PUBLIC', delivery_date: '2026-05-06', special_req: 'emelőhátfal 5,5 t' }] }));
  const object = (name: string, bytes: Buffer) => ({ key: 'tenants/test/sha256/'+name, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, mediaType: 'application/json' });
  const manifest = { artifacts: { request: object('request', request), geocoded: object('geo', geo) }, days: [{ dayId: 'day1', date: '2026-05-06', isoDate: '2026-05-06', label: 'Public' }] };
  const s = scenario(); s.planningPolicy!.datasetRequestSha256 = sha;
  const loaded = await loadConvertedDay({ getVerified: async (o: { key: string }) => o.key.endsWith('request') ? request : geo } as never, 'test', manifest, s);
  assert.equal(loaded.enrichment.get('PUBLIC')!.requiresTailLift, false);
  assert.equal(loaded.enrichment.get('PUBLIC')!.maxTonnage, 5.5);
  assert.deepEqual(loaded.planningPolicy, s.planningPolicy);
});

test('real HTTP solve submission retains full-budget flag and authoritative policy snapshot', async () => {
  let submitted: unknown;
  const s = scenario();
  const store = { ensureTenant: async () => {}, getScenario: async () => s,
    enqueueJob: async (_t: string, _k: string, _key: string, payload: unknown) => { submitted = payload; return 'job'; } } as unknown as StatefulStore;
  const app = await createStatefulApi({ store, tenantId: 'test', tenantName: 'Public' });
  try {
    const res = await app.inject({ method: 'POST', url: '/api/scenarios/day1-base/solve', headers: { 'if-match': `"${s.revision}"` }, payload: { fullBudget: true, budgetSec: 600, planningPolicy: null } });
    assert.equal(res.statusCode, 202);
    assert.equal((submitted as {fullBudget: boolean}).fullBudget, true);
    assert.deepEqual((submitted as {scenario: Scenario}).scenario.planningPolicy, policy());
  } finally { await app.close(); }
});
