import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {StatefulStore} from './postgres.js';
import {createStatefulApi} from './api.js';
import {manualFixture} from './manual-fixture.js';
import {ManualPlanPublisher} from './manual.js';
import type {StatefulAuthService} from './auth.js';
import type {Role} from '../roles.js';

test('guided insertion is non-publishing, permission-scoped, re-evaluated and atomic across two APIs',
 {skip:!process.env.CURSUS_TEST_DATABASE_URL},async()=>{
  const stores=[new StatefulStore(process.env.CURSUS_TEST_DATABASE_URL!),new StatefulStore(process.env.CURSUS_TEST_DATABASE_URL!)];
  const store=stores[0]!,f=manualFixture(),tenant='placement-'+randomUUID();
  await store.migrate();await store.ensureTenant(tenant,'Placements');await store.createScenario(tenant,f.scenario.id,f.scenario);
  await store.pool.query('INSERT INTO plans(tenant_id,id,scenario_id,scenario_revision,body) VALUES($1,$2,$3,1,$4)',[tenant,f.parent.id,f.scenario.id,f.parent]);
  const publisher=new ManualPlanPublisher(store,tenant,async()=>f.context);
  const partial=await publisher.publish(f.scenario.id,1,{parentPlanId:f.parent.id,batch:{operationId:'deassign',datasetSha256:'a'.repeat(64),commands:[{op:'deassign',requestId:91}]}});
  const apps=await Promise.all(stores.map(store=>createStatefulApi({store,tenantId:tenant,tenantName:'Placements',manualPlanning:async()=>f.context})));
  const request={parentPlanId:partial.id,datasetSha256:'a'.repeat(64),requestId:91},url=`/api/scenarios/${partial.scenarioId}/placements`;
  try{
    const before=await store.getScenario(tenant,partial.scenarioId),plans=(await store.listPlans(tenant)).length;
    for(const app of apps){
      assert.equal((await app.inject({method:'POST',url,payload:request})).statusCode,428);
      assert.equal((await app.inject({method:'POST',url,headers:{'if-match':'2'},payload:request})).statusCode,400);
      assert.equal((await app.inject({method:'POST',url,headers:{'if-match':'"1"'},payload:request})).statusCode,409);
      for(const body of [{...request,datasetSha256:'b'.repeat(64)},{...request,requestId:92}])
        assert.equal((await app.inject({method:'POST',url,headers:{'if-match':'"2"'},payload:body})).statusCode,409);
      assert.equal((await app.inject({method:'POST',url,headers:{'if-match':'"2"'},payload:{...request,exempt:true}})).statusCode,400);
    }
    const search=await apps[0]!.inject({method:'POST',url,headers:{'if-match':'"2"'},payload:request});assert.equal(search.statusCode,200,search.body);
    assert.equal(search.headers['cache-control'],'private, no-store');const result=search.json();assert.ok(result.suggestions.length>0);
    assert.equal((await store.listPlans(tenant)).length,plans);assert.deepEqual(await store.getScenario(tenant,partial.scenarioId),before);
    const foreign='foreign-'+randomUUID();await store.ensureTenant(foreign,'Foreign');
    const outsider=await createStatefulApi({store,tenantId:foreign,tenantName:'Foreign',manualPlanning:async()=>f.context});
    try{assert.equal((await outsider.inject({method:'POST',url,headers:{'if-match':'"2"'},payload:request})).statusCode,404);}finally{await outsider.close();}
    for(const role of ['admin','planner','reviewer'] as Role[]){
      const auth={initialize:async()=>{},authenticate:async()=>({userId:randomUUID(),tenantId:tenant,email:'role@example.test',role}),recordAccessAudit:async()=>{}} as unknown as StatefulAuthService;
      const app=await createStatefulApi({store,tenantId:tenant,tenantName:'Roles',manualPlanning:async()=>f.context,auth,publicOrigin:'https://example.test'});
      try{
        assert.equal((await app.inject({method:'POST',url,headers:{origin:'https://example.test','if-match':'"2"'},payload:request})).statusCode,role==='reviewer'?403:200);
        assert.equal((await app.inject({method:'POST',url,headers:{origin:'https://other.test','if-match':'"2"'},payload:request})).statusCode,403);
        if(role==='admin')assert.equal((await app.inject({method:'POST',url,headers:{origin:'https://example.test','if-match':'"2"',cookie:`cursus_view_as=reviewer.${createHash('sha256').update('').digest('hex')}`},payload:request})).statusCode,403);
      }finally{await app.close();}
    }
    const s=result.suggestions[0],intent={parentPlanId:partial.id,batch:{operationId:'guided-apply',datasetSha256:request.datasetSha256,
      commands:[{op:'assign',requestId:91,vehicleId:s.vehicleId,tripId:s.tripId,position:s.position}]}};
    const preview=await apps[0]!.inject({method:'POST',url:`/api/scenarios/${partial.scenarioId}/manual-preview`,headers:{'if-match':'"2"'},payload:intent});assert.equal(preview.statusCode,200);
    const applied=await apps[1]!.inject({method:'POST',url:`/api/scenarios/${partial.scenarioId}/manual-plan`,headers:{'if-match':'"2"'},payload:intent});assert.equal(applied.statusCode,201,applied.body);
    const plan=applied.json();assert.equal(plan.stats.servedOrders,2);assert.deepEqual(plan.stats,preview.json().stats);assert.equal(plan.provenance.validation.valid,true);
    assert.equal(plan.cost.total-partial.cost!.total,s.delta.cost);assert.equal(plan.manual.layout.history.at(-1).action,'assign');
    assert.equal((await apps[0]!.inject({method:'GET',url:`/api/plans/${plan.id}?geometry=stored`})).json().id,plan.id);
    assert.equal((await apps[0]!.inject({method:'POST',url,headers:{'if-match':'"2"'},payload:request})).statusCode,409);
    assert.equal((await store.listPlans(tenant)).length,plans+1);
  }finally{for(const app of apps)await app.close();for(const s of stores)await s.close();}
});

test('search concurrency is bounded and another replica editing during loading makes the result stale',
 {skip:!process.env.CURSUS_TEST_DATABASE_URL},async()=>{
  const store=new StatefulStore(process.env.CURSUS_TEST_DATABASE_URL!),f=manualFixture(),tenant='placement-race-'+randomUUID();
  await store.migrate();await store.ensureTenant(tenant,'Race');await store.createScenario(tenant,f.scenario.id,f.scenario);
  await store.pool.query('INSERT INTO plans(tenant_id,id,scenario_id,scenario_revision,body) VALUES($1,$2,$3,1,$4)',[tenant,f.parent.id,f.scenario.id,f.parent]);
  const p=await new ManualPlanPublisher(store,tenant,async()=>f.context).publish(f.scenario.id,1,{parentPlanId:f.parent.id,batch:{operationId:'unassign',datasetSha256:'a'.repeat(64),commands:[{op:'deassign',requestId:91}]}});
  let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);
  const app=await createStatefulApi({store,tenantId:tenant,tenantName:'Race',manualPlanning:async()=>{entered();await held;return f.context;}});
  const req={method:'POST' as const,url:`/api/scenarios/${p.scenarioId}/placements`,headers:{'if-match':'"2"'},payload:{parentPlanId:p.id,datasetSha256:'a'.repeat(64),requestId:91}};
  try{
    const pending=app.inject(req).then(r=>r);await ready;
    const busy=await app.inject(req);assert.equal(busy.statusCode,429);assert.equal(busy.headers['retry-after'],'2');
    const scenario=(await store.getScenario(tenant,p.scenarioId))!;scenario.revision++;
    await store.pool.query('UPDATE scenarios SET revision=$3,body=$4 WHERE tenant_id=$1 AND id=$2',[tenant,scenario.id,scenario.revision,scenario]);
    release();assert.equal((await pending).statusCode,409);
    assert.equal((await app.inject(req)).statusCode,409,'busy slot is released after failure');
    assert.equal((await store.listPlans(tenant)).length,2);
  }finally{release();await app.close();await store.close();}
});
