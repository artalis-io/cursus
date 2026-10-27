import test from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manualFixture } from '../state/manual-fixture.js';
import { applyRetainedDecisions, datasetAllowances, verifyRetainedSolution, withRetainedProvenance, assertRetainedPlan } from './retained.js';
import { applyAccessLimits } from './access.js';
import { nativeSolveRequest } from '../state/solver-ids.js';
import type { SurgeSolution } from '../types.js';

function fixture() {
  const f=manualFixture();
  f.scenario.manualPlanId='manual-parent';
  f.scenario.manualDecisions={datasetSha256:'a'.repeat(64),requestIds:[91,92],decisions:{'91':{kind:'vehicle',vehicleId:7}},
    reloadSeconds:[[7,120],[42,120]],
    origins:{'91':'optimizer','92':'import'},history:[{operationId:'assign',index:0,requestId:91,action:'assign',actorId:'planner',
      at:'2026-10-26T00:00:00Z',from:null,to:{vehicleId:7,tripId:'trip-0',position:0}}]};
  return f;
}

test('retained deassignment and excluded pinned vehicle never become unrestricted',()=>{
  const f=fixture(), r=f.context.day.request, baseline=datasetAllowances(r);
  f.scenario.manualDecisions!.decisions['92']={kind:'unassigned'};
  r.vehicles=r.vehicles.filter(v=>v.id!==7);
  applyRetainedDecisions(r,f.scenario,'a'.repeat(64),baseline);
  assert.deepEqual(r.requests.map(o=>o.forbidden_vehicles),[[42],[42]]);
});

test('dataset allowlists, hard forbids and seed cleanup survive retained choices',()=>{
  const f=fixture(),r=f.context.day.request;
  r.requests[0]!.allowed_vehicles=[42];
  r.requests[1]!.forbidden_vehicles=[7];
  const baseline=datasetAllowances(r);
  f.scenario.manualDecisions!.decisions['92']={kind:'unassigned'};
  const extra=r as typeof r & {initial_routes: {vehicle_id:number;request_ids:number[]}[];frozen_requests:number[];committed_requests:number[]};
  extra.initial_routes=[{vehicle_id:7,request_ids:[91,92]}];extra.frozen_requests=[91,92];extra.committed_requests=[91];
  applyRetainedDecisions(r,f.scenario,'a'.repeat(64),baseline);
  assert.deepEqual(r.requests[0]!.allowed_vehicles,[7]);
  assert.ok(r.requests[0]!.forbidden_vehicles?.includes(7));
  assert.deepEqual(extra.initial_routes[0]!.request_ids,[]);
  assert.deepEqual(extra.frozen_requests,[]);assert.deepEqual(extra.committed_requests,[]);
});

test('missing, mismatched and out-of-scope manual state fails closed',()=>{
  const changes:((f:ReturnType<typeof fixture>)=>void)[]=[
    f=>{delete f.scenario.manualDecisions;},
    f=>{f.scenario.manualDecisions!.datasetSha256='b'.repeat(64);},
    f=>{f.scenario.manualDecisions!.decisions['999']={kind:'unassigned'};},
    f=>{f.scenario.manualDecisions!.decisions['091']={kind:'unassigned'};},
    f=>{f.scenario.manualDecisions!.decisions['91']={kind:'vehicle',vehicleId:-1};},
  ];
  for(const change of changes){const f=fixture();change(f);assert.throws(()=>applyRetainedDecisions(f.context.day.request,f.scenario,'a'.repeat(64),datasetAllowances(f.context.day.request)),/retained assignments:/);}
});

test('native output boundary rejects duplicate, omitted, wrong-task and forbidden deliveries',()=>{
  const f=fixture(),r=f.context.day.request;
  const original=f.context.day.solution;
  assert.doesNotThrow(()=>verifyRetainedSolution(r,f.scenario,original));
  const changes:((s:SurgeSolution)=>void)[]=[
    s=>{s.unassigned.push(91);}, s=>{s.routes[0]!.stops.pop();},
    s=>{s.routes[0]!.stops[0]!.task_id=999;}, s=>{s.routes[0]!.vehicle_id=999;},
    s=>{s.routes[0]!.vehicle_id=42;},
  ];
  for(const change of changes){const s=structuredClone(original);change(s);assert.throws(()=>verifyRetainedSolution(r,f.scenario,s),/retained assignments:/);}
  f.scenario.manualDecisions!.decisions['92']={kind:'unassigned'};
  assert.throws(()=>verifyRetainedSolution(r,f.scenario,original),/manual decision/);
});

test('replan keeps ownership/history, emits fresh solver provenance and guards authoritative publication',()=>{
  const f=fixture(),p=withRetainedProvenance(f.parent,f.scenario,[7,42]);
  assert.equal(p.manual,undefined);assert.equal(p.provenance.termination,'OK');
  assert.deepEqual(p.assignments!.layout.history,f.scenario.manualDecisions!.history);
  assert.deepEqual(p.assignments!.layout.origins,f.scenario.manualDecisions!.origins);
  assert.doesNotThrow(()=>assertRetainedPlan(p,f.scenario));
  const changes:((p:typeof f.parent)=>void)[]=[
    p=>{p.assignments!.layout.history=[];},p=>{p.assignments!.layout.origins['91']='optimizer-changed' as never;},
    p=>{p.assignments!.layout.decisions={};},p=>{p.scenarioRevision++;},p=>{p.provenance.datasetSha256='b'.repeat(64);},
    p=>{p.vehicles[0]!.trips[0]!.stops.pop();},p=>{p.assignments!.layout.requestIds=[91];},
    p=>{p.stats.servedOrders=999;},
  ];
  for(const change of changes){const copy=structuredClone(p);change(copy);assert.throws(()=>assertRetainedPlan(copy,f.scenario));}
});

test('native population solver retains pins/deassignments, releases orders and preserves hard access', {skip:!process.env.CURSUS_TEST_SURGE_BIN},async()=>{
  const scratch=await mkdtemp(join(tmpdir(),'cursus-retained-native-'));
  try{
    for(const mode of ['retained','released','gvw','tail-lift','capacity','reload'] as const){
      const f=fixture(),r=f.context.day.request;
      r.config={max_time_seconds:1,seed:42,population:true,population_threads:2,hard_capacity:true,hard_time_windows:true};
      f.scenario.manualDecisions!.decisions['91']={kind:'vehicle',vehicleId:42};
      if(mode==='reload'){
        f.scenario.manualDecisions!.decisions['92']={kind:'vehicle',vehicleId:42};
        const vehicle=r.vehicles.find(v=>v.id===42)!;vehicle.capacity=[100,1];vehicle.max_trips=2;vehicle.trip_reload_seconds=120;
      }else if(mode!=='released')f.scenario.manualDecisions!.decisions['92']={kind:'unassigned'};
      if(mode==='gvw')f.context.day.enrichment.get('ORDER-1')!.maxTonnage=3.5;
      if(mode==='tail-lift'){f.context.day.enrichment.get('ORDER-1')!.requiresTailLift=true;r.vehicles.find(v=>v.id===42)!.has_tail_lift=false;}
      if(mode==='capacity')r.vehicles.find(v=>v.id===42)!.capacity=[50,0];
      const baseline=datasetAllowances(r);
      applyAccessLimits(r,f.context.day.enrichment,f.context.vehicleInfo);
      applyRetainedDecisions(r,f.scenario,'a'.repeat(64),baseline);
      const native=nativeSolveRequest(r);
      assert.equal(native.request.config.population,true);
      const path=join(scratch,`${mode}.json`);await writeFile(path,JSON.stringify(native.request));
      const {stdout}=await promisify(execFile)(process.env.CURSUS_TEST_SURGE_BIN!,[path],{timeout:30000});
      const result=native.restore(JSON.parse(stdout) as SurgeSolution);
      verifyRetainedSolution(r,f.scenario,result);
      const assigned=result.routes.flatMap(v=>v.stops.map(s=>[s.request_id,v.vehicle_id]));
      if(mode==='retained'||mode==='released'||mode==='reload')assert.deepEqual(assigned.find(([id])=>id===91),[91,42]);
      else assert.ok(result.unassigned.includes(91),mode);
      if(mode==='released'||mode==='reload')assert.ok(assigned.some(([id])=>id===92));
      else assert.ok(result.unassigned.includes(92));
      if(mode==='reload'){
        const route=result.routes.find(v=>v.vehicle_id===42)!;
        assert.equal(route.trip_count,2);
        const first=route.stops[0]!,second=route.stops[1]!;
        assert.notEqual(first.trip_index,second.trip_index);
        const from=r.tasks.find(t=>t.id===first.task_id)!.location_id,to=r.tasks.find(t=>t.id===second.task_id)!.location_id;
        const returned=first.departure+r.travel.durations[from*3]!,nextStart=second.arrival-r.travel.durations[to]!;
        assert.ok(nextStart>=returned+120,`reload dwell ${nextStart-returned}`);
      }
    }
  }finally{await rm(scratch,{recursive:true,force:true});}
});

test('authoritative publication rejects use or erasure of unavailable fleet policy',()=>{
  const f=fixture();f.scenario.manualDecisions!.unavailableVehicleIds=[42];
  const plan=withRetainedProvenance(f.parent,f.scenario,[7,42]);
  assert.ok(plan.assignments!.layout.excludedVehicleIds.includes(42));
  assert.doesNotThrow(()=>assertRetainedPlan(plan,f.scenario));
  plan.assignments!.layout.excludedVehicleIds=[];
  assert.throws(()=>assertRetainedPlan(plan,f.scenario),/erased vehicle availability/);
  plan.assignments!.layout.excludedVehicleIds=[42];
  f.scenario.manualDecisions!.unavailableVehicleIds=[7];
  assert.throws(()=>assertRetainedPlan(plan,f.scenario),/unavailable vehicle/);
});
