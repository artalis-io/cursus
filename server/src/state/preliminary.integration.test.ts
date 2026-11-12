import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {S3Client,CreateBucketCommand} from '@aws-sdk/client-s3';
import {StatefulStore} from './postgres.js';
import {ObjectStore} from './objects.js';
import {createStatefulApi} from './api.js';
import {admittedManualDatasetLoader} from './manual-dataset.js';
import {solveConvertedDataset,type ConvertedManifest} from './conversion.js';
import {manualFixture} from './manual-fixture.js';
import {config} from '../config.js';
import type {Scenario} from '../store.js';
import type {Plan} from '../types.js';

test('two servers admit additive preliminary days, run native split windows, edit and replan without approving unknown facts',{
 skip:!process.env.CURSUS_TEST_DATABASE_URL||!process.env.CURSUS_TEST_S3_ENDPOINT||!process.env.CURSUS_TEST_SURGE_BIN,
},async()=>{
 const tenant='preliminary-'+randomUUID(),bucket='preliminary-'+randomUUID(),endpoint=process.env.CURSUS_TEST_S3_ENDPOINT!;
 const stores=[new StatefulStore(process.env.CURSUS_TEST_DATABASE_URL!),new StatefulStore(process.env.CURSUS_TEST_DATABASE_URL!)],a=stores[0]!,b=stores[1]!;
 const objects=new ObjectStore(bucket,{endpoint,accessKeyId:'integration',secretAccessKey:'integration'}),s3=new S3Client({endpoint,region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:'integration',secretAccessKey:'integration'}});
 const f=manualFixture(),request=structuredClone(f.context.day.request);request.tasks[0]!.tw_late=600;request.tasks[0]!.time_windows=[{early:0,late:50},{early:300,late:600}];
 const settings={tariff:f.context.tariff,vehicles:request.vehicles.map(v=>({id:v.id,ref:v.ref,hasTailLift:true,tonnage:12,isSubcontractor:false,vehicleClass:null,reloadSec:120}))};
 const source={schemaVersion:1,days:[{dayId:'new-public-day',isoDate:'2026-10-26'}],surgeRequest:request,
  geocoded:request.requests.map((r,i)=>({request_id:r.id,order_no:request.tasks[i]!.ref,delivery_date:'2026-10-26',requires_tail_lift:null,max_gross_weight_kg:null,customer:'Public source'})),
  planningSettings:settings,planningEvidence:{version:1,sourceSha256:'b'.repeat(64),pricing:'unverified',issues:[{code:'tariff',message:'Not verified.'},...request.requests.map(r=>({code:'tail_lift',requestId:r.id,message:'Unknown source requirement.'}))]}};
 const old={bin:config.surgeBin,velo:config.veloOrigin};(config as {surgeBin:string}).surgeBin=process.env.CURSUS_TEST_SURGE_BIN!;(config as {veloOrigin:string}).veloOrigin='http://127.0.0.1:1';
 const apps:Awaited<ReturnType<typeof createStatefulApi>>[]=[],origins:string[]=[];
 async function post<T>(node:number,path:string,body:unknown,revision?:number):Promise<T>{const r=await fetch(origins[node]+path,{method:'POST',headers:{'content-type':'application/json',...(revision===undefined?{}:{'if-match':`"${revision}"`})},body:JSON.stringify(body)});assert.ok(r.ok,`${path}: ${r.status} ${r.ok?'':await r.text()}`);return await r.json() as T;}
 try{
  await a.migrate();await a.ensureTenant(tenant,'Public preliminary test');await s3.send(new CreateBucketCommand({Bucket:bucket}));
  // A prior day stays immutable and selectable when new data is admitted.
  const legacy={...f.scenario,id:'legacy-base',kind:'base' as const,day:'legacy-day'};await a.createScenario(tenant,legacy.id,legacy);
  const prior={...f.parent,id:'legacy-plan',scenarioId:legacy.id,day:'2026-05-06'};await a.pool.query('INSERT INTO plans(tenant_id,id,scenario_id,scenario_revision,body) VALUES($1,$2,$3,1,$4)',[tenant,prior.id,legacy.id,prior]);const original=JSON.stringify(await b.getPlan(tenant,prior.id));
  const wrongFallback={...f.context,datasetSha256:'f'.repeat(64)};
  for(const store of stores){const app=await createStatefulApi({store,tenantId:tenant,tenantName:'Public preliminary',objects,fleetSettings:wrongFallback,manualPlanning:admittedManualDatasetLoader(store,objects,tenant,wrongFallback)});apps.push(app);origins.push(await app.listen({host:'127.0.0.1',port:0}));}
  const form=new FormData();form.set('file',new Blob([JSON.stringify(source)],{type:'application/json'}),'public.json');const uploaded=await fetch(origins[0]+'/api/import/upload',{method:'POST',body:form});assert.equal(uploaded.status,201);const {datasetId}=await uploaded.json() as {datasetId:string};
  await post(1,`/api/import/datasets/${datasetId}/validate`,{});const admitted=await post<{manifest:ConvertedManifest}>(0,`/api/import/datasets/${datasetId}/admit`,{});
  const scenario:Scenario={...f.scenario,id:'new-base',kind:'base',day:'new-public-day',datasetBinding:{datasetId,dayId:'new-public-day',requestSha256:admitted.manifest.artifacts!.request!.sha256}};await a.createScenario(tenant,scenario.id,scenario);
  const job=await post<{jobId:string}>(0,`/api/scenarios/${scenario.id}/solve`,{budgetSec:3},1);const lease=await a.claimJob('solve','preliminary-native',30,tenant);assert.equal(lease!.id,job.jobId);
  const solved=await solveConvertedDataset(objects,tenant,admitted.manifest,scenario,3,'vehicles',AbortSignal.timeout(30000),false,wrongFallback);assert.equal(solved.stats.servedOrders,2);assert.equal(solved.cost,null);assert.ok(solved.provenance.planningEvidence);
  const first=solved.vehicles.flatMap(v=>v.trips.flatMap(t=>t.stops)).find(s=>s.requestId===91)!;assert.ok(first.serviceStartSec>=300&&first.serviceStartSec<=600);assert.equal(first.requiresTailLift,null);assert.deepEqual(first.timeWindows,request.tasks[0]!.time_windows);
  await b.completeSolve(lease!,solved.id,scenario.id,1,solved);
  const loaded=await fetch(origins[1]+`/api/plans/${solved.id}`);assert.equal(loaded.status,200);assert.equal((await loaded.json() as Plan).cost,null);
  const manual=await fetch(origins[0]+`/api/plans/${solved.id}/manual-context`);assert.equal((await manual.json() as {enabled:boolean}).enabled,true,'must use its own dataset fleet, not May fallback');
  const edited=await post<Plan>(1,`/api/scenarios/${scenario.id}/manual-plan`,{parentPlanId:solved.id,batch:{operationId:'public-deassign',datasetSha256:solved.provenance.datasetSha256,commands:[{op:'deassign',requestId:92}]}},1);
  assert.equal(edited.cost,null);assert.equal(edited.stats.servedOrders,1);assert.ok(edited.provenance.planningEvidence);
  const current=await b.getScenario(tenant,edited.scenarioId);assert.ok(current);
  const replanned=await solveConvertedDataset(objects,tenant,admitted.manifest,current!,3,'vehicles',AbortSignal.timeout(30000),false,wrongFallback,edited);assert.equal(replanned.cost,null);assert.equal(replanned.stats.servedOrders,1);assert.ok(replanned.provenance.planningEvidence);
  // Even a stripped plan warning cannot bypass authoritative source gating.
  const stripped=structuredClone(solved);stripped.id='stripped';delete stripped.provenance.planningEvidence;delete stripped.provenance.datasetSha256;
  stripped.vehicles.forEach(v=>v.trips.forEach(t=>t.stops.forEach(s=>{s.requiresTailLift=false;})));
  await a.pool.query('INSERT INTO plans(tenant_id,id,scenario_id,scenario_revision,body) VALUES($1,$2,$3,1,$4)',[tenant,stripped.id,scenario.id,stripped]);
  const proof=await fetch(origins[1]+`/api/plans/${stripped.id}/workflow`);assert.ok(JSON.stringify(await proof.json()).includes('Admitted dataset contains unresolved'));
  const approved=await fetch(origins[0]+`/api/plans/${stripped.id}/export.csv?approval=required`);assert.equal(approved.status,409);
  const draft=await fetch(origins[1]+`/api/plans/${solved.id}/export.csv`);assert.equal(draft.status,200);assert.ok((await draft.text()).includes('window_intervals'));
  assert.equal(JSON.stringify(await b.getPlan(tenant,prior.id)),original);const days=await fetch(origins[0]+'/api/days');assert.equal((await days.json() as unknown[]).length,2);
 }finally{await Promise.all(apps.map(app=>app.close()));objects.close();s3.destroy();await Promise.all(stores.map(s=>s.close()));(config as {surgeBin:string}).surgeBin=old.bin;(config as {veloOrigin:string}).veloOrigin=old.velo;}
});
