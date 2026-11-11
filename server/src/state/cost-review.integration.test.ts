import {fleetUtilization} from '../fleet-utilization.js';
import type {Plan} from '../types.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {StatefulStore} from './postgres.js';
import {createStatefulApi} from './api.js';
import {manualFixture} from './manual-fixture.js';
import type {ManualDatasetContext} from '../plan/manual-adapter.js';
import {mapSolutionToPlan} from '../plan/mapper.js';
import {tariffIdentity} from '../cost.js';
import type {StatefulAuthService} from './auth.js';
import type {CostReview} from '../cost-review-contract.js';

test('cost and fleet inspection on two APIs is immutable, tenant-scoped and available to Reviewer without native work',{skip:!process.env.CURSUS_TEST_DATABASE_URL},async()=>{
 const stores=[new StatefulStore(process.env.CURSUS_TEST_DATABASE_URL!),new StatefulStore(process.env.CURSUS_TEST_DATABASE_URL!)],a=stores[0]!,tenant='cost-'+randomUUID(),foreign='foreign-'+randomUUID(),userId=randomUUID(),f=manualFixture();
 const settings:Omit<ManualDatasetContext,'day'>={...f.context,tariff:{...f.context.tariff,source:'external' as const,perKmByClass:{SEMI:11,TRAILER:99},fixedByClass:{SEMI:101,TRAILER:999}}};
 for(const info of settings.vehicleInfo.values())info.vehicleClass='SEMI_TRAILER';
 const make=(id:string)=>{const p=mapSolutionToPlan({fleet:{vehicles:f.context.day.request.vehicles,complete:true,excludedVehicleIds:[42]},day:f.context.day,request:f.context.day.request,solution:f.context.day.solution,enrichment:f.context.day.enrichment,vehicleInfo:settings.vehicleInfo,tariff:settings.tariff,scenarioId:f.scenario.id,scenarioRevision:1,planId:id,source:'live',createdAt:'2026-10-26T00:00:00Z'});p.provenance.tariffSha256=tariffIdentity(settings.tariff);return p;};
 const plan=make('cost-plan');await a.migrate();await a.ensureTenant(tenant,'Cost fixture');await a.ensureTenant(foreign,'Foreign fixture');await a.createScenario(tenant,f.scenario.id,f.scenario);
 await a.pool.query('INSERT INTO users(id,email) VALUES($1,$2)',[userId,`cost-${userId}@example.test`]);
 await a.pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'reviewer'),($3,$2,'reviewer')",[tenant,userId,foreign]);
 const save=async(p:typeof plan)=>a.pool.query('INSERT INTO plans(tenant_id,id,scenario_id,scenario_revision,body) VALUES($1,$2,$3,$4,$5)',[tenant,p.id,p.scenarioId,p.scenarioRevision,p]);await save(plan);
 const auth=(scope:string)=>({initialize:async()=>{},authenticate:async()=>({userId,tenantId:scope,email:'cost@example.test',role:(await a.pool.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2',[scope,userId])).rows[0].role}),recordAccessAudit:async()=>{}} as unknown as StatefulAuthService);
 let loads=0;const apps=await Promise.all(stores.map(store=>createStatefulApi({store,tenantId:tenant,tenantName:'Costs',auth:auth(tenant),publicOrigin:'https://cost.test',fleetSettings:settings,manualPlanning:async()=>{loads++;throw Error('Cost inspection must not load private matrices');}})));
 const outsider=await createStatefulApi({store:a,tenantId:foreign,tenantName:'Foreign',auth:auth(foreign),publicOrigin:'https://cost.test'});
 const headers={origin:'https://cost.test',cookie:'cursus_session=fixture'},url=`/api/plans/${plan.id}/cost-breakdown`;
 const digest=async()=>JSON.stringify((await a.pool.query('SELECT body FROM plans WHERE tenant_id=$1 ORDER BY id',[tenant])).rows);
 try{
  const before=await digest();
  const fleetReads=await Promise.all(apps.map(app=>app.inject({method:'GET',url:`/api/plans/${plan.id}?geometry=stored`,headers})));
  for(const response of fleetReads){assert.equal(response.statusCode,200);assert.equal(response.headers['cache-control'],'private, no-store');const saved=response.json<Plan>();const use=fleetUtilization(saved);assert.equal(use.inventory,'complete');assert.equal(use.excluded,1);assert.equal(use.unusedAvailable,0);assert.equal(saved.provenance.fleet!.planId,plan.id);}
  assert.deepEqual(fleetReads[0]!.json(),fleetReads[1]!.json());
  assert.equal((await outsider.inject({method:'GET',url:`/api/plans/${plan.id}?geometry=stored`,headers})).statusCode,404);
  const responses=await Promise.all(apps.map(app=>app.inject({method:'GET',url,headers})));
  for(const response of responses){assert.equal(response.statusCode,200);assert.equal(response.headers['cache-control'],'private, no-store');const r=response.json<CostReview>();assert.equal(r.status,'verified');assert.equal(r.evidence,'saved_rates');assert.equal(r.total,plan.cost!.total);assert.equal(r.vehicles[0]!.rates!.perKm,11);}
  assert.deepEqual(responses[0]!.json(),responses[1]!.json());assert.equal(await digest(),before);assert.equal(loads,0);
  assert.equal((await outsider.inject({method:'GET',url,headers})).statusCode,404);assert.equal((await apps[0]!.inject({method:'GET',url:'/api/plans/missing/cost-breakdown',headers})).statusCode,404);
  settings.tariff={...settings.tariff,perKmDefault:50};
  const stale=(await apps[1]!.inject({method:'GET',url,headers})).json<CostReview>();assert.equal(stale.status,'verified');assert.equal(stale.tariffFreshness,'changed');assert.equal(stale.total,plan.cost!.total);assert.equal(await digest(),before);
  await a.pool.query("UPDATE memberships SET role='planner' WHERE tenant_id=$1 AND user_id=$2",[tenant,userId]);
  const changed=await apps[1]!.inject({method:'POST',url:`/api/scenarios/${f.scenario.id}/edit`,headers:{...headers,'if-match':'"1"'},payload:{edit:{op:'removeVehicle',vehicleId:7}}});assert.equal(changed.statusCode,200);
  await a.pool.query("UPDATE memberships SET role='reviewer' WHERE tenant_id=$1 AND user_id=$2",[tenant,userId]);
  const oldFleet=(await apps[1]!.inject({method:'GET',url:`/api/plans/${plan.id}?geometry=stored`,headers})).json<Plan>();assert.deepEqual(oldFleet.provenance.fleet,plan.provenance.fleet);assert.equal(fleetUtilization(oldFleet).excluded,1);assert.equal(fleetUtilization(oldFleet).vehicles.find(v=>v.id===7)!.availability,'available');
  const observed=(await apps[0]!.inject({method:'GET',url,headers})).json<CostReview>();assert.equal(observed.scenarioRevision,1);assert.equal(observed.currentScenarioRevision,2);assert.equal(await digest(),before);
  settings.tariff={...settings.tariff,perKmByClass:{},fixedByClass:{}};const legacy=make('cost-legacy');delete legacy.provenance.costing;await save(legacy);
  const read=async()=>{const response=await apps[0]!.inject({method:'GET',url:`/api/plans/${legacy.id}/cost-breakdown`,headers});assert.equal(response.statusCode,200);return response.json<CostReview>();};
  assert.equal((await read()).evidence,'matched_tariff');assert.equal((await read()).status,'verified');
  settings.tariff={...settings.tariff,currency:'EUR'};assert.equal((await read()).status,'partial');assert.equal((await read()).currency,'HUF');assert.equal((await read()).tariffFreshness,'changed');assert.ok((await read()).vehicles.every(v=>v.rates===null));
  assert.equal(loads,0);for(const table of ['jobs','datasets','email_outbox'])assert.equal((await a.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id=$1`,[tenant])).rows[0].n,0);
 }finally{await outsider.close();await Promise.all(apps.map(app=>app.close()));await Promise.all(stores.map(s=>s.close()));}
});
