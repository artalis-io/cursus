import test from 'node:test';
import assert from 'node:assert/strict';
import {parseProfile,profileDigest,type ProfileContent,type ApprovedProfile} from './planning-profiles.js';
import {applyProfileSnapshots} from './plan/profiles.js';
import {manualFixture} from './state/manual-fixture.js';
import {exportScenario,parseScenarioImport} from './store.js';
import {buildRequest,applyVehicleOverrides} from './solve.js';

const content=():ProfileContent=>({schemaVersion:1,kind:'locations',datasetSha256:'a'.repeat(64),label:'Public locations',reason:'Verified opening hours',locations:[
 {locationId:1,maxGrossWeightKg:7500,requiresTailLift:true,serviceSeconds:120,windowStartSeconds:0,windowEndSeconds:86400,reason:'Source site survey'},
]});
const approved=(value:ProfileContent):ApprovedProfile=>({id:'profile_fixture',kind:value.kind,revision:1,sha256:profileDigest(value),content:value,approvedAt:'2026-10-29T00:00:00Z',approvedBy:null});

test('profile content is strict, bounded, checksum-bound and canonically hashed',()=>{
 const value=content();assert.deepEqual(parseProfile(value),value);
 assert.equal(profileDigest(value),profileDigest({...value,locations:structuredClone(value.locations)}));
 for(const change of [
  (c:ProfileContent)=>{c.datasetSha256='invalid';},(c:ProfileContent)=>{c.reason=' ';},
  (c:ProfileContent)=>{c.locations![0]!.windowEndSeconds=-1;},
  (c:ProfileContent)=>{c.locations!.push(c.locations![0]!);},
  (c:ProfileContent)=>{Object.assign(c.locations![0]!,{coordinates:[1,2]});},
  (c:ProfileContent)=>{c.locations![0]!.maxGrossWeightKg=0;},
 ]){const candidate=structuredClone(value);change(candidate);assert.throws(()=>parseProfile(candidate));}
});

test('approved location revisions affect only explicit locations without mutating admitted inputs',()=>{
 const fixture=manualFixture(),before=structuredClone(fixture.context.day.request);
 const snapshot=approved(content()),result=applyProfileSnapshots(fixture.context.day,[snapshot]);
 assert.deepEqual(fixture.context.day.request,before);
 assert.equal(result.day.request.tasks.find(t=>t.location_id===1)!.service_seconds,120);
 assert.equal(result.day.deliveryEnrichment?.get(91)?.maxTonnage,7.5);
 assert.equal(result.day.deliveryEnrichment?.has(92),false);
 assert.deepEqual(result.day.planningProfiles,[{id:snapshot.id,kind:'locations',revision:1,sha256:snapshot.sha256}]);
 snapshot.content.locations![0]!.requiresTailLift=false;
 assert.throws(()=>applyProfileSnapshots(fixture.context.day,[snapshot]),/integrity/);
});

test('profile application rejects unknown locations, missing approval and cross-dataset use',()=>{
 for(const mutate of [
  (c:ProfileContent)=>{c.datasetSha256='b'.repeat(64);},
  (c:ProfileContent)=>{c.locations![0]!.locationId=999;},
 ]){const value=content();mutate(value);assert.throws(()=>applyProfileSnapshots(manualFixture().context.day,[approved(value)]));}
 const snapshot=approved(content());snapshot.approvedAt='';
 assert.throws(()=>applyProfileSnapshots(manualFixture().context.day,[snapshot]));
});

test('portable profile references require a version understood by the receiving runtime',()=>{
 const f=manualFixture();f.scenario.planningProfiles=[{id:'profile_fixture',kind:'locations',revision:1,sha256:'b'.repeat(64)}];
 const bundle=exportScenario(f.scenario);assert.equal(bundle.otto_scenario,2);
 const parsed=parseScenarioImport(bundle);assert.ok(!('error'in parsed));
 if(!('error'in parsed))assert.deepEqual(parsed.edits.planningProfiles,f.scenario.planningProfiles);
 assert.ok('error'in parseScenarioImport({...bundle,otto_scenario:1}));
 assert.throws(()=>buildRequest(f.scenario,1),/stateful/);
 f.scenario.planningProfiles=[];const cleared=parseScenarioImport(exportScenario(f.scenario));
 assert.ok(!('error'in cleared));if(!('error'in cleared))assert.deepEqual(cleared.edits.planningProfiles,[]);
});

test('approved payload ceilings cannot be increased by a scenario override',()=>{
 const f=manualFixture();f.context.day.request.vehicles[0]!.approved_capacity=[1000,10];
 f.scenario.vehicleOverrides=[{vehicleId:7,capacityKg:1001}];
 assert.throws(()=>applyVehicleOverrides(f.context.day.request,f.scenario),/approved fleet/);
 f.scenario.vehicleOverrides=[{vehicleId:7,capacityKg:900}];
 applyVehicleOverrides(f.context.day.request,f.scenario);assert.equal(f.context.day.request.vehicles[0]!.capacity[0],900);
});

import {unknownOperatingLimits,parseOperatingLimits,applyOperatingLimits,operatingViolations} from './operating-limits.js';
import {prepareManualInput,evaluateManualInput} from './plan/manual-adapter.js';
const fleetContent=():ProfileContent=>{
 const f=manualFixture();return {schemaVersion:1,kind:'fleet',datasetSha256:'a'.repeat(64),label:'Operating fleet',reason:'Verified dispatcher limits',settings:{datasetSha256:'a'.repeat(64),tariff:f.context.tariff,
 vehicles:f.context.day.request.vehicles.map(v=>({id:v.id,ref:v.ref,vehicleClass:null,isSubcontractor:false,tonnage:12,hasTailLift:true,reloadSec:120,capacityKg:1000,capacityPallets:10,operatingLimits:unknownOperatingLimits()}))}};
};
test('operating states are strict; configured midnight is valid and zero maxima are not',()=>{
 const zero=unknownOperatingLimits();zero.shift={state:'configured',startSec:0,endSec:0};assert.deepEqual(parseOperatingLimits(zero),zero);
 for(const bad of [null,{}, {...zero,maxTrips:{state:'configured',value:0}}, {...zero,maxTrips:{state:'configured',value:1.5}},
  {...zero,maxDistanceKm:{state:'configured',value:Infinity}}, {...zero,shift:{state:'configured',startSec:2,endSec:1}},
  {...zero,maxDurationSec:{state:'unknown',value:10}}, {...zero,extra:true}])assert.throws(()=>parseOperatingLimits(bad));
 const c=fleetContent();c.settings!.vehicles[0]!.operatingLimits=zero;assert.deepEqual(parseProfile(c),c);
 (c.settings!.vehicles[0]!.operatingLimits as unknown as {shift:unknown}).shift={state:'nonsense'};assert.throws(()=>parseProfile(c));
});
test('unknown preserves source semantics; explicit unlimited removes both shift fields',()=>{
 const v=manualFixture().context.day.request.vehicles[0]!;Object.assign(v,{shift_early:100,shift_late:900,max_trips:2,max_distance:1000,max_duration:500});
 applyOperatingLimits(v,unknownOperatingLimits());assert.equal(v.max_trips,2);assert.equal(v.shift_late,900);
 applyOperatingLimits(v,{shift:{state:'unlimited'},maxTrips:{state:'unlimited'},maxDistanceKm:{state:'unlimited'},maxDurationSec:{state:'unlimited'}});
 assert.equal(v.shift_early,undefined);assert.equal(v.shift_late,undefined);assert.equal(v.max_trips,0);assert.equal(v.max_duration,0);assert.equal(v.max_distance,0);
 const missing=manualFixture().context.day.request.vehicles[0]!;delete missing.max_trips;applyOperatingLimits(missing,unknownOperatingLimits());assert.equal(missing.max_trips,undefined);
});
test('approved operating ceilings cannot be relaxed or bypassed using zero',()=>{
 const limits=unknownOperatingLimits();limits.shift={state:'configured',startSec:3600,endSec:43200};limits.maxTrips={state:'configured',value:2};limits.maxDistanceKm={state:'configured',value:300};limits.maxDurationSec={state:'configured',value:36000};
 const f=manualFixture();applyOperatingLimits(f.context.day.request.vehicles[0]!,limits);
 for(const patch of [{shiftEarlySec:3599},{shiftLateSec:43201},{maxTrips:0},{maxTrips:3},{maxDistanceKm:301},{maxDistanceKm:0},{maxDurationMin:601},{maxDurationMin:0}]){
  assert.throws(()=>applyVehicleOverrides(structuredClone(f.context.day.request),{...f.scenario,vehicleOverrides:[{vehicleId:7,...patch}]}),/approved fleet/);
 }
 applyVehicleOverrides(f.context.day.request,{...f.scenario,vehicleOverrides:[{vehicleId:7,shiftEarlySec:7200,shiftLateSec:40000,maxTrips:1,maxDistanceKm:250,maxDurationMin:500}]});
 assert.equal(f.context.day.request.vehicles[0]!.max_distance,250000);assert.equal(f.context.day.request.vehicles[0]!.max_duration,30000);
 assert.deepEqual(f.context.day.request.vehicles[0]!.operating_limits!.maxTrips,{state:'configured',value:1});
});
test('profile applies identical bounds to manual input without rewriting source or old profile revisions',()=>{
 const f=manualFixture(),c=fleetContent();c.settings!.vehicles[0]!.operatingLimits!.shift={state:'configured',startSec:1000,endSec:2000};c.settings!.vehicles[0]!.operatingLimits!.maxDurationSec={state:'configured',value:1000};
 const original=structuredClone(f.context.day.request),p=approved(c),result=applyProfileSnapshots(f.context.day,[p]);
 assert.equal(result.day.request.vehicles[0]!.shift_early,1000);assert.deepEqual(f.context.day.request,original);
 f.context={...result.settings!,day:result.day};f.scenario.planningProfiles=result.day.planningProfiles;f.parent.provenance.planningProfiles=result.day.planningProfiles;
 const input=prepareManualInput(f.parent,f.scenario,f.context),evaluation=evaluateManualInput(input,input.layout,f.scenario);
 assert.ok(evaluation.vehicles[0]!.trips[0]!.startSec>=1000);assert.equal(input.request.vehicles[0]!.max_duration,1000);
 const revised=structuredClone(c);revised.settings!.vehicles[0]!.operatingLimits!.maxTrips={state:'configured',value:1};assert.notEqual(profileDigest(c),profileDigest(revised));assert.deepEqual(p.content,c);
});
test('result boundary checks shifts, trip count, aggregate distance and elapsed duration',()=>{
 const limits=unknownOperatingLimits();limits.shift={state:'configured',startSec:100,endSec:1000};limits.maxTrips={state:'configured',value:1};limits.maxDistanceKm={state:'configured',value:10};limits.maxDurationSec={state:'configured',value:500};
 assert.deepEqual(operatingViolations({trips:[{startSec:100,endSec:600}],distanceKm:10},limits),[]);
 assert.deepEqual(operatingViolations({trips:[{startSec:99,endSec:600},{startSec:700,endSec:1001}],distanceKm:11},limits),['shift','trips','distance','duration']);
});

import {fleetPolicyBlockers} from './state/manual-settings.js';
import {tariffIdentity} from './cost.js';
import {captureFleet} from './plan/fleet-snapshot.js';
test('approval and approved exports require recorded operating evidence and actual compliance',()=>{
 const f=manualFixture(),limits=unknownOperatingLimits();limits.maxDistanceKm={state:'configured',value:10};
 const settings={...f.context,operatingLimits:new Map([[7,limits]])};f.parent.provenance.tariffSha256=tariffIdentity(settings.tariff);
 assert.ok(fleetPolicyBlockers(f.parent,settings).length,'old unknown evidence is not newly approved');
 applyOperatingLimits(f.context.day.request.vehicles[0]!,limits);
 f.parent.provenance.fleet=captureFleet(f.parent,{vehicles:f.context.day.request.vehicles,complete:true});
 assert.deepEqual(fleetPolicyBlockers(f.parent,settings),[]);
 f.parent.vehicles[0]!.distanceKm=11;assert.ok(fleetPolicyBlockers(f.parent,settings).length);
 f.parent.vehicles[0]!.distanceKm=1;f.parent.provenance.fleet.vehicles[0]!.operatingLimits!.maxDistanceKm={state:'unlimited'};
 assert.ok(fleetPolicyBlockers(f.parent,settings).length,'unlimited evidence cannot satisfy a configured ceiling');
});

test('operating envelopes cannot be attached to a different vehicle by swapping registrations',()=>{
 const c=fleetContent(),rows=c.settings!.vehicles;[rows[0]!.ref,rows[1]!.ref]=[rows[1]!.ref,rows[0]!.ref];
 assert.throws(()=>applyProfileSnapshots(manualFixture().context.day,[approved(c)]),/registration binding/);
});
