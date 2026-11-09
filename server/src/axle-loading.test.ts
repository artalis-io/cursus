import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {axleFixture} from './state/loading-fixture.js';
import {validateLoading} from './loading.js';
import {attachHardLoading,certifyLoading,loadingBlockers,digest,assertPlanLoadingRequirement} from './hard-loading.js';
import {AXLE_CAPABILITIES,requireNativeCapabilities,factRequirement,sameRequirement} from './axle-loading.js';
import {nativeSolveRequest} from './state/solver-ids.js';
import {mapSolutionToPlan} from './plan/mapper.js';
import {approvalBlockers} from './state/plan-workflow.js';
import {prepareManualInput,evaluateManualInput,materializeManualPlan} from './plan/manual-adapter.js';
import {applyManualBatch} from './plan/manual.js';
import type {NativeLoadingCapabilities} from './loading-contract.js';
import type {Plan,SurgeSolution} from './types.js';
const hash=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const binary=process.env.CURSUS_TEST_SURGE_BIN;
const enabled=!!binary&&existsSync(binary);
function native(){
 const f=axleFixture();validateLoading(f.document,f.request,f.sha);
 f.context.day.physicalLoading=f.document;f.context.day.physicalLoadingSha256=hash(JSON.stringify(f.document));f.context.day.datasetRequestSha256=f.sha;
 const request=structuredClone(f.request);attachHardLoading(request,f.document);const compact=nativeSolveRequest(request),dir=mkdtempSync(join(tmpdir(),'cursus-axles-'));
 try{
  const caps=JSON.parse(execFileSync(binary!,['--capabilities'],{encoding:'utf8',timeout:5000})) as NativeLoadingCapabilities;requireNativeCapabilities(caps);
  compact.request.config={...compact.request.config,max_time_seconds:1,max_iterations:100,population:true,population_threads:2,population_generations:2};
  const path=join(dir,'request.json');writeFileSync(path,JSON.stringify(compact.request));
  const solution=compact.restore(JSON.parse(execFileSync(binary!,[path],{encoding:'utf8',timeout:30000})) as SurgeSolution);
  const plan=mapSolutionToPlan({day:f.context.day,request,solution,enrichment:f.context.day.enrichment,vehicleInfo:f.context.vehicleInfo,scenarioId:f.scenario.id,scenarioRevision:f.scenario.revision,planId:'axle-native',source:'live',createdAt:f.parent.createdAt});
  plan.provenance.datasetSha256=f.sha;
  plan.physicalLoading=certifyLoading(plan,f.scenario,f.document,f.context.day.physicalLoadingSha256,hash(JSON.stringify(compact.request)),hash(readFileSync(binary!)),solution.loading,request,caps);
  return {...f,plan,solution,caps};
 }finally{rmSync(dir,{recursive:true,force:true});}
}
function rehash(plan:Plan){if(plan.physicalLoading?.mode==='hard'&&plan.physicalLoading.certificate){const {sha256,...body}=plan.physicalLoading.certificate;void sha256;plan.physicalLoading.certificate.sha256=digest(body);}}

test('V2 admission requires explicit supported complete axle, CG, task and capability facts',()=>{
 const f=axleFixture();assert.deepEqual(validateLoading(f.document,f.request,f.sha),f.document);
 const bad:((d:any)=>void)[]=[d=>delete d.requiredCapabilities,d=>d.requiredCapabilities=['stacking'],d=>d.requiredCapabilities.push('bounded_reshuffling'),d=>delete d.vehicles[0].axles,d=>delete d.requests[0].units[0].cgOffsetMm,d=>d.requests[0].deliveryTaskId=999,d=>d.vehicles[0].axles.wheelbaseMm=0,d=>d.vehicles[0].axles.model='trailer',d=>d.vehicles[0].axles.slotCentresMm=[],d=>d.vehicles[0].axles.frontLimitsG.min=-1,d=>d.vehicles[0].axles.profileSha256='guess',d=>d.requests[0].units[0].cgOffsetMm.max=601,d=>d.requests[0].units[0].weightG=1e9+1,d=>d.vehicles[0].axles.minFrontFraction=undefined,d=>d.vehicles[0].axles.maxGrossG='12000000',d=>d.mode='hard'];
 for(const change of bad){const d=structuredClone(f.document);change(d);assert.throws(()=>validateLoading(d,f.request,f.sha),/Physical loading/);}
 const zero=structuredClone(f.document);zero.vehicles[0]!.payloadG=0;assert.equal(validateLoading(zero,f.request,f.sha).vehicles[0]!.payloadG,0);
});
test('approved fleet GVW changes cannot silently relax physical gross limits',()=>{
 const f=axleFixture();f.request.vehicles[0]!.gross_weight_kg=11000;
 assert.throws(()=>validateLoading(f.document,f.request,f.sha),/fleet GVW/);
 assert.throws(()=>attachHardLoading(f.request,f.document),/fleet GVW/);
});
test('durable requirements compare semantically after PostgreSQL JSONB key ordering',()=>{
 const f=axleFixture(),r=factRequirement(f.document,'a'.repeat(64));
 assert.ok(sameRequirement(r,{sourceSha256:r.sourceSha256,requiredCapabilities:[...AXLE_CAPABILITIES].reverse(),version:2}));
 assert.equal(sameRequirement(r,{...r,sourceSha256:'b'.repeat(64)}),false);
 assert.throws(()=>sameRequirement(r,{...r,requiredCapabilities:['stacking']}));
 assert.throws(()=>requireNativeCapabilities({schema_version:2,implemented_capabilities:['stacking'],axle_models:[],limits:{}}));
});
test('native HGS V2 sparse-ID evidence passes independent BigInt replay and capability binding',{skip:!enabled},()=>{
 const f=native();assert.equal(f.solution.loading?.version,2);assert.equal(f.plan.stats.servedOrders,2);assert.deepEqual(loadingBlockers(f.plan,f.scenario),[]);
 assertPlanLoadingRequirement(f.plan,factRequirement(f.document,f.context.day.physicalLoadingSha256!));
 for(const r of f.solution.loading!.rounds){assert.ok([7,42].includes(r.vehicle_id));assert.ok(r.operations!.every(o=>[91,92].includes(o.request_id)));assert.ok(r.stops!.every(s=>[1,2].includes(s.task_id)));}
});
test('forged states, actions, timestamps, capabilities and source changes block approval even after rehash',{skip:!enabled},()=>{
 const f=native();const changes:((p:Plan)=>void)[]=[
 p=>{p.physicalLoading!.requiredCapabilities=['stacking'];},
 p=>{if(p.physicalLoading?.mode==='hard')p.physicalLoading.certificate!.requiredCapabilities=['stacking'];},
 p=>{if(p.physicalLoading?.mode==='hard')p.physicalLoading.certificate!.nativeCapabilities!.implemented_capabilities=['stacking'];},
 p=>{if(p.physicalLoading?.mode==='hard')p.physicalLoading.certificate!.result.rounds[0]!.axle_states![1]!.front_min_g.numerator='9007199254740993';},
 p=>{if(p.physicalLoading?.mode==='hard')p.physicalLoading.certificate!.result.rounds[0]!.operations![0]!.request_id=999;},
 p=>{if(p.physicalLoading?.mode==='hard')p.physicalLoading.certificate!.result.rounds[0]!.operations![0]!.kind='deliver';},
 p=>{if(p.physicalLoading?.mode==='hard')p.physicalLoading.certificate!.result.rounds[0]!.stops![0]!.task_id=999;},
 p=>{p.vehicles[0]!.trips[0]!.stops[0]!.arrivalSec++;},
 p=>{if(p.physicalLoading?.mode==='hard')p.physicalLoading.certificate!.result.version=1;},
 p=>{p.physicalLoading!.sourceSha256='b'.repeat(64);},
 ];
 for(const change of changes){const p=structuredClone(f.plan);change(p);rehash(p);assert.ok(loadingBlockers(p,f.scenario,f.context.day.physicalLoadingSha256).length);assert.ok(approvalBlockers(p,f.scenario.revision,f.scenario).some(s=>s.startsWith('Physical loading:')));}
});
test('manual changes discard axle proofs; draft remains inspectable and cannot be approved',{skip:!enabled},()=>{
 const f=native(),input=prepareManualInput(f.plan,f.scenario,f.context),before=structuredClone(input.layout);
 input.layout=applyManualBatch(input.layout,{operationId:'axle-edit',datasetSha256:f.sha,commands:[{op:'deassign',requestId:91}]},{actorId:'test',at:'2026-11-09T00:00:00Z'});
 const evaluation=evaluateManualInput(input,before,f.scenario),draft=materializeManualPlan(f.plan,f.scenario,input,evaluation,f.context,'axle-draft',f.parent.createdAt);
 assert.equal(draft.physicalLoading?.status,'stale');assert.ok(loadingBlockers(draft,f.scenario).length);assert.equal(draft.physicalLoading?.mode==='hard'&&draft.physicalLoading.certificate,undefined);
});
