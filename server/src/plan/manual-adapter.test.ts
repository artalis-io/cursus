import test from 'node:test';
import assert from 'node:assert/strict';
import { manualFixture } from '../state/manual-fixture.js';
import { prepareManualInput, evaluateManualInput, materializeManualPlan } from './manual-adapter.js';
import { applyManualBatch } from './manual.js';
import { parseManualRequest } from '../state/manual.js';
import { createStatefulApi } from '../state/api.js';
import type { StatefulStore } from '../state/postgres.js';
import { manualSettings, applyFleetSettings,fleetPolicyBlockers } from '../state/manual-settings.js';
import { tariffIdentity } from '../cost.js';
import { verifiedSharedAccessReferences } from '../data/dataset.js';

test('adapter maps stable IDs and materializes coherent manual plan, provenance and KPIs', () => {
  const {parent,scenario,context}=manualFixture();
  const input=prepareManualInput(parent,scenario,context), original=input.layout;
  input.layout=applyManualBatch(original,{operationId:'move',datasetSha256:input.datasetSha256,commands:[{op:'deassign',requestId:91}]},
    {actorId:'local',at:'2026-10-26T00:00:00Z'});
  const evaluation=evaluateManualInput(input,original,scenario);
  const plan=materializeManualPlan(parent,{...scenario,revision:2},input,evaluation,context,'new','2026-10-26T00:00:00Z');
  assert.deepEqual(plan.stats,{totalOrders:2,servedOrders:1,deliveryStops:1,vehiclesUsed:1,trips:1,totalDistanceKm:4,solveElapsedSeconds:null});
  assert.equal(plan.cost?.total,1040); assert.equal(plan.unassigned[0]?.reason,'Manually unassigned');
  assert.equal(plan.unassigned[0]?.requestId,91); assert.equal(plan.vehicles[0]?.trips[0]?.stops[0]?.requestId,92);
  assert.equal(plan.provenance.termination,'MANUAL'); assert.equal(plan.manual?.parentPlanId,parent.id);
  assert.equal(plan.scenarioRevision,2); assert.equal(plan.provenance.validation.valid,true);
  assert.equal(parent.unassigned.length,0);
});

test('stale, wrong-day, missing source, policy mismatch and missing fleet evidence fail closed', () => {
  const changes: ((fixture:ReturnType<typeof manualFixture>)=>void)[]=[
    x=>{x.parent.scenarioRevision=0;}, x=>{x.parent.day='2026-10-27';},
    x=>{delete x.parent.provenance.datasetSha256;}, x=>{x.context.day.datasetRequestSha256='b'.repeat(64);},
    x=>{x.context.reloadSeconds.delete(42);}, x=>{x.context.vehicleInfo.clear();},
    x=>{x.context.day.enrichment.clear();}, x=>{x.parent.vehicles[0]!.trips[0]!.stops[0]!.requestId=999;},
  ];
  for (const change of changes) {const f=manualFixture();change(f);assert.throws(()=>prepareManualInput(f.parent,f.scenario,f.context));}
});

test('historical labels accepted only when unique, duplicate references never guessed', () => {
  const f=manualFixture(); delete f.parent.vehicles[0]!.trips[0]!.stops[0]!.requestId;
  assert.doesNotThrow(()=>prepareManualInput(f.parent,f.scenario,f.context));
  f.context.day.request.tasks[1]!.ref='ORDER-1';
  assert.throws(()=>prepareManualInput(f.parent,f.scenario,f.context),/identity|evidence/);
});

test('duplicate labels need stable request identities and independently agreeing source access facts',()=>{
  const f=manualFixture();f.context.day.request.tasks[1]!.ref='ORDER-1';
  f.parent.vehicles[0]!.trips[0]!.stops[1]!.orderNo='ORDER-1';
  assert.throws(()=>prepareManualInput(f.parent,f.scenario,f.context),/access evidence/);
  const records=[{order_no:'ORDER-1',special_req:'7,5t',requires_tail_lift:true},{order_no:'ORDER-1',special_req:'7,5t',requires_tail_lift:true}];
  f.context.day.verifiedSharedAccessRefs=verifiedSharedAccessReferences(records);
  assert.ok(f.context.day.verifiedSharedAccessRefs.has('ORDER-1'));
  assert.doesNotThrow(()=>prepareManualInput(f.parent,f.scenario,f.context));
  delete f.parent.vehicles[0]!.trips[0]!.stops[1]!.requestId;
  assert.throws(()=>prepareManualInput(f.parent,f.scenario,f.context),/identity/);
  records[1]!.special_req='3,5t';
  assert.equal(verifiedSharedAccessReferences(records).has('ORDER-1'),false);
});

test('parent locks and scenario sequences are checked before manual validation', () => {
  const f=manualFixture(); f.scenario.sequences=[{vehicleId:7,orderNos:['ORDER-1','ORDER-2'],locked:true}];
  const input=prepareManualInput(f.parent,f.scenario,f.context), original=structuredClone(input.layout);
  assert.equal(evaluateManualInput(input,original,f.scenario).validation.valid,true);
  input.layout.routes[0]!.requestIds.reverse();
  assert.throws(()=>evaluateManualInput(input,original,f.scenario),/locked/);
});

test('native precedence is checked after deterministic schedule calculation', () => {
  const f=manualFixture(); f.context.day.request.precedences=[{before:92,after:91}];
  const input=prepareManualInput(f.parent,f.scenario,f.context);
  assert.equal(evaluateManualInput(input,input.layout,f.scenario).validation.valid,false);
});

test('untrusted API batch rejects extra fields, unknown operations and unsafe positions', () => {
  const valid={parentPlanId:'parent',batch:{operationId:'op',datasetSha256:'a'.repeat(64),commands:[{op:'deassign',requestId:91}]}};
  assert.deepEqual(parseManualRequest(valid),valid);
  for(const payload of [null,{}, {...valid,actorId:'forged'}, {...valid,batch:{...valid.batch,commands:[]}},
    {...valid,batch:{...valid.batch,commands:[{op:'approve',requestId:91}]}},
    {...valid,batch:{...valid.batch,commands:[{op:'assign',requestId:91,vehicleId:7,tripId:'trip',position:-1}]}},
    {...valid,batch:{...valid.batch,commands:[{op:'deassign',requestId:91,valid:true}]}}])
    assert.throws(()=>parseManualRequest(payload));
});

test('new publication API is disabled unless explicitly configured by the server', async () => {
  const store={ensureTenant:async()=>{}} as unknown as StatefulStore;
  const app=await createStatefulApi({store,tenantId:'fixture',tenantName:'Fixture'});
  try {
    const response=await app.inject({method:'POST',url:'/api/scenarios/unknown/manual-plan',payload:{}});
    assert.equal(response.statusCode,503);
    assert.equal(response.json().error,'Manual planning is not enabled.');
  }finally{await app.close();}
});

test('external manual settings fail closed and tariff identity is canonical across replicas',()=>{
  const {context}=manualFixture();
  const settings={tariff:context.tariff,vehicles:[{id:7,ref:'V-7',vehicleClass:null,isSubcontractor:false,tonnage:12,hasTailLift:true,reloadSec:120}]};
  assert.equal(manualSettings(settings).vehicleInfo.get('V7')?.tonnage,12);
  for(const bad of [null,{...settings,vehicles:[]},{...settings,vehicles:[...settings.vehicles,...settings.vehicles]},
    {...settings,vehicles:[{...settings.vehicles[0],reloadSec:-1}]},{...settings,tariff:{...settings.tariff,perKmDefault:-1}},
    {...settings,vehicles:[{...settings.vehicles[0],hasTailLift:undefined}]},{...settings,tariff:{...settings.tariff,currency:'invalid'}}])assert.throws(()=>manualSettings(bad));
  const reordered=Object.fromEntries(Object.entries(settings.tariff).reverse()) as unknown as typeof settings.tariff;
  assert.equal(tariffIdentity(reordered),tariffIdentity(settings.tariff));
  assert.notEqual(tariffIdentity({...settings.tariff,perKmDefault:123}),tariffIdentity(settings.tariff));
});

test('manual settings drift cannot silently reprice a saved draft or change capability evidence',()=>{
  for(const change of [(f:ReturnType<typeof manualFixture>)=>{f.context.tariff.perKmDefault++;},
    (f:ReturnType<typeof manualFixture>)=>{f.context.vehicleInfo.get('V7')!.hasTailLift=false;},
    (f:ReturnType<typeof manualFixture>)=>{f.context.reloadSeconds.set(7,999);}]) {
    const f=manualFixture();
    f.scenario.manualDecisions={datasetSha256:'a'.repeat(64),decisions:{},tariff:structuredClone(f.context.tariff),
      tariffSha256:tariffIdentity(f.context.tariff),fleetInfo:structuredClone([...f.context.vehicleInfo]),reloadSeconds:[...f.context.reloadSeconds]};
    assert.doesNotThrow(()=>prepareManualInput(f.parent,f.scenario,f.context));
    change(f);
    assert.throws(()=>prepareManualInput(f.parent,f.scenario,f.context),/settings changed/);
  }
});

test('unverified fleet entries remain unavailable and unknown GVW is never inferred from cargo capacity',()=>{
  const f=manualFixture();
  const settings={datasetSha256:'a'.repeat(64),tariff:f.context.tariff,vehicles:f.context.day.request.vehicles.map(v=>({id:v.id,ref:v.ref,
    vehicleClass:null,isSubcontractor:false,tonnage:v.id===42?null:12,hasTailLift:v.id!==42,reloadSec:120,available:v.id!==42}))};
  const parsed=manualSettings(settings);
  assert.deepEqual(parsed.unavailableVehicleIds,[42]);
  const request=structuredClone(f.context.day.request),v=request.vehicles.find(v=>v.id===42)!;
  delete v.gross_weight_kg;delete v.has_tail_lift;
  assert.equal(applyFleetSettings(request,'a'.repeat(64),parsed),true);
  assert.equal(v.gross_weight_kg,0);assert.equal(v.has_tail_lift,false);
  const before=structuredClone(request);
  assert.equal(applyFleetSettings(request,'b'.repeat(64),parsed),false);assert.deepEqual(request,before);
  assert.throws(()=>manualSettings({...settings,vehicles:[{...settings.vehicles[0],available:'yes'}]}));
  assert.throws(()=>manualSettings({...settings,datasetSha256:'wrong'}));
  const context={...parsed,day:{...f.context.day,request}};
  const input=prepareManualInput(f.parent,f.scenario,context);
  assert.ok(input.layout.excludedVehicleIds.includes(42));
  assert.throws(()=>applyManualBatch(input.layout,{operationId:'unavailable',datasetSha256:'a'.repeat(64),commands:[{op:'assign',requestId:91,vehicleId:42,tripId:'new',position:0}]},
    {actorId:'planner',at:'2026-10-27T00:00:00Z'}),/excluded/);
});

test('fleet policy validates all identities and existing explicit evidence before any mutation',()=>{
  const f=manualFixture();
  for(const change of [(context:typeof f.context)=>{context.vehicleInfo.get('V42')!.tonnage=40;},
    (context:typeof f.context)=>{context.reloadSeconds.delete(42);},
    (context:typeof f.context)=>{context.vehicleInfo.delete('V42');}]){
    const context=structuredClone(f.context),request=structuredClone(f.context.day.request),before=structuredClone(request);
    change(context);assert.throws(()=>applyFleetSettings(request,'a'.repeat(64),context),/Fleet settings/);assert.deepEqual(request,before);
  }
});

test('approval policy requires current fleet and tariff evidence and is scoped to its dataset',()=>{
  const f=manualFixture();f.context.datasetSha256='a'.repeat(64);
  assert.ok(fleetPolicyBlockers(f.parent,f.context).length);
  f.parent.provenance.tariffSha256=tariffIdentity(f.context.tariff);
  assert.deepEqual(fleetPolicyBlockers(f.parent,f.context),[]);
  f.context.unavailableVehicleIds=[7];assert.ok(fleetPolicyBlockers(f.parent,f.context).length);
  f.context.unavailableVehicleIds=[];f.context.vehicleInfo.get('V7')!.tonnage=40;
  assert.ok(fleetPolicyBlockers(f.parent,f.context).length);
  f.context.datasetSha256='b'.repeat(64);assert.deepEqual(fleetPolicyBlockers(f.parent,f.context),[]);
  delete f.parent.provenance.datasetSha256;assert.ok(fleetPolicyBlockers(f.parent,f.context).length);
});
