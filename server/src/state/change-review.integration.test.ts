import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {StatefulStore} from './postgres.js';
import {createStatefulApi} from './api.js';
import {manualFixture} from './manual-fixture.js';
import type {StatefulAuthService} from './auth.js';
import type {Scenario} from '../store.js';
test('two replicas serialize exact Undo and reject stale or unauthorized intent',{skip:!process.env.CURSUS_TEST_DATABASE_URL},async()=>{
 const stores=[new StatefulStore(process.env.CURSUS_TEST_DATABASE_URL!),new StatefulStore(process.env.CURSUS_TEST_DATABASE_URL!)];
 const tenant='undo-'+randomUUID(),userId=randomUUID(),f=manualFixture(),sha='a'.repeat(64);
 const scenario:Scenario={...f.scenario,selectedPlanId:f.parent.id,deliveryDatasetSha256:sha,pins:[{orderNo:'REPEAT',requestId:91,vehicleId:7},{orderNo:'REPEAT',requestId:92,vehicleId:42}]};
 await stores[0]!.migrate();await stores[0]!.ensureTenant(tenant,'Undo fixture');await stores[0]!.createScenario(tenant,scenario.id,scenario);
 await stores[0]!.pool.query('INSERT INTO users(id,email) VALUES($1,$2)',[userId,`undo-${userId}@example.test`]);
 await stores[0]!.pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'planner')",[tenant,userId]);
 await stores[0]!.pool.query('INSERT INTO plans(tenant_id,id,scenario_id,scenario_revision,body) VALUES($1,$2,$3,$4,$5)',[tenant,f.parent.id,scenario.id,scenario.revision,f.parent]);
 const originalPlan=JSON.stringify(await stores[0]!.getPlan(tenant,f.parent.id));
 const auth={initialize:async()=>{},authenticate:async()=>({userId,tenantId:tenant,email:'undo@example.test',role:(await stores[0]!.pool.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2',[tenant,userId])).rows[0].role}),recordAccessAudit:async()=>{}} as unknown as StatefulAuthService;
 const apps=await Promise.all(stores.map(store=>createStatefulApi({store,tenantId:tenant,tenantName:'Undo fixture',auth,publicOrigin:'https://undo.test'})));
 const headers=(revision:number)=>({origin:'https://undo.test',cookie:'cursus_session=fixture','if-match':`"${revision}"`});
 const url=`/api/scenarios/${scenario.id}/undo-instruction`,payload={instruction:{op:'pin',...scenario.pins[0]!},datasetSha256:sha};
 try{
  assert.equal((await apps[0]!.inject({method:'POST',url,headers:{origin:'https://undo.test',cookie:'cursus_session=fixture'},payload})).statusCode,428);
  const race=await Promise.all(apps.map(app=>app.inject({method:'POST',url,headers:headers(1),payload})));assert.deepEqual(race.map(r=>r.statusCode).sort(),[200,409]);
  const after=await stores[0]!.getScenario(tenant,scenario.id);assert.equal(after!.revision,2);assert.equal(after!.selectedPlanId,f.parent.id);assert.deepEqual(after!.pins,[scenario.pins[1]]);
  assert.equal((await apps[1]!.inject({method:'POST',url,headers:headers(2),payload})).statusCode,409);
  const second={instruction:{op:'pin',...scenario.pins[1]!},datasetSha256:sha};
  assert.equal((await apps[1]!.inject({method:'POST',url,headers:headers(2),payload:{...second,datasetSha256:'b'.repeat(64)}})).statusCode,409);
  assert.equal((await apps[1]!.inject({method:'POST',url:`/api/scenarios/${scenario.id}/edit`,headers:headers(2),payload:{edit:{op:'removeVehicle',vehicleId:99}}})).statusCode,200);
  assert.equal((await apps[0]!.inject({method:'POST',url,headers:headers(2),payload:second})).statusCode,409);
  await stores[0]!.pool.query("UPDATE memberships SET role='reviewer' WHERE tenant_id=$1 AND user_id=$2",[tenant,userId]);
  assert.equal((await apps[0]!.inject({method:'POST',url,headers:headers(3),payload:second})).statusCode,403);
  assert.equal((await stores[0]!.getScenario(tenant,scenario.id))!.revision,3);assert.equal(await stores[0]!.getScenario('other-tenant',scenario.id),null);
  assert.equal(JSON.stringify(await stores[1]!.getPlan(tenant,f.parent.id)),originalPlan,'saved result, cost and KPIs must remain unchanged');
 }finally{await Promise.all(apps.map(app=>app.close()));await Promise.all(stores.map(store=>store.close()));}
});
