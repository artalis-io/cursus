import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { StatefulStore } from './postgres.js';
import { createStatefulApi } from './api.js';
import { PlanWorkflow, planDigest } from './plan-workflow.js';
import { validPlan } from './plan-workflow.test.js';
import type { Scenario } from '../store.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
class PausableStore extends StatefulStore {
  pause: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | null = null;
  override async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return super.tx(async client => {
      const result = await fn(client);
      const pause = this.pause;
      if (pause) { this.pause = null; pause.entered.resolve(); await pause.release.promise; }
      return result;
    });
  }
}

test('handoff: two replicas serialize exports with approval and edits, preserve historical evidence and fail closed',
  { skip: !process.env.CURSUS_TEST_DATABASE_URL, timeout: 30_000 }, async () => {
    const a = new PausableStore(process.env.CURSUS_TEST_DATABASE_URL!), b = new StatefulStore(process.env.CURSUS_TEST_DATABASE_URL!);
    const tenant = `handoff-${randomUUID()}`;
    await a.migrate(); await a.ensureTenant(tenant, 'Handoff test');
    const scenario: Scenario = { id: 'review-scenario', day: '2026-05-06', kind: 'copy', parentId: null, revision: 1, label: 'Handoff test',
      createdAt: new Date().toISOString(), removedVehicleIds: [], pins: [], forbids: [], sequences: [], vehicleOverrides: [] };
    const plan = validPlan();
    await a.createScenario(tenant, scenario.id, scenario);
    await a.pool.query('INSERT INTO plans(tenant_id,id,scenario_id,scenario_revision,body) VALUES($1,$2,$3,1,$4)', [tenant, plan.id, scenario.id, plan]);
    const apps = await Promise.all([a, b].map(store => createStatefulApi({ store, tenantId: tenant, tenantName: 'Handoff test' })));
    const workflow = new PlanWorkflow(b, tenant);
    const url = `/api/plans/${plan.id}/handoff.json`;
    const get = (node: number, required = false) => apps[node]!.inject({ method: 'GET', url: url + (required ? '?approval=required' : '') });
    const edit = () => apps[1]!.inject({ method: 'POST', url: `/api/scenarios/${scenario.id}/edit`, headers: { 'if-match': '"1"' }, payload: { edit: { op: 'removeVehicle', vehicleId: 1 } } });
    let held: ReturnType<typeof deferred> | undefined;
    try {
      assert.equal((await get(0)).json().handoff.status, 'Draft');
      assert.equal((await get(1, true)).statusCode, 409);
      await workflow.transition(plan.id, 'plan.review', 0, 1, true);
      // Hold the export transaction AFTER rendering, BEFORE commit. Approval on
      // the peer must wait; it cannot retroactively relabel the draft bytes.
      const pause = { entered: deferred(), release: deferred() }; a.pause = pause; held = pause.release;
      const exportingDraft = get(0); void exportingDraft.then(() => {});
      await pause.entered.promise;
      let approved = false;
      const approval = workflow.transition(plan.id, 'plan.approve', 1, 1, true).then(result => { approved = true; return result; });
      await new Promise(r => setTimeout(r, 60)); assert.equal(approved, false);
      pause.release.resolve(); held = undefined;
      assert.equal((await exportingDraft).json().handoff.status, 'Draft'); await approval;
      const exported = await get(1, true);
      assert.equal(exported.statusCode, 200); assert.match(exported.headers['cache-control']!, /no-store/);
      assert.equal(exported.headers['x-cursus-export-status'], 'Approved');
      assert.match(exported.headers['content-disposition']!, /approved\.json/);
      const receipt = exported.json().handoff;
      assert.equal(receipt.planId, plan.id); assert.equal(receipt.planSha256, planDigest(plan));
      assert.equal(receipt.approval.workflowVersion, 2); assert.equal(receipt.approval.approver.identitySource, 'local');
      assert.equal(receipt.constraints.scenarioEvidence, 'matching-revision');
      assert.ok(Date.parse(receipt.checkedAt) >= Date.parse(receipt.approval.approvedAt));
      for (const suffix of ['export.csv', 'routes.csv', 'routesheet.html']) {
        const response = await apps[0]!.inject({ method: 'GET', url: `/api/plans/${plan.id}/${suffix}?approval=required` });
        assert.equal(response.statusCode, 200); assert.equal(response.headers['x-cursus-export-status'], 'Approved');
        assert.match(response.body, /Approved/); assert.match(response.body, /planSha256/);
      }
      // The reverse ordering: an approved export holds the lock, so a peer edit
      // can only commit after those bytes have been checked and materialized.
      const second = { entered: deferred(), release: deferred() }; a.pause = second; held = second.release;
      const exportingApproved = get(0, true); void exportingApproved.then(() => {});
      await second.entered.promise;
      let edited = false;
      const editing = edit().then(result => { edited = true; return result; });
      await new Promise(r => setTimeout(r, 60)); assert.equal(edited, false);
      second.release.resolve(); held = undefined;
      assert.equal((await exportingApproved).json().handoff.status, 'Approved');
      assert.equal((await editing).statusCode, 200);
      for (const node of [0, 1]) {
        assert.equal((await get(node, true)).statusCode, 409);
        const superseded = (await get(node)).json().handoff;
        assert.equal(superseded.status, 'Superseded'); assert.equal(superseded.currentScenarioRevision, 2);
        assert.equal(superseded.approval.workflowVersion, 2);
        assert.equal(superseded.constraints.scenarioEvidence, 'approval-event');
        assert.deepEqual(superseded.constraints.scenario.removedVehicleIds, []);
      }
      assert.equal((await apps[0]!.inject({ method: 'GET', url: url + '?approval=Approved' })).statusCode, 400);
      // Read-only handoffs never create new approval events or jobs.
      assert.equal((await a.pool.query("SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action IN ('plan.review','plan.approve')", [tenant])).rows[0].count, '2');
      assert.equal((await a.pool.query('SELECT count(*) FROM jobs WHERE tenant_id=$1', [tenant])).rows[0].count, '0');
      const foreign = await createStatefulApi({ store: b, tenantId: `foreign-${randomUUID()}`, tenantName: 'Foreign' });
      try { assert.equal((await foreign.inject({ method: 'GET', url })).statusCode, 404); } finally { await foreign.close(); }
      // Edit wins the lock first: the waiting export must see the committed new
      // revision, not the old snapshot it started with.
      const nextScenario = { ...scenario, id: 'handoff-second' }, nextPlan = { ...plan, id: 'handoff-second-plan', scenarioId: 'handoff-second' };
      await a.createScenario(tenant, nextScenario.id, nextScenario);
      await a.pool.query('INSERT INTO plans(tenant_id,id,scenario_id,scenario_revision,body) VALUES($1,$2,$3,1,$4)', [tenant, nextPlan.id, nextScenario.id, nextPlan]);
      const userId = randomUUID(), email = `approver-${randomUUID()}@example.test`;
      await a.pool.query('INSERT INTO users(id,email) VALUES($1,$2)', [userId, email]);
      const actor = { userId, email, tenantId: tenant, role: 'admin' as const };
      await workflow.transition(nextPlan.id, 'plan.review', 0, 1, true, actor);
      await workflow.transition(nextPlan.id, 'plan.approve', 1, 1, true, actor);
      // The actor snapshot is immutable even if the directory email changes.
      await a.pool.query('UPDATE users SET email=$2 WHERE id=$1', [userId, `renamed-${email}`]);
      const nextUrl = `/api/plans/${nextPlan.id}/handoff.json`;
      const named = (await apps[0]!.inject({ method: 'GET', url: nextUrl })).json().handoff;
      assert.equal(named.approval.approver.email, email); assert.equal(named.approval.approver.identitySource, 'approval-event');
      const client = await b.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('UPDATE scenarios SET revision=2,body=$3 WHERE tenant_id=$1 AND id=$2', [tenant, nextScenario.id, { ...nextScenario, revision: 2 }]);
        let finished = false;
        const waiting = apps[0]!.inject({ method: 'GET', url: nextUrl + '?approval=required' }).then(r => { finished = true; return r; });
        await new Promise(r => setTimeout(r, 60)); assert.equal(finished, false);
        await client.query('COMMIT');
        assert.equal((await waiting).statusCode, 409);
      } finally { await client.query('ROLLBACK'); client.release(); }
      // Missing scenario is historical evidence, never approval. The original
      // approval constraints survive without inventing a current scenario.
      await a.pool.query('DELETE FROM scenarios WHERE tenant_id=$1 AND id=$2', [tenant, nextScenario.id]);
      const orphan = (await apps[1]!.inject({ method: 'GET', url: nextUrl })).json().handoff;
      assert.equal(orphan.status, 'Superseded'); assert.equal(orphan.currentScenarioRevision, null);
      assert.equal(orphan.constraints.scenarioEvidence, 'approval-event');
      assert.equal((await apps[0]!.inject({ method: 'GET', url: nextUrl + '?approval=required' })).statusCode, 409);
    } finally { held?.resolve(); await Promise.all(apps.map(app => app.close())); await Promise.all([a.close(), b.close()]); }
  });
