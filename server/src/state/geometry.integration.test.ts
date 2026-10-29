import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {StatefulStore} from './postgres.js';
import {createStatefulApi} from './api.js';
import {validPlan} from './plan-workflow.test.js';

test('stored plan snapshots bypass stalled road enrichment and remain tenant-scoped, uncached and immutable',{
 skip:!process.env.CURSUS_TEST_DATABASE_URL,timeout:10000},async()=>{
 const store=new StatefulStore(process.env.CURSUS_TEST_DATABASE_URL!),tenant='snapshot-'+randomUUID(),plan=validPlan();
 await store.migrate();await store.ensureTenant(tenant,'Public snapshot test');
 await store.createScenario(tenant,plan.scenarioId,{id:plan.scenarioId,revision:1,kind:'copy',day:plan.day});
 await store.pool.query('INSERT INTO plans(tenant_id,id,scenario_id,scenario_revision,body) VALUES($1,$2,$3,1,$4)',[tenant,plan.id,plan.scenarioId,plan]);
 let started!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>{started=r;}),blocked=new Promise<void>(r=>{release=r;});let calls=0;
 const app=await createStatefulApi({store,tenantId:tenant,tenantName:'Snapshot',geometryLoader:async p=>{calls++;started();await blocked;p.vehicles[0]!.trips[0]!.geometry={type:'LineString',coordinates:[[19,47],[19.1,47.1]]};return true;}});
 const foreign=await createStatefulApi({store,tenantId:'foreign-'+tenant,tenantName:'Foreign'});
 let pending:Promise<unknown>|undefined;
 try{
  pending=app.inject({method:'GET',url:`/api/plans/${plan.id}`}).then(r=>{assert.equal(r.statusCode,200);assert.ok(r.json().vehicles[0].trips[0].geometry);});
  await entered;
  const fast=app.inject({method:'GET',url:`/api/plans/${plan.id}?geometry=stored`});let timer:ReturnType<typeof setTimeout>|undefined;
  const response=await Promise.race([fast,new Promise<never>((_r,reject)=>{timer=setTimeout(()=>reject(Error('snapshot waited for road enrichment')),1000);})]).finally(()=>clearTimeout(timer));
  assert.equal(response.statusCode,200);assert.match(response.headers['cache-control']!,/private, no-store/);assert.equal(response.json().id,plan.id);assert.equal(calls,1);
  assert.equal(response.json().vehicles[0].trips[0].geometry,undefined);
  assert.equal((await app.inject({method:'GET',url:`/api/plans/${plan.id}?geometry=unknown`})).statusCode,400);
  assert.equal((await foreign.inject({method:'GET',url:`/api/plans/${plan.id}?geometry=stored`})).statusCode,404);
  release();await pending;
  const stored=(await store.pool.query('SELECT body FROM plans WHERE tenant_id=$1 AND id=$2',[tenant,plan.id])).rows[0].body;
  assert.deepEqual(stored,plan);
 }finally{release();await pending;await app.close();await foreign.close();await store.close();}
});
