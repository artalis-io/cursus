import test from 'node:test';
import assert from 'node:assert/strict';
import { manualFixture } from '../state/manual-fixture.js';
import { prepareManualInput, evaluateManualInput } from './manual-adapter.js';
import { applyManualBatch } from './manual.js';
import { manualTripKey } from './manual-evaluate.js';
import { suggestPlacements } from './manual-suggestions.js';

function fixture(){
  const f=manualFixture(),input=prepareManualInput(f.parent,f.scenario,f.context);
  input.layout=applyManualBatch(input.layout,{operationId:'deassign',datasetSha256:input.datasetSha256,commands:[{op:'deassign',requestId:91}]},
    {actorId:'fixture',at:new Date(0).toISOString()});
  return {...f,input};
}
const identity={parentPlanId:'manual-parent',newTripId:'suggestion-test'};

test('placements independently reproduce preview metrics, rank per vehicle and never mutate source',async()=>{
  const f=fixture(),before=structuredClone(f.input),baseline=evaluateManualInput(f.input,f.input.layout,f.scenario);
  const result=await suggestPlacements(f.input,f.scenario,91,identity);
  assert.equal(result.complete,true);assert.ok(result.feasiblePositions>0);
  assert.deepEqual(f.input,before);assert.deepEqual(result.suggestions.map(s=>s.vehicleId),[7,42]);
  assert.ok(result.suggestions[1]!.delta.cost>result.suggestions[0]!.delta.cost,'unused vehicle standing cost counted');
  for(const s of result.suggestions){
    const layout=applyManualBatch(f.input.layout,{operationId:'independent',datasetSha256:f.input.datasetSha256,
      commands:[{op:'assign',requestId:91,vehicleId:s.vehicleId,tripId:s.tripId,position:s.position}]},{actorId:'test',at:new Date(0).toISOString()});
    const departures=new Map(f.input.departures);if(s.newTrip)departures.set(manualTripKey(s.vehicleId,s.tripId),0);
    const out=evaluateManualInput({...f.input,layout,departures},f.input.layout,f.scenario);
    assert.equal(out.validation.valid,true);assert.equal(out.stats.servedOrders,2);
    assert.equal(s.delta.cost,out.cost.total-baseline.cost.total);
    assert.equal(s.delta.distanceKm,out.stats.totalDistanceKm-baseline.stats.totalDistanceKm);
  }
});

test('excluded and locked vehicles have no suggestions, even if otherwise feasible',async()=>{
  const f=fixture();f.input.layout.excludedVehicleIds=[42];f.input.layout.lockedVehicleIds=[7];
  const r=await suggestPlacements(f.input,f.scenario,91,identity);
  assert.deepEqual(r.suggestions,[]);assert.equal(r.checked,0);
  assert.deepEqual(r.vehicles.map(v=>v.skipped),['locked','excluded']);
});

test('GVW, tail-lift, capacity and forbidden vehicles are hard placement checks',async()=>{
  for(const restriction of ['gvw','tail','capacity','forbid'] as const){
    const f=fixture();
    if(restriction==='gvw')f.input.requirements.get(91)!.maxTonnage=3.5;
    if(restriction==='tail'){f.input.requirements.get(91)!.requiresTailLift=true;for(const v of f.input.fleet.values())v.hasTailLift=false;}
    if(restriction==='capacity')f.input.request.tasks.find(t=>t.id===1)!.demand=[2000,1];
    if(restriction==='forbid')f.input.request.requests.find(r=>r.id===91)!.forbidden_vehicles=[7,42];
    const r=await suggestPlacements(f.input,f.scenario,91,identity);
    assert.equal(r.suggestions.length,0,restriction);assert.ok(r.vehicles.every(v=>v.blockers.length>0));
    const type={gvw:'VEHICLE_SIZE',tail:'TAIL_LIFT',capacity:'CAPACITY',forbid:'ASSIGNMENT'}[restriction];
    assert.ok(r.vehicles.every(v=>v.blockers.some(b=>b.type===type)),restriction);
  }
});

test('checks shifted later trips; fitting the inserted order alone is insufficient',async()=>{
  const f=fixture();f.input.layout.excludedVehicleIds=[42];
  const v=f.input.request.vehicles[0]!;v.max_trips=2;
  // Force request 91 into a new trip before an existing tight delivery.
  f.input.request.tasks.find(t=>t.id===1)!.service_seconds=1000;
  f.input.request.tasks.find(t=>t.id===2)!.tw_late=400;
  const r=await suggestPlacements(f.input,f.scenario,91,identity);
  assert.ok(r.vehicles[0]!.blockers.some(v=>v.type==='HARD_TW'));
  for(const s of r.suggestions)assert.equal(s.position,1,'only insertion after tight delivery may pass');
});

test('candidate/time bounds are explicit partial results, never an infeasibility claim',async()=>{
  const f=fixture();const r=await suggestPlacements(f.input,f.scenario,91,identity,{candidates:1,milliseconds:10000});
  assert.equal(r.complete,false);assert.equal(r.checked,1);
  const timed=await suggestPlacements(f.input,f.scenario,91,identity,{candidates:1000,milliseconds:0});
  assert.equal(timed.complete,false);assert.equal(timed.checked,0);
});

test('an insertion cannot make a later trip miss its deadline',async()=>{
  const f=fixture();f.input.layout.excludedVehicleIds=[42];f.input.request.vehicles[0]!.max_trips=2;
  f.input.request.tasks.find(t=>t.id===1)!.service_seconds=1000;
  f.input.request.tasks.push({...structuredClone(f.input.request.tasks[0]!),id:3,ref:'LATER',service_seconds:60,tw_late:800});
  f.input.request.requests.push({id:93,delivery_task_id:3});f.input.layout.requestIds.push(93);
  f.input.layout.routes.push({vehicleId:7,tripId:'later',requestIds:[93]});f.input.departures.set(manualTripKey(7,'later'),600);
  f.input.requirements.set(93,{maxTonnage:null,requiresTailLift:false});
  assert.equal(evaluateManualInput(f.input,f.input.layout,f.scenario).validation.valid,true);
  const r=await suggestPlacements(f.input,f.scenario,91,identity);
  assert.ok(r.vehicles[0]!.blockers.some(v=>v.type==='HARD_TW'&&v.requestId===93));
  assert.ok(r.suggestions.length>0);
  assert.ok(r.suggestions.every(s=>s.tripId==='later'&&s.position===1),'only insertion after the final tight delivery may pass');
});

test('assigned/unknown delivery IDs and missing matrix evidence fail closed',async()=>{
  const f=fixture();await assert.rejects(()=>suggestPlacements(f.input,f.scenario,92,identity),/not unassigned/);
  await assert.rejects(()=>suggestPlacements(f.input,f.scenario,999,identity),/not unassigned/);
  f.input.request.travel={...f.input.request.travel,distances:[]};
  await assert.rejects(()=>suggestPlacements(f.input,f.scenario,91,identity),/incomplete matrix/);
});
