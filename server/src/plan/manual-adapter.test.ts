import test from 'node:test';
import assert from 'node:assert/strict';
import { manualFixture } from '../state/manual-fixture.js';
import { prepareManualInput, evaluateManualInput, materializeManualPlan } from './manual-adapter.js';
import { applyManualBatch } from './manual.js';
import { parseManualRequest } from '../state/manual.js';
import { createStatefulApi } from '../state/api.js';
import type { StatefulStore } from '../state/postgres.js';

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
