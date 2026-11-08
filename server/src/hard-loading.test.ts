import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {loadingFixture} from './state/loading-fixture.js';
import {attachHardLoading,certifyLoading,loadingBlockers,digest} from './hard-loading.js';
import {nativeSolveRequest} from './state/solver-ids.js';
import {mapSolutionToPlan} from './plan/mapper.js';
import {approvalBlockers} from './state/plan-workflow.js';
import {constraintSnapshot} from './handoff.js';
import {prepareManualInput,evaluateManualInput,materializeManualPlan} from './plan/manual-adapter.js';
import {applyManualBatch} from './plan/manual.js';
import type {SurgeSolution} from './types.js';

const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
function fixture(){
 const f=loadingFixture();f.context.day.physicalLoading=f.document;f.context.day.physicalLoadingSha256=hash(JSON.stringify(f.document));f.context.day.datasetRequestSha256=f.sha;
 // Explicit witness for the fixture's ordered rear-unload deliveries.
 const result={version:1 as const,mode:'hard' as const,node_budget:10000,rounds:[{vehicle_id:7,trip_index:0,outcome:'feasible' as const,reason:'witness',nodes:2,placements:[{request_id:91,unit_index:0,slot:0,layer:1},{request_id:92,unit_index:0,slot:0,layer:0}]}],unassigned_checks:[]};
 const request=structuredClone(f.request);attachHardLoading(request,f.document);
 const plan=structuredClone(f.parent);plan.provenance.datasetSha256=f.sha;
 plan.physicalLoading=certifyLoading(plan,f.scenario,f.document,f.context.day.physicalLoadingSha256,'a'.repeat(64),'b'.repeat(64),result,request);
 return {...f,plan};
}
function rehash(plan:ReturnType<typeof fixture>['plan']){
 if(plan.physicalLoading?.mode==='hard'&&plan.physicalLoading.certificate){const {sha256,...body}=plan.physicalLoading.certificate;void sha256;plan.physicalLoading.certificate.sha256=digest(body);}
}
test('hard witness binds real immutable facts, scenario, executable, scoped IDs and exact ordered round',()=>{
 const f=fixture();assert.deepEqual(loadingBlockers(f.plan,f.scenario),[]);
 assert.equal(f.plan.physicalLoading?.mode,'hard');assert.equal(constraintSnapshot(f.plan,f.scenario,'matching-revision').physicalLoading?.mode,'hard');
 for(const mutate of [
  (p:typeof f.plan)=>p.vehicles[0]!.trips[0]!.stops.reverse(),
  (p:typeof f.plan)=>p.scenarioRevision++,
  (p:typeof f.plan)=>p.provenance.datasetSha256='d'.repeat(64),
  (p:typeof f.plan)=>{if(p.physicalLoading?.mode==='hard')p.physicalLoading.sourceSha256='d'.repeat(64);},
  (p:typeof f.plan)=>{if(p.physicalLoading?.mode==='hard')p.physicalLoading.certificate!.result.rounds[0]!.outcome='unknown';},
  (p:typeof f.plan)=>{if(p.physicalLoading?.mode==='hard')p.physicalLoading.certificate!.result.rounds[0]!.placements[0]!.layer=0;},
  (p:typeof f.plan)=>{if(p.physicalLoading?.mode==='hard')p.physicalLoading.certificate!.requestIds.push(999);},
 ]){const changed=structuredClone(f.plan);mutate(changed);rehash(changed);assert.ok(loadingBlockers(changed,f.scenario).length);assert.ok(approvalBlockers(changed,f.scenario.revision,f.scenario).some(x=>x.startsWith('Physical loading:')));}
 const edited=structuredClone(f.scenario);edited.removedVehicleIds=[42];assert.ok(loadingBlockers(f.plan,edited).length);
 const missing=structuredClone(f.plan);delete missing.physicalLoading;assert.ok(loadingBlockers(missing,f.scenario,f.context.day.physicalLoadingSha256).length);
});
test('day-scoped sparse native IDs restore round/placement and unassigned diagnostics to dataset IDs',()=>{
 const f=fixture();f.request.vehicles=f.request.vehicles.filter(v=>v.id===42);f.request.requests=f.request.requests.filter(r=>r.id===92);
 attachHardLoading(f.request,f.document);const mapped=nativeSolveRequest(f.request);
 assert.equal(mapped.request.loading?.vehicles[0]?.vehicle_id,0);assert.equal(mapped.request.loading?.requests[0]?.request_id,0);
 const result=mapped.restore({status:'OK',stats:{},routes:[],unassigned:[0],loading:{version:1,mode:'hard',node_budget:10000,rounds:[],unassigned_checks:[{request_id:0,scope:'loading_alone_not_route_insertability',diagnostic_node_budget:128,feasible_vehicles:1,infeasible_vehicles:0,unknown_vehicles:0}]}});
 assert.deepEqual(result.unassigned,[92]);assert.equal(result.loading?.unassigned_checks[0]?.request_id,92);
 const invalid=structuredClone(result);invalid.loading!.unassigned_checks[0]!.request_id=999;assert.throws(()=>mapped.restore(invalid),/identity/);
});
test('manual layouts invalidate rather than inherit certificates, while retaining a saveable invalid draft',()=>{
 const f=fixture(),input=prepareManualInput(f.plan,f.scenario,f.context),before=structuredClone(input.layout);
 input.layout=applyManualBatch(input.layout,{operationId:'physical-edit',datasetSha256:f.sha,commands:[{op:'deassign',requestId:91}]},{actorId:'test',at:'2026-11-08T00:00:00Z'});
 const evaluation=evaluateManualInput(input,before,f.scenario),plan=materializeManualPlan(f.plan,f.scenario,input,evaluation,f.context,'draft','2026-11-08T00:00:00Z');
 assert.equal(plan.physicalLoading?.mode,'hard');assert.equal(plan.physicalLoading?.status,'stale');assert.equal(plan.provenance.validation.valid,false);assert.ok(loadingBlockers(plan,f.scenario).length);
 assert.equal(f.plan.physicalLoading?.status,'feasible');
});
const binary=process.env.CURSUS_TEST_SURGE_BIN;
test('real HGS emits independently verified sparse-ID loading witnesses; UNKNOWN cannot become a plan',{skip:!binary||!existsSync(binary)},()=>{
 const f=loadingFixture();f.context.day.datasetRequestSha256=f.sha;
 attachHardLoading(f.request,f.document);const n=nativeSolveRequest(f.request),directory=mkdtempSync(join(tmpdir(),'cursus-hard-'));
 try{
  n.request.config={...n.request.config,max_time_seconds:1,max_iterations:100,population:true,population_threads:2,population_generations:2};
  const path=join(directory,'request.json');writeFileSync(path,JSON.stringify(n.request));
  const solution=n.restore(JSON.parse(execFileSync(binary!,[path],{encoding:'utf8',timeout:30000})) as SurgeSolution);
  const plan=mapSolutionToPlan({day:f.context.day,request:f.request,solution,enrichment:f.context.day.enrichment,vehicleInfo:f.context.vehicleInfo,scenarioId:f.scenario.id,scenarioRevision:f.scenario.revision,planId:'native',source:'live',createdAt:f.parent.createdAt});
  plan.provenance.datasetSha256=f.sha;plan.physicalLoading=certifyLoading(plan,f.scenario,f.document,hash(JSON.stringify(f.document)),hash(JSON.stringify(n.request)),hash('test executable identity'),solution.loading,f.request);
  assert.deepEqual(loadingBlockers(plan,f.scenario),[]);
  f.request.loading!.node_budget=1;n.request.loading!.node_budget=1;writeFileSync(path,JSON.stringify(n.request));
  const unknown=n.restore(JSON.parse(execFileSync(binary!,[path],{encoding:'utf8',timeout:30000})) as SurgeSolution);
  const unassigned=mapSolutionToPlan({day:f.context.day,request:f.request,solution:unknown,enrichment:f.context.day.enrichment,vehicleInfo:f.context.vehicleInfo,scenarioId:f.scenario.id,scenarioRevision:f.scenario.revision,planId:'unknown',source:'live',createdAt:f.parent.createdAt});unassigned.provenance.datasetSha256=f.sha;
  assert.throws(()=>certifyLoading(unassigned,f.scenario,f.document,hash(JSON.stringify(f.document)),hash('input'),hash('binary'),unknown.loading,f.request),/UNKNOWN/);
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('witness replay rejects forged feasible results for each physical constraint',()=>{
 for(const mutate of [
  (f:ReturnType<typeof fixture>)=>{for(const v of f.document.vehicles)v.clearanceMm=999;},
  (f:ReturnType<typeof fixture>)=>{for(const v of f.document.vehicles)v.payloadG=100;},
  (f:ReturnType<typeof fixture>)=>{for(const v of f.document.vehicles)v.maxStackWeightG=100;},
  (f:ReturnType<typeof fixture>)=>{for(const v of f.document.vehicles)v.allowedTop=[[]];},
  (f:ReturnType<typeof fixture>)=>{for(const r of f.document.requests)for(const u of r.units)u.maxUnitsAbove=0;},
  (f:ReturnType<typeof fixture>)=>{for(const r of f.document.requests)for(const u of r.units)u.maxWeightAboveG=0;},
 ]){
  const f=fixture();mutate(f);attachHardLoading(f.request,f.document);if(f.plan.physicalLoading?.mode!=='hard')throw Error('certificate required');
  const result=f.plan.physicalLoading.certificate!.result;
  assert.throws(()=>certifyLoading(f.plan,f.scenario,f.document,hash(JSON.stringify(f.document)),hash('request'),hash('binary'),result,f.request),/Physical loading:/);
 }
});
