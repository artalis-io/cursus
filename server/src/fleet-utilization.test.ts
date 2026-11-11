import test from 'node:test';
import assert from 'node:assert/strict';
import {fleetUtilization} from './fleet-utilization.js';
import {captureFleet,rebindFleet,type FleetSource} from './plan/fleet-snapshot.js';
import {manualFixture} from './state/manual-fixture.js';
import type {Plan,PlanTrip} from './types.js';
function fixture(){
  const p=manualFixture().parent,v=p.vehicles[0]!;
  Object.assign(v,{id:7,ref:'V7',capacityKg:1000,capacityPallets:10,peakKg:700,peakPallets:7,distanceKm:5});
  const trip=(index:number,start:number,kg:number):PlanTrip=>({...structuredClone(v.trips[0]!),index,startSec:start,endSec:start+100,loadKg:kg,loadPallets:kg/100,
    stops:[{...structuredClone(v.trips[0]!.stops[0]!),type:'delivery',weightKg:kg,pallets:kg/100,arrivalSec:start+10,serviceStartSec:start+30,departureSec:start+60,travelToSec:10,waitSec:20,serviceMin:1}]});
  v.trips=[trip(0,0,500),trip(1,300,700)];v.tripCount=2;v.finishTimeSec=400;
  p.vehicles=[v];p.stats.vehiclesUsed=1;p.stats.trips=2;
  const vehicles=[7,8,9,10].map(id=>({id,ref:`V${id}`,capacity:[1000,10],start_depot_id:0,end_depot_id:0,shift_early:0,shift_late:1000,max_duration:900,max_distance:10000,max_trips:3,trip_reload_seconds:60}));
  const source:FleetSource={vehicles,complete:true,excludedVehicleIds:[9],unavailableVehicleIds:[10]};p.provenance.fleet=captureFleet(p,source);
  return {p,source};
}
test('multi-trip utilization uses the maximum loaded trip, never the sum, and preserves saved KPIs',()=>{
  const {p}=fixture(),before=structuredClone(p),r=fleetUtilization(p),v=r.vehicles[0]!;
  assert.equal(r.kpisMatch,true);assert.equal(r.inventory,'complete');assert.deepEqual([r.unusedAvailable,r.excluded,r.unavailable],[1,1,1]);
  assert.deepEqual(v.kg,{peak:700,capacity:1000,percent:70,remaining:300});assert.deepEqual(v.pallets,{peak:7,capacity:10,percent:70,remaining:3});
  assert.deepEqual(v.trips.map(t=>t.kg!.peak),[500,700]);assert.deepEqual(p,before);
});
test('time accounts for depot-return travel and full inter-trip gaps; shift headroom is not a feasibility promise',()=>{
  const {p}=fixture(),v=fleetUtilization(p).vehicles[0]!;
  assert.deepEqual(v.time,{elapsed:400,driving:100,service:60,waiting:40,betweenTrips:200});
  assert.equal(v.time!.elapsed,v.time!.driving+v.time!.service+v.time!.waiting+v.time!.betweenTrips);
  assert.deepEqual([v.remainingShiftSec,v.remainingDurationSec,v.remainingDistanceKm,v.remainingTrips],[600,500,5,1]);
  assert.equal(v.limits!.reloadSec,60,'200 seconds between trips must not be relabeled as 200 seconds of required reload');
});
test('old plans show recorded used-vehicle capacities but cannot invent unused inventory or shift limits',()=>{
  const {p}=fixture();delete p.provenance.fleet;const r=fleetUtilization(p);
  assert.equal(r.inventory,'missing');assert.equal(r.unusedAvailable,null);assert.equal(r.vehicles.length,1);assert.equal(r.vehicles[0]!.availability,'unknown');
  assert.equal(r.vehicles[0]!.kg!.percent,70);assert.equal(r.vehicles[0]!.remainingShiftSec,null);
});
test('zero and missing capacity are unknown, not 0% utilization; finite overloads remain visible above 100%',()=>{
  const {p,source}=fixture();p.vehicles[0]!.capacityKg=0;source.vehicles[0]!.capacity[0]=0;p.provenance.fleet=captureFleet(p,source);
  assert.equal(fleetUtilization(p).vehicles[0]!.kg!.percent,null);assert.equal(fleetUtilization(p).vehicles[0]!.kg!.remaining,null);
  p.vehicles[0]!.capacityKg=500;source.vehicles[0]!.capacity[0]=500;p.provenance.fleet=captureFleet(p,source);
  assert.equal(fleetUtilization(p).vehicles[0]!.kg!.percent,140);assert.equal(fleetUtilization(p).vehicles[0]!.kg!.remaining,-200);
});
test('partial native inventory is explicitly incomplete and cannot become a claim about unused fleet',()=>{
  const {p,source}=fixture();p.provenance.fleet=captureFleet(p,{vehicles:[source.vehicles[0]!],complete:false});
  const r=fleetUtilization(p);assert.equal(r.inventory,'eligible_only');assert.equal(r.unusedAvailable,null);assert.equal(r.vehicles[0]!.remainingShiftSec,600);
});
test('missing shift bounds stay unknown, zero start is valid, and late return is negative headroom',()=>{
  const {p,source}=fixture();delete (source.vehicles[0] as Partial<typeof source.vehicles[0]>).shift_late;p.provenance.fleet=captureFleet(p,source);
  assert.equal(fleetUtilization(p).vehicles[0]!.remainingShiftSec,null);
  source.vehicles[0]!.shift_late=200;p.provenance.fleet=captureFleet(p,source);
  assert.equal(fleetUtilization(p).vehicles[0]!.remainingShiftSec,-200);
});
for(const change of ['plan','revision','hash','capacity','duplicate','ref','malformed'] as const)test(`borrowed or contradictory fleet ${change} cannot supply idle vehicles or shift limits`,()=>{
  const {p}=fixture(),s=p.provenance.fleet!;
  if(change==='plan')s.planId='foreign';if(change==='revision')s.scenarioRevision++;if(change==='hash')s.inputSha256='f'.repeat(64);
  if(change==='capacity')s.vehicles[0]!.capacityKg=2000;if(change==='duplicate')s.vehicles.push(s.vehicles[0]!);if(change==='ref')s.vehicles[0]!.ref='other';
  if(change==='malformed')s.vehicles=[null] as unknown as typeof s.vehicles;
  const before=structuredClone(p),r=fleetUtilization(p);assert.equal(r.inventory,'invalid');assert.equal(r.unusedAvailable,null);assert.equal(r.vehicles[0]!.remainingShiftSec,null);assert.deepEqual(p,before);
});
test('mixed pickup/delivery and contradictory or non-finite cargo never present fictitious peak occupancy',()=>{
  for(const change of ['pickup','negative','nan','trip','peak'] as const){
    const {p}=fixture(),v=p.vehicles[0]!,t=v.trips[0]!;
    if(change==='pickup')t.stops[0]!.type='pickup';if(change==='negative')t.stops[0]!.weightKg=-1;if(change==='nan')t.stops[0]!.weightKg=NaN;
    if(change==='trip')t.loadKg++;if(change==='peak')v.peakKg++;
    const r=fleetUtilization(p).vehicles[0]!;assert.equal(r.kg,null,change);assert.ok(r.issues.includes('load'));
  }
});
test('overlapping, malformed or non-reconciling schedules suppress duration and shift claims independently of capacity',()=>{
  for(const change of ['overlap','travel','wait','service','return'] as const){
    const {p}=fixture(),v=p.vehicles[0]!,t=v.trips[0]!;
    if(change==='overlap')v.trips[1]!.startSec=1;if(change==='travel')t.stops[0]!.travelToSec=100;if(change==='wait')t.stops[0]!.waitSec=200;
    if(change==='service')t.stops[0]!.departureSec=1;if(change==='return')t.endSec=50;
    const r=fleetUtilization(p).vehicles[0]!;assert.equal(r.time,null);assert.equal(r.remainingShiftSec,null);assert.equal(r.kg!.peak,700);
  }
});
test('reported blockers are recorded evidence scoped by vehicle, never an inferred reason for optimizer fleet choice',()=>{
  const {p}=fixture();p.provenance.validation.violations=[{type:'CAPACITY',vehicle_id:7},{type:'SHIFT',vehicle_id:8},{type:'TAIL_LIFT',vehicle_id:7}];
  assert.deepEqual(fleetUtilization(p).vehicles[0]!.violations,['CAPACITY','TAIL_LIFT']);
});
test('KPI mismatch is visible, not silently corrected, and empty used routes do not imply free working time',()=>{
  const {p}=fixture();p.stats.vehiclesUsed=2;const before=structuredClone(p);assert.equal(fleetUtilization(p).kpisMatch,false);assert.deepEqual(p,before);
  p.vehicles[0]!.trips=[];assert.equal(fleetUtilization(p).vehicles[0]!.time,null);assert.equal(fleetUtilization(p).vehicles[0]!.kg,null);
});
test('input-replacement identity rebinding retains only its newly materialized facts',()=>{
  const {p}=fixture();const old=structuredClone(p.provenance.fleet!.vehicles);p.id='new-plan';p.scenarioId='new-scenario';p.scenarioRevision++;
  assert.equal(fleetUtilization(p).inventory,'invalid');rebindFleet(p);assert.equal(fleetUtilization(p).inventory,'complete');assert.deepEqual(p.provenance.fleet!.vehicles,old);
});
test('fractional pallet demand remains scalar and percentage overflow is withheld rather than serialized as infinity',()=>{
 const {p,source}=fixture(),v=p.vehicles[0]!;
 v.trips[0]!.loadPallets=v.trips[0]!.stops[0]!.pallets=0.25;v.trips[1]!.loadPallets=v.trips[1]!.stops[0]!.pallets=0.5;v.peakPallets=0.5;
 v.capacityPallets=source.vehicles[0]!.capacity[1]=1.5;p.provenance.fleet=captureFleet(p,source);
 assert.equal(fleetUtilization(p).vehicles[0]!.pallets!.percent,0.5/1.5*100);
 v.capacityKg=source.vehicles[0]!.capacity[0]=1e-308;p.provenance.fleet=captureFleet(p,source);
 assert.equal(fleetUtilization(p).vehicles[0]!.kg!.percent,null);
});
