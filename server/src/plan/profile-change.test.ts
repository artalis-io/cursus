import test from 'node:test';
import assert from 'node:assert/strict';
import {manualFixture} from '../state/manual-fixture.js';
import {prepareManualInput,evaluateManualInput,materializeManualPlan} from './manual-adapter.js';
import {applyManualBatch} from './manual.js';
import {applyProfileSnapshots} from './profiles.js';
import {profileDigest} from '../planning-profiles.js';
import type {ProfileContent,ApprovedProfile} from '../planning-profile-contract.js';
import type {ProfileChangeIntent} from '../profile-change-contract.js';
import {unknownOperatingLimits} from '../operating-limits.js';
import {reviewProfileChange} from './profile-change.js';
import {parseProfileChange} from '../state/profile-changes.js';
const actor={actorId:'public-planner',at:'2026-11-12T10:00:00Z'};
function fixture(){
 const f=manualFixture(),input=prepareManualInput(f.parent,f.scenario,f.context);
 input.layout=applyManualBatch(input.layout,{operationId:'prior-manual',datasetSha256:input.datasetSha256,commands:[{op:'assign',requestId:91,vehicleId:7,tripId:'trip-0',position:0}]},actor);
 const evaluation=evaluateManualInput(input,input.layout,f.scenario);
 f.parent=materializeManualPlan(f.parent,f.scenario,input,evaluation,f.context,f.parent.id,f.parent.createdAt);
 f.scenario.manualPlanId=f.parent.id;f.scenario.selectedPlanId=f.parent.id;f.scenario.selectionVersion=1;
 f.scenario.manualDecisions={datasetSha256:input.datasetSha256,decisions:structuredClone(input.layout.decisions),requestIds:[91,92],origins:structuredClone(input.layout.origins),history:structuredClone(input.layout.history),tariff:structuredClone(f.context.tariff),tariffSha256:input.tariffSha256,fleetInfo:[...f.context.vehicleInfo],reloadSeconds:[...f.context.reloadSeconds]};
 const content:ProfileContent={schemaVersion:1,kind:'fleet',datasetSha256:input.datasetSha256,label:'Reviewed fleet',reason:'Verified public capacity',settings:{datasetSha256:input.datasetSha256,tariff:structuredClone(f.context.tariff),vehicles:f.context.day.request.vehicles.map(v=>({id:v.id,ref:v.ref,vehicleClass:null,isSubcontractor:false,tonnage:12,hasTailLift:true,reloadSec:120,available:true,capacityKg:1000,capacityPallets:10}))}};
 const target=(content:ProfileContent)=>{
  const p:ApprovedProfile={id:'profile_public',kind:content.kind,revision:1,sha256:profileDigest(content),approvedAt:actor.at,approvedBy:'public-admin',content};
  const applied=applyProfileSnapshots(f.context.day,[p],f.context);
  return {context:{...applied.settings!,day:applied.day},ref:{id:p.id,kind:p.kind,revision:p.revision,sha256:p.sha256}};
 };
 const intent=(ref:ReturnType<typeof target>['ref']):ProfileChangeIntent=>({operationId:'profile-review',parentPlanId:f.parent.id,profiles:[ref],reason:'Reviewed new fleet',releaseRequestIds:[],unlockVehicleIds:[],clearVehicleOverrideIds:[],acknowledgeInvalid:false});
 return {...f,content,target,intent};
}
test('profile review preserves assignments, manual origins/history and recalculates exact rates without mutating source',()=>{
 const f=fixture();Object.assign(f.content.settings!.tariff as object,{perKmDefault:20,fixedPerVehicle:2000});
 const target=f.target(f.content),before=structuredClone({plan:f.parent,scenario:f.scenario,context:f.context});
 const r=reviewProfileChange(f.parent,f.scenario,f.context,target.context,f.intent(target.ref),actor);
 assert.deepEqual(r.conflicts,[]);assert.equal(r.plan!.stats.totalDistanceKm,4.5);assert.equal(r.plan!.stats.servedOrders,2);assert.equal(r.plan!.cost!.total,2090);
 assert.deepEqual(r.plan!.manual!.layout.routes,f.parent.manual!.layout.routes);assert.deepEqual(r.plan!.manual!.layout.decisions,f.parent.manual!.layout.decisions);
 assert.deepEqual(r.plan!.manual!.layout.history,f.parent.manual!.layout.history);assert.equal(r.plan!.manual!.parentScenario,undefined);
 assert.deepEqual({plan:f.parent,scenario:f.scenario,context:f.context},before);assert.ok(r.changes.some(c=>c.kind==='tariff'&&c.field==='perKmDefault'));
 assert.doesNotThrow(()=>prepareManualInput(r.plan!,r.scenario,target.context));
});
test('an override exceeding the new approved ceiling blocks evaluation until explicitly cleared',()=>{
 const f=fixture();f.scenario.vehicleOverrides=[{vehicleId:7,capacityKg:900}];f.content.settings!.vehicles[0]!.capacityKg=500;
 const t=f.target(f.content),intent=f.intent(t.ref),r=reviewProfileChange(f.parent,f.scenario,f.context,t.context,intent,actor);
 assert.equal(r.plan,null);assert.equal(r.conflicts[0]!.code,'override');
 const clear=reviewProfileChange(f.parent,f.scenario,f.context,t.context,{...intent,clearVehicleOverrideIds:[7]},actor);
 assert.equal(clear.plan!.provenance.validation.valid,true);assert.equal(clear.plan!.vehicles[0]!.capacityKg,500);assert.equal(f.scenario.vehicleOverrides[0]!.capacityKg,900);
});
test('locked and retained assignment conflicts require separate explicit resolutions; placements are never silently dropped',()=>{
 const f=fixture();f.scenario.sequences=[{vehicleId:7,orderNos:['ORDER-1','ORDER-2'],requestIds:[91,92],locked:true}];
 const location:ProfileContent={schemaVersion:1,kind:'locations',label:'Reviewed site',reason:'Verified deadline',datasetSha256:'a'.repeat(64),locations:[{locationId:1,maxGrossWeightKg:null,requiresTailLift:false,serviceSeconds:60,windowStartSeconds:0,windowEndSeconds:80,reason:'Verified receiving deadline'}]};
 const t=f.target(location),intent=f.intent(t.ref),before=structuredClone(f.parent);
 const r=reviewProfileChange(f.parent,f.scenario,f.context,t.context,intent,actor);
 assert.ok(r.conflicts.some(c=>c.code==='locked_route'));assert.ok(r.conflicts.some(c=>c.code==='retained_decision'&&c.requestId===91));assert.equal(r.plan!.stats.servedOrders,2);
 const resolved=reviewProfileChange(f.parent,f.scenario,f.context,t.context,{...intent,releaseRequestIds:[91],unlockVehicleIds:[7]},actor);
 assert.deepEqual(resolved.conflicts,[]);assert.equal(resolved.plan!.provenance.validation.valid,false);assert.equal(resolved.plan!.stats.servedOrders,2);
 assert.deepEqual(resolved.plan!.manual!.layout.routes,before.manual!.layout.routes);assert.deepEqual(resolved.plan!.manual!.layout.decisions,{});
 assert.equal(resolved.plan!.manual!.layout.history.at(-1)!.action,'release');assert.equal(resolved.scenario.sequences.length,0);assert.equal(f.scenario.sequences.length,1);assert.deepEqual(f.parent,before);
});
test('unavailable fleet remains visible as an invalid draft and requires release of retained decisions',()=>{
 const f=fixture();f.content.settings!.vehicles[0]!.available=false;const t=f.target(f.content),intent=f.intent(t.ref);
 const r=reviewProfileChange(f.parent,f.scenario,f.context,t.context,intent,actor);assert.ok(r.conflicts.some(c=>c.code==='retained_decision'));assert.equal(r.plan!.stats.servedOrders,2);
 const next=reviewProfileChange(f.parent,f.scenario,f.context,t.context,{...intent,releaseRequestIds:[91]},actor);
 assert.deepEqual(next.conflicts,[]);assert.equal(next.plan!.provenance.validation.valid,false);assert.deepEqual(next.scenario.manualDecisions!.unavailableVehicleIds,[7]);
 assert.deepEqual(next.scenario.removedVehicleIds,[],'do not convert profile availability into permanent operator exclusions');
});
test('unknown resolution IDs, duplicate choices, malformed bodies and cross-dataset contexts fail closed',()=>{
 const f=fixture(),t=f.target(f.content),intent=f.intent(t.ref);
 for(const patch of [{releaseRequestIds:[999]},{unlockVehicleIds:[42]},{clearVehicleOverrideIds:[7]}])assert.throws(()=>reviewProfileChange(f.parent,f.scenario,f.context,t.context,{...intent,...patch},actor));
 for(const bad of [{...intent,reason:' '},{...intent,releaseRequestIds:[91,91]},{...intent,capabilities:[]},{...intent,operationId:'bad\nkey'}])assert.throws(()=>parseProfileChange(bad));
 assert.deepEqual(parseProfileChange(intent),intent);
 const other={...t.context,day:{...t.context.day,datasetRequestSha256:'b'.repeat(64)}};assert.throws(()=>reviewProfileChange(f.parent,f.scenario,f.context,other,intent,actor),/immutable dataset/);
});

test('reviewed operating limits invalidate retained work without changing its placement or relaxing the approved envelope',()=>{
 const f=fixture();f.content.settings!.vehicles[0]!.operatingLimits={...unknownOperatingLimits(),maxDistanceKm:{state:'configured',value:3}};
 const t=f.target(f.content),intent=f.intent(t.ref),r=reviewProfileChange(f.parent,f.scenario,f.context,t.context,intent,actor);
 assert.equal(r.plan!.stats.totalDistanceKm,4.5);assert.equal(r.plan!.provenance.validation.valid,false);assert.ok(r.conflicts.some(c=>c.code==='retained_decision'&&c.requestId===91));
 const next=reviewProfileChange(f.parent,f.scenario,f.context,t.context,{...intent,releaseRequestIds:[91]},actor);
 assert.deepEqual(next.conflicts,[]);assert.equal(next.plan!.provenance.validation.valid,false);assert.deepEqual(next.plan!.manual!.layout.routes,f.parent.manual!.layout.routes);
 assert.deepEqual(new Map(next.scenario.manualDecisions!.operatingLimits).get(7)!.maxDistanceKm,{state:'configured',value:3});
 assert.doesNotThrow(()=>prepareManualInput(next.plan!,next.scenario,t.context));
});
for(const restriction of ['gross-weight','tail-lift'] as const)test(`reviewed site ${restriction} restrictions affect validation and require explicit decision release`,()=>{
 const f=fixture();if(restriction==='tail-lift'){
  f.context.vehicleInfo.get('V7')!.hasTailLift=false;f.context.day.request.vehicles[0]!.has_tail_lift=false;
  f.scenario.manualDecisions!.fleetInfo=[...f.context.vehicleInfo];
 }
 const location:ProfileContent={schemaVersion:1,kind:'locations',label:'Reviewed access',reason:'Verified site access',datasetSha256:'a'.repeat(64),locations:[{locationId:1,maxGrossWeightKg:restriction==='gross-weight'?7500:null,requiresTailLift:restriction==='tail-lift',serviceSeconds:60,windowStartSeconds:0,windowEndSeconds:10000,reason:'Public access evidence'}]};
 const t=f.target(location),intent=f.intent(t.ref),r=reviewProfileChange(f.parent,f.scenario,f.context,t.context,intent,actor);
 assert.equal(r.plan!.stats.servedOrders,2);assert.equal(r.plan!.provenance.validation.valid,false);assert.ok(r.conflicts.some(c=>c.code==='retained_decision'&&c.requestId===91));
 const next=reviewProfileChange(f.parent,f.scenario,f.context,t.context,{...intent,releaseRequestIds:[91]},actor);
 assert.deepEqual(next.conflicts,[]);assert.equal(next.plan!.provenance.validation.valid,false);assert.equal(next.plan!.stats.servedOrders,2);
});
