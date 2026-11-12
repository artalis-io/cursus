import {suggestPlacements} from './plan/manual-suggestions.js';
import {veloRouteCoordinates} from './geometry/velo.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {preparedBundle} from './state/prepared-bundle.js';
import {manualFixture} from './state/manual-fixture.js';
import {prepareManualInput,materializeManualPlan} from './plan/manual-adapter.js';
import {evaluateManualLayout} from './plan/manual-evaluate.js';
import {nativeSolveRequest} from './state/solver-ids.js';
import {serviceWindows,serviceWindowStart,windowContains} from './time-windows.js';
import {parsePlanningEvidence,withPlanningEvidence} from './planning-evidence.js';
import {approvalBlockers} from './state/plan-workflow.js';
import {planToCsv} from './export.js';
import {constraintSnapshot} from './handoff.js';
import type {PlanningEvidence} from './planning-evidence-contract.js';
const evidence=():PlanningEvidence=>({version:1,sourceSha256:'b'.repeat(64),pricing:'unverified',issues:[{code:'tariff',message:'Tariff not verified.'},{code:'tail_lift',requestId:91,message:'Requirement unknown.'}]});
function bundle(){
 const f=manualFixture(),r=structuredClone(f.context.day.request);
 const settings={datasetSha256:undefined,tariff:f.context.tariff,vehicles:r.vehicles.map(v=>({id:v.id,ref:v.ref,hasTailLift:true,tonnage:12,isSubcontractor:false,vehicleClass:null,reloadSec:120}))};
 return {schemaVersion:1,days:[{dayId:'public',isoDate:'2026-10-26'}],surgeRequest:r,geocoded:r.requests.map(order=>({request_id:order.id,order_no:r.tasks.find(t=>t.id===order.delivery_task_id)!.ref,delivery_date:'2026-10-26',requires_tail_lift:false as boolean|null,max_gross_weight_kg:null})),planningSettings:settings,planningEvidence:evidence()};
}
test('disjoint intervals wait through a closed gap and reject overlap/envelope drift',()=>{
 const t={tw_early:0,tw_late:600,time_windows:[{early:0,late:50},{early:300,late:600}]};
 assert.equal(serviceWindowStart(100,serviceWindows(t)),300);assert.equal(windowContains(100,serviceWindows(t)),false);
 assert.throws(()=>serviceWindows({...t,tw_late:700}));assert.throws(()=>serviceWindows({...t,time_windows:[{early:0,late:400},{early:300,late:600}]}));
});
test('prepared import preserves null facts, normalizes only the interval envelope and does not mutate upload',()=>{
 const b=bundle();b.geocoded[0]!.requires_tail_lift=null;const task=b.surgeRequest.tasks[0]!;
 const raw=task as Partial<typeof task>;delete raw.tw_early;delete raw.tw_late;task.time_windows=[{early:0,late:50},{early:300,late:600}];
 const before=JSON.stringify(b),prepared=preparedBundle(b);assert.equal(JSON.stringify(b),before);assert.equal(prepared.geocoded[0]!.requires_tail_lift,null);
 assert.equal(prepared.request.tasks[0]!.tw_late,600);assert.deepEqual(prepared.request.tasks[0]!.time_windows,task.time_windows);
 const native=nativeSolveRequest(prepared.request).request.tasks[0]!;assert.equal('tw_early' in native,false);assert.equal('tw_late' in native,false);assert.deepEqual(native.time_windows,task.time_windows);
});
test('unknown requirements cannot bypass strict admission without scoped evidence and own fleet settings',()=>{
 const b=bundle();b.geocoded[0]!.requires_tail_lift=null;
 assert.throws(()=>preparedBundle({...b,planningEvidence:undefined}));
 assert.throws(()=>preparedBundle({...b,planningSettings:undefined}));
 const bad=evidence();bad.issues[1]!.requestId=92;assert.throws(()=>preparedBundle({...b,planningEvidence:bad}));
 assert.throws(()=>parsePlanningEvidence({...evidence(),issues:[...evidence().issues,{code:'tail_lift',requestId:91,message:'Duplicate'}]},b.surgeRequest));
 assert.throws(()=>parsePlanningEvidence({...evidence(),issues:[{code:'tariff',message:'x'},{code:'tail_lift',requestId:999,message:'Foreign'}]},b.surgeRequest));
});
test('manual editing uses disjoint intervals and retains unknown facts, cost unavailability and approval blockers',()=>{
 const f=manualFixture(),task=f.context.day.request.tasks[0]!;task.tw_late=600;task.time_windows=[{early:0,late:50},{early:300,late:600}];
 f.context.day.planningEvidence=evidence();f.context.day.enrichment.get(task.ref)!.requiresTailLift=null;
 const input=prepareManualInput(f.parent,f.scenario,f.context),ev=evaluateManualLayout(input);
 assert.equal(ev.vehicles[0]!.trips[0]!.stops[0]!.serviceStartSec,300);assert.equal(ev.validation.valid,true);
 const p=materializeManualPlan(f.parent,f.scenario,input,ev,f.context,'new','2026-10-26T00:00:00Z');
 assert.equal(p.vehicles[0]!.trips[0]!.stops[0]!.requiresTailLift,null);assert.equal(p.cost,null);
 assert.deepEqual(p.vehicles[0]!.trips[0]!.stops[0]!.timeWindows,task.time_windows);
 assert.ok(approvalBlockers(p,1,f.scenario).some(s=>s.includes('unresolved')));
 const csv=planToCsv(p);assert.ok(csv.includes('window_intervals'));assert.ok(csv.includes('00:00–00:01 / 00:05–00:10'));
 const handoff=constraintSnapshot(p,f.scenario,'matching-revision');assert.equal(handoff.planningEvidence!.sourceSha256,'b'.repeat(64));
 assert.deepEqual(handoff.vehicles[0]!.trips[0]!.stops[0]!.timeWindows,task.time_windows);
});
test('manual planning cannot discard native qualification restrictions',()=>{
 const f=manualFixture();f.context.day.request.requests[0]!.required_qualifications=2;f.context.day.request.vehicles[0]!.qualifications=0;
 const input=prepareManualInput(f.parent,f.scenario,f.context),ev=evaluateManualLayout(input);assert.equal(ev.validation.valid,false);assert.ok(ev.validation.violations.some(v=>v.type==='ASSIGNMENT'));
});
test('legacy plans without preliminary evidence preserve their cost and approval behavior',()=>{
 const f=manualFixture(),before=JSON.stringify(f.parent);assert.equal(withPlanningEvidence(f.parent,f.context.day),f.parent);assert.equal(JSON.stringify(f.parent),before);assert.ok(f.parent.cost);
});

test('successful zero-length Velo routes need no encoded line; missing or failed routes stay missing',()=>{
 assert.deepEqual(veloRouteCoordinates({status:'ok',route:{distance:0,duration:0}},[19,47]),[[19,47]]);
 for(const response of [{status:'error',route:{distance:0,duration:0}},{status:'ok',route:{distance:10,duration:0}},{status:'ok',route:{distance:0,duration:10}},{status:'ok',route:{}}])assert.equal(veloRouteCoordinates(response,[19,47]),null);
});

test('legacy scalar zero deadline retains its no-deadline semantics during manual evaluation',()=>{
 const f=manualFixture();f.context.day.request.tasks[0]!.tw_early=0;f.context.day.request.tasks[0]!.tw_late=0;
 const result=evaluateManualLayout(prepareManualInput(f.parent,f.scenario,f.context));
 assert.equal(result.validation.valid,true);assert.equal(result.vehicles[0]!.trips[0]!.stops[0]!.lateSec,0);
});

test('preliminary insertion suggestions preserve feasibility without reporting invented monetary deltas',async()=>{
 const f=manualFixture();f.context.day.planningEvidence=evidence();const input=prepareManualInput(f.parent,f.scenario,f.context);
 const route=input.layout.routes.find(r=>r.requestIds.includes(92))!;route.requestIds=route.requestIds.filter(id=>id!==92);input.layout.unassigned.push(92);
 const result=await suggestPlacements(input,f.scenario,92,{parentPlanId:f.parent.id,newTripId:'public-preview'});
 assert.ok(result.suggestions.length>0);assert.equal(result.baseline.cost,null);assert.ok(result.suggestions.every(s=>s.delta.cost===null));
});
