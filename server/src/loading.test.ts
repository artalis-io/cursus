import test from 'node:test';
import assert from 'node:assert/strict';
import {loadingFixture} from './state/loading-fixture.js';
import {prepareManualInput,evaluateManualInput,materializeManualPlan} from './plan/manual-adapter.js';
import {applyManualBatch} from './plan/manual.js';
import {mapSolutionToPlan} from './plan/mapper.js';
import {createHash} from 'node:crypto';
import {validateLoading,loadingSnapshot} from './loading.js';
import {preparedBundle} from './state/prepared-bundle.js';
import {DatasetRepository} from './state/datasets.js';
import {loadConvertedDay} from './state/conversion.js';
import type {StatefulStore} from './state/postgres.js';
import type {ObjectStore,ImmutableObject} from './state/objects.js';
test('physical facts are immutable and dataset-bound; import never enables native loading',()=>{
 const f=loadingFixture(),before=structuredClone(f.bundle),result=preparedBundle(f.bundle);
 assert.deepEqual(f.bundle,before);assert.deepEqual(result.physicalLoading,f.document);assert.ok(!('loading' in result.request));
 assert.equal(result.requestBytes.toString(),JSON.stringify(f.request));
 assert.equal(preparedBundle({...f.bundle,physicalLoading:undefined}).physicalLoading,undefined);
 assert.throws(()=>preparedBundle({...f.bundle,surgeRequest:{...f.request,loading:{mode:'hard'}}}),/not enabled/);
});
test('malformed, incomplete, inferred and foreign physical declarations fail closed',()=>{
 const changes:((d:any)=>void)[]=[d=>d.mode='hard',d=>d.datasetSha256='b'.repeat(64),d=>d.requests.pop(),d=>d.vehicles.pop(),d=>d.requests[1].requestId=91,d=>d.vehicles[1].vehicleId=7,d=>d.vehicles[0].slotCount=129,d=>d.vehicles[0].maxLayers=9,d=>d.vehicles[0].slots[0].depth=-1,d=>d.vehicles[0].access='guess',d=>d.vehicles[0].allowedTop=[[64]],d=>d.vehicles[0].allowedTop=[[0,0]],d=>d.requests[0].units[0].heightMm=0,d=>d.requests[0].units[0].weightG=1.2,d=>d.requests[0].units[0].weightG=Number.MAX_SAFE_INTEGER+1,d=>d.requests[0].units[0].stackClass=1,d=>delete d.requests[0].units[0].maxUnitsAbove,d=>d.requests[0].units.push(d.requests[0].units[0]),d=>d.requests[0].units[0].quantity=.5,d=>d.guessedGeometry=true];
 for(const change of changes){const f=loadingFixture();change(f.document);assert.throws(()=>validateLoading(f.document,f.request,f.sha));}
});
test('round counts use request identities rather than order IDs or repeated display references',()=>{
 const f=loadingFixture(),vehicles=structuredClone(f.parent.vehicles);vehicles[0]!.trips[0]!.stops.forEach(s=>{s.orderId='not-a-request';s.orderNo='REPEATED';});
 const snapshot=loadingSnapshot(f.document,'c'.repeat(64),vehicles);
 assert.equal(snapshot.rounds[0]!.unitCount,2);assert.equal(snapshot.status,'not_evaluated');assert.equal(snapshot.mode,'disabled');
 vehicles[0]!.trips[0]!.stops.pop();assert.equal(loadingSnapshot(f.document,'c'.repeat(64),vehicles).rounds[0]!.unitCount,1);
});
test('admission retains immutable loading bytes; independent loaders share facts without enabling hard mode',async()=>{
 const f=loadingFixture(),tenant='public-loading',memory=new Map<string,Buffer>();let row:any=null;
 const objects={async putImmutable(t:string,bytes:Uint8Array,mediaType:string){const b=Buffer.from(bytes),sha256=createHash('sha256').update(b).digest('hex'),key=`tenants/${t}/sha256/${sha256}`;memory.set(key,b);return {key,sha256,size:b.length,mediaType};},async getVerified(o:ImmutableObject){const b=memory.get(o.key);assert.ok(b);assert.equal(createHash('sha256').update(b).digest('hex'),o.sha256);return b;}} as unknown as ObjectStore;
 const db={async stageObject(){},async createDatasetUpload(t:string,id:string,manifest:unknown){assert.equal(t,tenant);row={id,status:'uploaded',manifest};},async getDataset(t:string,id:string){return t===tenant&&row?.id===id?structuredClone(row):null;},async validateDataset(t:string,id:string,manifest:unknown){row={id,status:'validated',manifest};},async publishDataset(t:string,id:string,manifest:unknown){row={id,status:'admitted',manifest};}} as unknown as StatefulStore;
 const a=new DatasetRepository(db,objects,tenant),b=new DatasetRepository(db,objects,'other');
 const upload=await a.upload(Buffer.from(JSON.stringify(f.bundle)),'application/json');assert.equal(await b.get(upload.datasetId),null);
 await assert.rejects(()=>a.admit(upload.datasetId),/validated/);await a.validate(upload.datasetId);await a.admit(upload.datasetId);
 assert.equal(row.status,'admitted');assert.ok(row.manifest.artifacts.physicalLoading);
 const [one,two]=await Promise.all([loadConvertedDay(objects,tenant,row.manifest,f.scenario),loadConvertedDay(objects,tenant,row.manifest,f.scenario)]);
 assert.deepEqual(one.physicalLoading,two.physicalLoading);assert.ok(!('loading' in one.request));assert.deepEqual(one.physicalLoading,f.document);
 await assert.rejects(()=>loadConvertedDay(objects,'other',row.manifest,f.scenario),/tenant/);
 const foreign=structuredClone(row.manifest);foreign.artifacts.physicalLoading.key=foreign.artifacts.physicalLoading.key.replace('/public-loading/','/other/');
 await assert.rejects(()=>loadConvertedDay(objects,tenant,foreign,f.scenario),/loading artifact.*tenant/);
 const changed=structuredClone(row.manifest);changed.artifacts.physicalLoading.sha256='b'.repeat(64);await assert.rejects(()=>loadConvertedDay(objects,tenant,changed,f.scenario));
});

test('manual layouts rebuild round facts and never reuse stale loading evidence',()=>{
 const f=loadingFixture();f.context.day.datasetRequestSha256=f.sha;f.parent.provenance.datasetSha256=f.sha;
 f.context.day.physicalLoading=f.document;f.context.day.physicalLoadingSha256='c'.repeat(64);
 f.parent.physicalLoading={...loadingSnapshot(f.document,'c'.repeat(64),f.parent.vehicles),rounds:[]};
 const input=prepareManualInput(f.parent,f.scenario,f.context),old=structuredClone(input.layout);
 input.layout=applyManualBatch(input.layout,{operationId:'loading-deassign',datasetSha256:f.sha,commands:[{op:'deassign',requestId:91}]},{actorId:'test',at:'2026-10-26T00:00:00Z'});
 const evaluation=evaluateManualInput(input,old,f.scenario);
 const plan=materializeManualPlan(f.parent,f.scenario,input,evaluation,f.context,'new','2026-10-26T00:00:00Z');
 assert.equal(plan.physicalLoading?.rounds[0]?.unitCount,1);assert.equal(plan.physicalLoading?.status,'not_evaluated');
 assert.deepEqual(f.parent.physicalLoading.rounds,[]);
});

test('automatic plan mapping preserves metrics and binds round facts to sparse native IDs',()=>{
 const f=loadingFixture();f.context.day.physicalLoading=f.document;f.context.day.physicalLoadingSha256='c'.repeat(64);
 const plan=mapSolutionToPlan({day:f.context.day,request:f.request,solution:f.context.day.solution,enrichment:f.context.day.enrichment,vehicleInfo:f.context.vehicleInfo,scenarioId:f.scenario.id,scenarioRevision:1,planId:'mapped',source:'live',createdAt:f.parent.createdAt});
 assert.deepEqual(plan.stats,f.parent.stats);assert.equal(plan.physicalLoading?.rounds[0]?.unitCount,2);
 assert.equal(plan.physicalLoading?.sourceSha256,'c'.repeat(64));
});
