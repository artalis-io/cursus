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
    // Approval racing an edit must either fail or be immediately superseded,
    // never remain authoritative for the new revision.
    const nextScenario = { ...scenario, id: 'race-scenario' };
    const nextPlan = { ...p, id: 'race-plan', scenarioId: nextScenario.id };
    await a.createScenario(tenant, nextScenario.id, nextScenario);
    await a.pool.query('INSERT INTO plans(tenant_id,id,scenario_id,scenario_revision,body) VALUES($1,$2,$3,1,$4)', [tenant, nextPlan.id, nextScenario.id, nextPlan]);
    await workflow.transition(nextPlan.id, 'plan.review', 0, 1, true);
    const race = await Promise.allSettled([peer.transition(nextPlan.id, 'plan.approve', 1, 1, true),
      new ScenarioRepository(a, tenant).edit(nextScenario.id, [{ op: 'removeVehicle', vehicleId: 1 }], 1)]);
    assert.equal(race[1]!.status, 'fulfilled');
    assert.equal((await workflow.get(nextPlan.id)).state, 'superseded');
    await assert.rejects(() => b.enqueueJob(tenant, 'solve', 'stale-admission', {}, 10, { id: nextScenario.id, revision: 1 }));
  } finally { await Promise.all(apps.map(app => app.close())); await Promise.all([a.close(), b.close()]); }
});

test('catalogues distinguish selected/latest and use one tenant-scoped read-only snapshot across peer edits', {skip:!process.env.CURSUS_TEST_DATABASE_URL},async()=>{
 const a=new StatefulStore(process.env.CURSUS_TEST_DATABASE_URL!),b=new StatefulStore(process.env.CURSUS_TEST_DATABASE_URL!),tenant=`catalogue-${randomUUID()}`,foreign=`foreign-${randomUUID()}`;
 await a.migrate();await a.ensureTenant(tenant,'Catalogue');await b.ensureTenant(foreign,'Foreign');
 const p=validPlan(),newer={...validPlan(),id:'newer-result',createdAt:'2026-05-07T00:00:00.000Z'};
 const scenario:Scenario={id:p.scenarioId,day:'catalogue-day',kind:'copy',parentId:null,revision:1,label:'Catalogue scenario',createdAt:new Date().toISOString(),removedVehicleIds:[],pins:[],forbids:[],sequences:[],vehicleOverrides:[],selectedPlanId:p.id};
 const insert=(store:StatefulStore,t:string,plan:typeof p)=>store.pool.query('INSERT INTO plans(tenant_id,id,scenario_id,scenario_revision,body) VALUES($1,$2,$3,$4,$5)',[t,plan.id,plan.scenarioId,plan.scenarioRevision,plan]);
 await a.createScenario(tenant,scenario.id,scenario);await insert(a,tenant,p);await insert(a,tenant,newer);
 await b.createScenario(foreign,scenario.id,{...scenario,label:'NeverVisibleForeign'});await insert(b,foreign,newer);
 const own=new PlanWorkflow(a,tenant),other=new PlanWorkflow(b,foreign);
 await own.transition(p.id,'plan.review',0,1,true);await own.transition(p.id,'plan.approve',1,1,true);
 await other.transition(newer.id,'plan.review',0,1,true);await other.transition(newer.id,'plan.approve',1,1,true);
 const apps=await Promise.all([a,b].map(store=>createStatefulApi({store,tenantId:tenant,tenantName:'Catalogue'})));
 let release!:()=>void,capture!:()=>void;const held=new Promise<void>(r=>{release=r;}),captured=new Promise<void>(r=>{capture=r;});
 try{
  const response=await apps[0]!.inject('/api/plans?day=catalogue-day');assert.equal(response.statusCode,200);assert.equal(response.headers['cache-control'],'private, no-store');
  const rows=response.json();assert.equal(rows.find((r:typeof rows[number])=>r.id===p.id).identity.approval,'approved');
  assert.equal(rows.find((r:typeof rows[number])=>r.id===newer.id).identity.approval,'draft','foreign approval cannot certify same plan id');
  const sc=(await apps[1]!.inject('/api/scenarios?day=catalogue-day')).json()[0];
  assert.equal(sc.selectedResult.id,p.id);assert.equal(sc.latestResult.id,newer.id);assert.equal(sc.latest.planId,p.id,'compatibility field is preserved');
  assert.equal(sc.selectedResult.identity.selected,true);assert.equal(sc.selectedResult.identity.latest,false);assert.equal(sc.latestResult.identity.latest,true);
  assert.ok(!JSON.stringify(rows).includes('NeverVisibleForeign'));assert.deepEqual((await apps[0]!.inject('/api/plans?day=another-day')).json(),[]);
  const originalTx=a.tx.bind(a);let armed=true;
  a.tx=async<T>(fn:(client:import('pg').PoolClient)=>Promise<T>):Promise<T>=>originalTx(async client=>{
   const unbound=client.query,query=client.query.bind(client);
   client.query=(async(text:string,values?:unknown[])=>{const result=await query(text,values);if(armed&&text.startsWith('SELECT body,revision FROM scenarios')){armed=false;capture();await held;}return result;}) as typeof client.query;
   try{return await fn(client);}finally{client.query=unbound;}
  });
  const pending=apps[0]!.inject('/api/plans?day=catalogue-day').then(r=>r);await captured;
  const changed=await apps[1]!.inject({method:'POST',url:`/api/scenarios/${scenario.id}/rename`,headers:{'if-match':'"1"'},payload:{label:'Peer revision'}});assert.equal(changed.statusCode,200);
  const current={...newer,id:'current-result',scenarioRevision:2,createdAt:'2026-05-08T00:00:00.000Z'};await insert(b,tenant,current);
  const selected=await apps[1]!.inject({method:'POST',url:`/api/scenarios/${scenario.id}/select-plan`,headers:{'if-match':'"2"'},payload:{planId:current.id,selectionVersion:0,acknowledgeIncomplete:false}});assert.equal(selected.statusCode,200,selected.body);
  release();const prior=(await pending).json();assert.equal(prior.length,2);assert.equal(prior.find((r:typeof prior[number])=>r.id===p.id).identity.approval,'approved');
  assert.ok(prior.every((r:typeof prior[number])=>r.identity.scenarioRevision===1));
  const after=(await apps[0]!.inject('/api/plans?day=catalogue-day')).json();
  assert.equal(after.find((r:typeof after[number])=>r.id===p.id).identity.approval,'superseded');assert.equal(after.find((r:typeof after[number])=>r.id===p.id).identity.freshness,'stale');
  assert.equal(after.find((r:typeof after[number])=>r.id===current.id).identity.selected,true);assert.equal(after.find((r:typeof after[number])=>r.id===current.id).identity.latest,true);
  assert.equal(new Set(after.map((r:typeof after[number])=>r.identity.checkedAt)).size,1);
  const before=await b.pool.query('SELECT count(*) FROM audit_events WHERE tenant_id=$1',[tenant]);await apps[0]!.inject('/api/scenarios?day=catalogue-day');
  assert.deepEqual((await b.pool.query('SELECT count(*) FROM audit_events WHERE tenant_id=$1',[tenant])).rows,before.rows,'catalogue reads never append audit or approval events');
  await b.pool.query(`UPDATE scenarios SET body=jsonb_set(body,'{supersededBy}','{"planId":"replacement"}'::jsonb) WHERE tenant_id=$1 AND id=$2`,[tenant,scenario.id]);
  const archived=(await apps[0]!.inject('/api/plans?day=catalogue-day')).json();assert.ok(archived.every((r:typeof archived[number])=>r.identity.freshness==='archived'&&r.identity.approval!=='approved'));
 }finally{release();await Promise.all(apps.map(app=>app.close()));await Promise.all([a.close(),b.close()]);}
});
