import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { StatefulStore } from './postgres.js';
import { ScenarioRepository } from './scenarios.js';
import { PlanWorkflow } from './plan-workflow.js';
import { createStatefulApi } from './api.js';
import type { Scenario } from '../store.js';
import { validPlan } from './plan-workflow.test.js';

test('two independent APIs reject stale intent and serialize review, approval and revision invalidation', { skip: !process.env.CURSUS_TEST_DATABASE_URL }, async () => {
  const a = new StatefulStore(process.env.CURSUS_TEST_DATABASE_URL!), b = new StatefulStore(process.env.CURSUS_TEST_DATABASE_URL!);
  const tenant = `workflow-${randomUUID()}`;
  await a.migrate(); await a.ensureTenant(tenant, 'Workflow test');
  const scenario: Scenario = { id: 'review-scenario', day: 'public-day', kind: 'copy', parentId: null, revision: 1, label: 'Review test',
    createdAt: new Date().toISOString(), removedVehicleIds: [], pins: [], forbids: [], sequences: [], vehicleOverrides: [] };
  await a.createScenario(tenant, scenario.id, scenario);
  const p = validPlan();
  await a.pool.query('INSERT INTO plans(tenant_id,id,scenario_id,scenario_revision,body) VALUES($1,$2,$3,$4,$5)', [tenant, p.id, p.scenarioId, 1, p]);
  const apps = await Promise.all([a, b].map(store => createStatefulApi({ store, tenantId: tenant, tenantName: 'Workflow test' })));
  const workflow = new PlanWorkflow(a, tenant), peer = new PlanWorkflow(b, tenant);
  try {
    assert.equal((await workflow.get(p.id)).state, 'draft');
    await assert.rejects(() => workflow.transition(p.id, 'plan.approve', 0, 1, true));
    await assert.rejects(() => workflow.transition(p.id, 'plan.review', 0, 1, false));
    const reviewed = await Promise.allSettled([workflow.transition(p.id, 'plan.review', 0, 1, true), peer.transition(p.id, 'plan.review', 0, 1, true)]);
    assert.equal(reviewed.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal((await peer.get(p.id)).version, 1);
    await peer.transition(p.id, 'plan.approve', 1, 1, true);
    assert.equal((await workflow.get(p.id)).state, 'approved');
    const results = await Promise.all(apps.map(app => app.inject({ method: 'POST', url: `/api/scenarios/${scenario.id}/edit`,
      headers: { 'if-match': '"1"' }, payload: { edit: { op: 'removeVehicle', vehicleId: 1 } } })));
    assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 409]);
    assert.equal((await peer.get(p.id)).state, 'superseded');
    const beforeJobs = (await a.pool.query('SELECT count(*) FROM jobs WHERE tenant_id=$1', [tenant])).rows[0].count;
    for (const app of apps) {
      assert.equal((await app.inject({ method: 'POST', url: `/api/scenarios/${scenario.id}/solve`, headers: { 'if-match': '"1"' }, payload: {} })).statusCode, 409);
      assert.equal((await app.inject({ method: 'DELETE', url: `/api/scenarios/${scenario.id}`, headers: { 'if-match': '"1"' } })).statusCode, 409);
      assert.equal((await app.inject({ method: 'POST', url: `/api/scenarios/${scenario.id}/rename`, payload: { label: 'Stale' } })).statusCode, 428);
    }
    assert.equal((await a.pool.query('SELECT count(*) FROM jobs WHERE tenant_id=$1', [tenant])).rows[0].count, beforeJobs);
    assert.equal((await new ScenarioRepository(a, tenant).get(scenario.id))?.revision, 2);
    const foreignTenant = `foreign-${randomUUID()}`; await a.ensureTenant(foreignTenant, 'Foreign');
    await assert.rejects(() => new PlanWorkflow(b, foreignTenant).get(p.id));
    const ledger = await a.pool.query("SELECT action,detail FROM audit_events WHERE tenant_id=$1 AND action IN ('plan.review','plan.approve') ORDER BY id", [tenant]);
    assert.deepEqual(ledger.rows.map(r => r.action), ['plan.review', 'plan.approve']);
    assert.equal(ledger.rows[1].detail.version, 2);
    assert.equal(ledger.rows[1].detail.planSha256, (await workflow.get(p.id)).planSha256);
  } finally { await Promise.all(apps.map(app => app.close())); await Promise.all([a.close(), b.close()]); }
});
