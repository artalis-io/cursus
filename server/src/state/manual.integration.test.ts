import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { StatefulStore } from './postgres.js';
import { createStatefulApi } from './api.js';
import { ScenarioRepository } from './scenarios.js';
import { manualFixture } from './manual-fixture.js';
import { ManualPlanPublisher } from './manual.js';
import type { StatefulAuthService } from './auth.js';
import { PlanWorkflow } from './plan-workflow.js';
import { admittedManualDatasetLoader } from './manual-dataset.js';
import { ObjectStore } from './objects.js';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { solveConvertedDataset } from './conversion.js';
import type { Lease } from './postgres.js';
import type { Scenario } from '../store.js';
import { config } from '../config.js';

test('manual publication through two real APIs is atomic, idempotent and revision fenced', { skip: !process.env.CURSUS_TEST_DATABASE_URL }, async () => {
  const a=new StatefulStore(process.env.CURSUS_TEST_DATABASE_URL!), b=new StatefulStore(process.env.CURSUS_TEST_DATABASE_URL!);
  const tenant=`manual-${randomUUID()}`, f=manualFixture();
  await a.migrate(); await a.ensureTenant(tenant,'Manual fixture');
  await a.createScenario(tenant,f.scenario.id,f.scenario);
  await a.pool.query('INSERT INTO plans(tenant_id,id,scenario_id,scenario_revision,body) VALUES($1,$2,$3,1,$4)',[tenant,f.parent.id,f.scenario.id,f.parent]);
  const apps=await Promise.all([a,b].map(store=>createStatefulApi({store,tenantId:tenant,tenantName:'Manual fixture',manualPlanning:async()=>f.context})));
  const url=`/api/scenarios/${f.scenario.id}/manual-plan`;
  const intent=(parentPlanId:string,operationId:string,requestId=91)=>({parentPlanId,batch:{operationId,datasetSha256:'a'.repeat(64),commands:[{op:'deassign',requestId}]}});
  const publish=(app:typeof apps[number],payload:ReturnType<typeof intent>,revision=1)=>app.inject({method:'POST',url,headers:{'if-match':`"${revision}"`},payload});
  try {
    assert.equal((await apps[0]!.inject({method:'POST',url,payload:intent(f.parent.id,'no-header')})).statusCode,428);
    assert.equal((await apps[0]!.inject({method:'POST',url,headers:{'if-match':'*'},payload:{}})).statusCode,400);
    const both=await Promise.all(apps.map(app=>publish(app,intent(f.parent.id,'same'))));
    assert.deepEqual(both.map(r=>r.statusCode),[201,201]);
    const plan=both[0]!.json(); assert.equal(plan.id,both[1]!.json().id);
    assert.equal(plan.stats.servedOrders,1); assert.equal(plan.cost.total,1040);
    assert.equal((await a.getScenario(tenant,f.scenario.id))?.revision,2);
    assert.equal((await publish(apps[1]!,intent(f.parent.id,'same'))).json().id,plan.id);
    assert.equal((await publish(apps[1]!,intent(f.parent.id,'same',92))).statusCode,409);
    assert.equal((await publish(apps[1]!,intent(f.parent.id,'stale'))).statusCode,409);
    assert.equal((await apps[1]!.inject({method:'GET',url:`/api/plans/${plan.id}`})).json().manual.layout.history[0].requestId,91);
    const race=await Promise.all(apps.map((app,i)=>publish(app,intent(plan.id,`race-${i}`,92),2)));
    assert.deepEqual(race.map(r=>r.statusCode).sort(),[201,409]);
    const winner=race.find(r=>r.statusCode===201)!.json();
    assert.equal(winner.stats.servedOrders,0); assert.equal(winner.cost.total,0);
    assert.equal((await new PlanWorkflow(a,tenant).get(winner.id)).state,'draft');
    assert.ok((await new PlanWorkflow(a,tenant).get(winner.id)).blockers.length>0);
    assert.equal((await apps[0]!.inject({method:'POST',url:`/api/scenarios/${f.scenario.id}/solve`,headers:{'if-match':'"3"'},payload:{}})).statusCode,202);
    await a.pool.query('DELETE FROM jobs WHERE tenant_id=$1',[tenant]);
    const counts=await a.pool.query("SELECT (SELECT count(*) FROM plans WHERE tenant_id=$1) plans,(SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action='plan.manual') receipts",[tenant]);
    assert.equal(Number(counts.rows[0].plans),3); assert.equal(Number(counts.rows[0].receipts),2);
    // Another tenant cannot resolve parent IDs or replay receipts.
    const foreign=`foreign-${randomUUID()}`; await a.ensureTenant(foreign,'Foreign');
    await assert.rejects(()=>new ManualPlanPublisher(a,foreign,async()=>f.context).publish(f.scenario.id,1,intent(f.parent.id,'same') as never),/not found/);
    // Inject a failure at the FINAL audit insert (FK): scenario/plan must roll back.
    const current=(await a.getScenario(tenant,f.scenario.id))!;
    const savedCount=(await a.listPlans(tenant)).length;
    await assert.rejects(()=>new ManualPlanPublisher(a,tenant,async()=>f.context).publish(current.id,current.revision,
      intent(winner.id,'rollback') as never,{userId:randomUUID(),tenantId:tenant,email:'invalid@fixture.test',role:'planner'}));
    assert.equal((await b.getScenario(tenant,current.id))!.revision,current.revision);
    assert.equal((await b.listPlans(tenant)).length,savedCount);
  } finally {await Promise.all(apps.map(app=>app.close()));await Promise.all([a.close(),b.close()]);}
});

test('manual API rejects Reviewer, Admin View-as Reviewer and CSRF before loading data', {skip:!process.env.CURSUS_TEST_DATABASE_URL},async()=>{
  const store=new StatefulStore(process.env.CURSUS_TEST_DATABASE_URL!),tenant=`roles-${randomUUID()}`;
  let loads=0, role:'admin'|'planner'|'reviewer'='reviewer';
  const auth={ initialize:async()=>{}, authenticate:async()=>({userId:randomUUID(),tenantId:tenant,email:'public@fixture.test',role}),
    recordAccessAudit:async()=>{} } as unknown as StatefulAuthService;
  const app=await createStatefulApi({store,tenantId:tenant,tenantName:'Roles',auth,publicOrigin:'https://fixture.test',manualPlanning:async()=>{loads++;return manualFixture().context;}});
  try{
    const request={method:'POST' as const,url:'/api/scenarios/unknown/manual-plan',payload:{},headers:{origin:'https://fixture.test','if-match':'"1"',cookie:'cursus_session=test'}};
    assert.equal((await app.inject(request)).statusCode,403);
    role='admin';
    const token=createHash('sha256').update('test').digest('hex');
    assert.equal((await app.inject({...request,headers:{...request.headers,cookie:`cursus_session=test; cursus_view_as=reviewer.${token}`}})).statusCode,403);
    role='planner'; assert.equal((await app.inject({...request,headers:{...request.headers,origin:'https://evil.test'}})).statusCode,403);
    assert.equal((await app.inject(request)).statusCode,400);
    assert.equal(loads,0);
  }finally{await app.close();await store.close();}
});

test('manual preview is non-publishing; base fork, exclusion, restore and undo preserve baseline and history', {skip:!process.env.CURSUS_TEST_DATABASE_URL},async()=>{
  const store=new StatefulStore(process.env.CURSUS_TEST_DATABASE_URL!),tenant=`ui-${randomUUID()}`,f=manualFixture();
  await store.ensureTenant(tenant,'UI');f.scenario.kind='base';
  await store.createScenario(tenant,f.scenario.id,f.scenario);
  await store.pool.query('INSERT INTO plans(tenant_id,id,scenario_id,scenario_revision,body) VALUES($1,$2,$3,1,$4)',[tenant,f.parent.id,f.scenario.id,f.parent]);
  const app=await createStatefulApi({store,tenantId:tenant,tenantName:'UI',manualPlanning:async()=>f.context});
  const intent={parentPlanId:f.parent.id,vehicle:{id:7,excluded:true},batch:{operationId:'exclude',datasetSha256:'a'.repeat(64),commands:[]}};
  try{
    const capabilities=await app.inject({method:'GET',url:`/api/plans/${f.parent.id}/manual-context`});
    assert.equal(capabilities.json().fleet.length,2);
    const preview=await app.inject({method:'POST',url:`/api/scenarios/${f.scenario.id}/manual-preview`,headers:{'if-match':'"1"'},payload:intent});
    assert.equal(preview.statusCode,200,preview.body);assert.equal(preview.json().stats.servedOrders,0);
    assert.equal((await store.listPlans(tenant)).length,1);assert.equal((await store.listScenarios(tenant)).length,1);
    const applied=await app.inject({method:'POST',url:`/api/scenarios/${f.scenario.id}/manual-plan`,headers:{'if-match':'"1"'},payload:intent});
    assert.equal(applied.statusCode,201,applied.body);const excluded=applied.json();
    assert.notEqual(excluded.scenarioId,f.scenario.id);assert.equal(excluded.cost.total,0);
    assert.equal((await store.getScenario(tenant,f.scenario.id))?.revision,1);
    assert.equal(excluded.manual.layout.history.length,2);
    const undone=await app.inject({method:'POST',url:`/api/scenarios/${excluded.scenarioId}/manual-plan`,headers:{'if-match':'"2"'},payload:{parentPlanId:excluded.id,undo:true,batch:{...intent.batch,operationId:'undo'}}});
    assert.equal(undone.statusCode,201,undone.body);const restored=undone.json();
    assert.equal(restored.stats.servedOrders,2);assert.equal(restored.cost.total,1045);
    assert.ok(restored.manual.layout.history.some((e:{action:string})=>e.action==='undo'));
    assert.deepEqual((await store.getScenario(tenant,restored.scenarioId))?.removedVehicleIds,[]);
    const before=(await store.listPlans(tenant)).length;
    const stale=await app.inject({method:'POST',url:`/api/scenarios/${restored.scenarioId}/manual-plan`,headers:{'if-match':'"2"'},payload:{...intent,parentPlanId:restored.id}});
    assert.equal(stale.statusCode,409);assert.equal((await store.listPlans(tenant)).length,before);
  }finally{await app.close();await store.close();}
});

test('edit during evaluation and stale worker completion cannot supersede manual publication', {skip:!process.env.CURSUS_TEST_DATABASE_URL},async()=>{
  const a=new StatefulStore(process.env.CURSUS_TEST_DATABASE_URL!),b=new StatefulStore(process.env.CURSUS_TEST_DATABASE_URL!);
  const tenant=`edit-race-${randomUUID()}`, f=manualFixture();
  await a.ensureTenant(tenant,'Edit race'); await a.createScenario(tenant,f.scenario.id,f.scenario);
  await a.pool.query('INSERT INTO plans(tenant_id,id,scenario_id,scenario_revision,body) VALUES($1,$2,$3,1,$4)',[tenant,f.parent.id,f.scenario.id,f.parent]);
  const intent={parentPlanId:f.parent.id,batch:{operationId:'held',datasetSha256:'a'.repeat(64),commands:[{op:'deassign' as const,requestId:91}]}};
  let release!:()=>void, entered!:()=>void;
  const gate=new Promise<void>(r=>{release=r;}), seen=new Promise<void>(r=>{entered=r;});
  try{
    const publisher=new ManualPlanPublisher(a,tenant,async()=>{entered();await gate;return f.context;});
    const pending=publisher.publish(f.scenario.id,1,intent);
    await seen;
    await new ScenarioRepository(b,tenant).edit(f.scenario.id,[{op:'forbid',orderNo:'ORDER-1',vehicleId:42}],1);
    release(); await assert.rejects(()=>pending,/changed during evaluation/);
    assert.equal((await a.listPlans(tenant)).length,1);
    // Start from a fresh exact revision and manually publish while an old solve owns its lease.
    const scenario=(await b.getScenario(tenant,f.scenario.id))!;
    const parent={...f.parent,id:'revision-two',scenarioRevision:scenario.revision};
    await b.pool.query('INSERT INTO plans(tenant_id,id,scenario_id,scenario_revision,body) VALUES($1,$2,$3,$4,$5)',[tenant,parent.id,scenario.id,scenario.revision,parent]);
    const job=await a.enqueueJob(tenant,'solve','old-solve',{});
    await a.pool.query("UPDATE jobs SET state='running',lease_owner='old',lease_expires_at=now()+interval '60 seconds',fence=1 WHERE tenant_id=$1 AND id=$2",[tenant,job]);
    const plan=await new ManualPlanPublisher(b,tenant,async()=>f.context).publish(scenario.id,scenario.revision,{...intent,parentPlanId:parent.id,batch:{...intent.batch,operationId:'current'}});
    await assert.rejects(()=>a.completeSolve({tenantId:tenant,id:job,owner:'old',fence:1,payload:{},attempt:1},'stale-solver',scenario.id,scenario.revision,f.parent),/revision conflict/);
    assert.equal(await a.getPlan(tenant,'stale-solver'),null);
    assert.equal((await a.getScenario(tenant,scenario.id))?.manualPlanId,plan.id);
  }finally{release?.();await Promise.all([a.close(),b.close()]);}
});

test('manual publication cannot overwrite a newer current plan at the same scenario revision', {skip:!process.env.CURSUS_TEST_DATABASE_URL},async()=>{
  const store=new StatefulStore(process.env.CURSUS_TEST_DATABASE_URL!),tenant=`pointer-${randomUUID()}`,f=manualFixture();
  let release!:()=>void,entered!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;}),seen=new Promise<void>(resolve=>{entered=resolve;});
  try{
    await store.ensureTenant(tenant,'Pointer race');
    f.scenario.manualPlanId=f.parent.id;
    await store.createScenario(tenant,f.scenario.id,f.scenario);
    await store.pool.query('INSERT INTO plans(tenant_id,id,scenario_id,scenario_revision,body) VALUES($1,$2,$3,1,$4)',[tenant,f.parent.id,f.scenario.id,f.parent]);
    const publisher=new ManualPlanPublisher(store,tenant,async()=>{entered();await held;return f.context;});
    const pending=publisher.publish(f.scenario.id,1,{parentPlanId:f.parent.id,batch:{operationId:'pointer-race',datasetSha256:'a'.repeat(64),commands:[{op:'deassign',requestId:91}]}});
    await seen;
    // Model the exact same-revision pointer update performed by completeSolve.
    const newer={...f.parent,id:'new-current'};
    await store.tx(async client=>{
      await client.query('SELECT revision FROM scenarios WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenant,f.scenario.id]);
      await client.query('INSERT INTO plans(tenant_id,id,scenario_id,scenario_revision,body) VALUES($1,$2,$3,1,$4)',[tenant,newer.id,f.scenario.id,newer]);
      await client.query('UPDATE scenarios SET body=$3 WHERE tenant_id=$1 AND id=$2',[tenant,f.scenario.id,{...f.scenario,manualPlanId:newer.id}]);
    });
    release();await assert.rejects(()=>pending,/Current plan changed during evaluation/);
    assert.equal((await store.getScenario(tenant,f.scenario.id))!.manualPlanId,newer.id);
    assert.equal((await store.listPlans(tenant)).length,2);
    assert.equal(Number((await store.pool.query("SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action='plan.manual'",[tenant])).rows[0].count),0);
  }finally{release?.();await store.close();}
});

test('dataset loader reads verified tenant objects and refuses ambiguous admitted sources', {skip:!process.env.CURSUS_TEST_DATABASE_URL||!process.env.CURSUS_TEST_S3_ENDPOINT},async()=>{
  const store=new StatefulStore(process.env.CURSUS_TEST_DATABASE_URL!),tenant=`objects-${randomUUID()}`,bucket=`manual-${randomUUID()}`;
  const endpoint=process.env.CURSUS_TEST_S3_ENDPOINT!;
  const client=new S3Client({endpoint,region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:'integration',secretAccessKey:'integration'}});
  const objects=new ObjectStore(bucket,{endpoint,accessKeyId:'integration',secretAccessKey:'integration'});
  const f=manualFixture();
  try{
    await store.ensureTenant(tenant,'Objects'); await client.send(new CreateBucketCommand({Bucket:bucket}));
    const request=await objects.putImmutable(tenant,Buffer.from(JSON.stringify(f.context.day.request)),'application/json');
    const geocoded=await objects.putImmutable(tenant,Buffer.from(JSON.stringify([1,2].map(id=>({order_no:`ORDER-${id}`,delivery_date:'2026-10-26',requires_tail_lift:false})))),'application/json');
    for(const artifact of [request,geocoded]) await store.stageObject(tenant,artifact);
    const manifest={artifacts:{request,geocoded},days:[{dayId:f.scenario.day,isoDate:f.parent.day,date:'2026-10-26',label:'Public'}]};
    const load=admittedManualDatasetLoader(store,objects,tenant,f.context);
    f.parent.provenance.datasetSha256=request.sha256;
    await assert.rejects(()=>load(f.parent,f.scenario),/exactly one/);
    for(const id of ['dataset-one','dataset-two']){
      await store.createDatasetUpload(tenant,id,manifest); await store.validateDataset(tenant,id,manifest);
      await store.publishDataset(tenant,id,manifest,[request.key,geocoded.key]);
      if(id==='dataset-one'){
        const loaded=await load(f.parent,f.scenario);
        assert.equal(loaded.day.datasetRequestSha256,request.sha256);
        assert.equal(loaded.day.def.id,f.scenario.day);
      }
    }
    await assert.rejects(()=>load(f.parent,f.scenario),/exactly one/);
    await assert.rejects(()=>load(f.parent,{...f.scenario,day:'unknown'}),/exactly one/);
    const foreign=`foreign-${randomUUID()}`;await store.ensureTenant(foreign,'Foreign');
    await assert.rejects(()=>admittedManualDatasetLoader(store,objects,foreign,f.context)(f.parent,f.scenario),/exactly one/);
  }finally{client.destroy();await store.close();}
});

test('valid manual plans enter review workflow; infeasible manual drafts cannot be approved', {skip:!process.env.CURSUS_TEST_DATABASE_URL},async()=>{
  const store=new StatefulStore(process.env.CURSUS_TEST_DATABASE_URL!),tenant=`approval-${randomUUID()}`,f=manualFixture();
  await store.ensureTenant(tenant,'Approval');await store.createScenario(tenant,f.scenario.id,f.scenario);
  await store.pool.query('INSERT INTO plans(tenant_id,id,scenario_id,scenario_revision,body) VALUES($1,$2,$3,1,$4)',[tenant,f.parent.id,f.scenario.id,f.parent]);
  const publisher=new ManualPlanPublisher(store,tenant,async()=>f.context),workflow=new PlanWorkflow(store,tenant);
  const intent={parentPlanId:f.parent.id,batch:{operationId:'valid',datasetSha256:'a'.repeat(64),commands:[{op:'assign' as const,requestId:91,vehicleId:42,tripId:'new',position:0}]}};
  try{
    await workflow.transition(f.parent.id,'plan.review',0,1,true);
    await workflow.transition(f.parent.id,'plan.approve',1,1,true);
    const valid=await publisher.publish(f.scenario.id,1,intent);
    assert.equal((await workflow.get(f.parent.id)).state,'superseded');
    assert.deepEqual((await workflow.get(valid.id)).blockers,[]);
    await workflow.transition(valid.id,'plan.review',0,2,true);
    assert.equal((await workflow.get(valid.id)).state,'reviewed');
    f.context.day.request.vehicles.find(v=>v.id===42)!.capacity=[50,0];
    const invalid=await publisher.publish(f.scenario.id,2,{...intent,parentPlanId:valid.id,batch:{...intent.batch,operationId:'invalid'}});
    assert.equal(invalid.provenance.validation.valid,false);
    assert.equal(invalid.stats.servedOrders,2);
    assert.ok(invalid.provenance.validation.violations.some(v=>(v as {vehicle_id?:number}).vehicle_id===42));
    await assert.rejects(()=>workflow.transition(invalid.id,'plan.review',0,3,true),/validation|Capacity/);
    assert.equal((await workflow.get(invalid.id)).state,'draft');
  }finally{await store.close();}
});

test('real native replanning across replicas retains, releases and fences manual decisions', {
  skip:!process.env.CURSUS_TEST_DATABASE_URL||!process.env.CURSUS_TEST_S3_ENDPOINT||!process.env.CURSUS_TEST_SURGE_BIN,
},async()=>{
  const a=new StatefulStore(process.env.CURSUS_TEST_DATABASE_URL!),b=new StatefulStore(process.env.CURSUS_TEST_DATABASE_URL!);
  const tenant=`native-manual-${randomUUID()}`,bucket=`native-${randomUUID()}`,f=manualFixture();
  const endpoint=process.env.CURSUS_TEST_S3_ENDPOINT!;
  const client=new S3Client({endpoint,region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:'integration',secretAccessKey:'integration'}});
  const objects=new ObjectStore(bucket,{endpoint,accessKeyId:'integration',secretAccessKey:'integration'});
  // Test-process-only override; production configuration remains read-only.
  const testConfig=config as {surgeBin:string};
  const oldBin=testConfig.surgeBin;testConfig.surgeBin=process.env.CURSUS_TEST_SURGE_BIN!;
  const apps:Awaited<ReturnType<typeof createStatefulApi>>[]=[];
  try{
    await a.ensureTenant(tenant,'Native manual');await client.send(new CreateBucketCommand({Bucket:bucket}));
    const request=await objects.putImmutable(tenant,Buffer.from(JSON.stringify(f.context.day.request)),'application/json');
    const geocoded=await objects.putImmutable(tenant,Buffer.from(JSON.stringify([1,2].map(id=>({order_no:`ORDER-${id}`,delivery_date:'2026-10-26',requires_tail_lift:false})))),'application/json');
    for(const artifact of [request,geocoded])await a.stageObject(tenant,artifact);
    const manifest={artifacts:{request,geocoded},days:[{dayId:f.scenario.day,isoDate:f.parent.day,date:'2026-10-26',label:'Public'}]};
    await a.createDatasetUpload(tenant,'dataset',manifest);await a.validateDataset(tenant,'dataset',manifest);
    await a.publishDataset(tenant,'dataset',manifest,[request.key,geocoded.key]);
    f.parent.provenance.datasetSha256=request.sha256;
    f.scenario.pins=[{orderNo:'ORDER-1',vehicleId:7}];
    await a.createScenario(tenant,f.scenario.id,f.scenario);
    await a.pool.query('INSERT INTO plans(tenant_id,id,scenario_id,scenario_revision,body) VALUES($1,$2,$3,1,$4)',[tenant,f.parent.id,f.scenario.id,f.parent]);
    for(const store of [a,b])apps.push(await createStatefulApi({store,tenantId:tenant,tenantName:'Native manual',
      manualPlanning:admittedManualDatasetLoader(store,objects,tenant,f.context)}));
    const url=`/api/scenarios/${f.scenario.id}`;
    const changed=await apps[0]!.inject({method:'POST',url:`${url}/manual-plan`,headers:{'if-match':'"1"'},payload:{parentPlanId:f.parent.id,
      batch:{operationId:'retain',datasetSha256:request.sha256,commands:[{op:'assign',requestId:91,vehicleId:42,tripId:'new',position:0},{op:'deassign',requestId:92}]}}});
    assert.equal(changed.statusCode,201);
    assert.equal(changed.json().provenance.validation.valid,true);
    assert.deepEqual((await a.getScenario(tenant,f.scenario.id))?.pins,[]);
    const solve=async(revision:number,takeover=false)=>{
      const queued=await apps[1]!.inject({method:'POST',url:`${url}/solve`,headers:{'if-match':`"${revision}"`},payload:{budgetSec:1}});
      assert.equal(queued.statusCode,202);
      const id=queued.json().jobId as string;
      // Target only this disposable job; unrelated test leases are untouched.
      await a.pool.query("UPDATE jobs SET state='running',lease_owner='old',lease_expires_at=now()+interval '30 seconds',fence=1,attempt=1 WHERE tenant_id=$1 AND id=$2",[tenant,id]);
      const snapshot=(await a.getJob(tenant,id))!.payload as {scenario:Scenario};
      const execute=()=>solveConvertedDataset(objects,tenant,manifest,snapshot.scenario,1,'vehicles',new AbortController().signal);
      const output=await execute();
      const lease:Lease={tenantId:tenant,id,owner:'old',fence:1,attempt:1,payload:snapshot};
      if(takeover){
        await b.pool.query("UPDATE jobs SET lease_owner='new',fence=2,lease_expires_at=now()+interval '30 seconds' WHERE tenant_id=$1 AND id=$2",[tenant,id]);
        await assert.rejects(()=>a.completeSolve(lease,output.id,snapshot.scenario.id,revision,output),/stale fencing/);
        assert.equal(await a.getPlan(tenant,output.id),null);
        const winner=await execute();
        const forged=structuredClone(winner);forged.assignments!.layout.history=[];
        await assert.rejects(()=>b.completeSolve({...lease,owner:'new',fence:2},forged.id,snapshot.scenario.id,revision,forged),/provenance/);
        assert.equal((await b.getJob(tenant,id))?.state,'running');
        await b.completeSolve({...lease,owner:'new',fence:2},winner.id,snapshot.scenario.id,revision,winner);
        return winner;
      }
      await b.completeSolve(lease,output.id,snapshot.scenario.id,revision,output);return output;
    };
    const retained=await solve(2);
    assert.equal(retained.vehicles.find(v=>v.id===42)?.trips.flatMap(t=>t.stops).some(s=>s.requestId===91),true);
    assert.equal(retained.unassigned.find(o=>o.requestId===92)?.reasonCode,'MANUAL_UNASSIGNED');
    assert.equal(retained.assignments?.layout.history.length,2);
    assert.equal((await a.getScenario(tenant,f.scenario.id))?.manualPlanId,retained.id);
    assert.equal((await apps[0]!.inject({method:'GET',url:`/api/plans/${retained.id}`})).json().assignments.layout.decisions['91'].vehicleId,42);
    const released=await apps[0]!.inject({method:'POST',url:`${url}/manual-plan`,headers:{'if-match':'"2"'},payload:{parentPlanId:retained.id,
      batch:{operationId:'release',datasetSha256:request.sha256,commands:[{op:'release',requestId:92}]}}});
    assert.equal(released.statusCode,201,released.body);
    const replanned=await solve(3,true);
    assert.equal(replanned.stats.servedOrders,2);assert.equal(replanned.unassigned.length,0);
    assert.equal(replanned.assignments?.layout.decisions['92'],undefined);
    assert.equal(replanned.assignments?.layout.history.length,3);
    assert.equal(replanned.manual,undefined);assert.equal(replanned.provenance.validation.valid,true);
    assert.equal((await apps[1]!.inject({method:'GET',url:`/api/plans/${replanned.id}`})).json().assignments.layout.history.length,3);
  }finally{testConfig.surgeBin=oldBin;await Promise.all(apps.map(app=>app.close()));client.destroy();await Promise.all([a.close(),b.close()]);}
});
