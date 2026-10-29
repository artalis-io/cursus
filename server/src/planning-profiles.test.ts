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
