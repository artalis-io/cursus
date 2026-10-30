import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {S3Client,CreateBucketCommand} from '@aws-sdk/client-s3';
import {StatefulStore} from './postgres.js';
import {ObjectStore} from './objects.js';
import {createStatefulApi} from './api.js';
import {manualFixture} from './manual-fixture.js';
import {admittedManualDatasetLoader} from './manual-dataset.js';
import {loadConvertedDay,solveConvertedDataset,type ConvertedManifest} from './conversion.js';
import {mapSolutionToPlan} from '../plan/mapper.js';
import {planDigest,PlanWorkflow} from './plan-workflow.js';
import {InputUpdates} from './input-updates.js';
import type {InputUpdateIntent} from '../input-update-contract.js';
import type {Plan} from '../types.js';
import type {Scenario} from '../store.js';
import {config} from '../config.js';
import type {StatefulAuthService} from './auth.js';
import {createHash} from 'node:crypto';
import {TransferRepository} from './transfers.js';
import {parseDestinations} from './handoff-sender.js';
import {ScenarioRepository} from './scenarios.js';
import {ProfileRepository} from './profiles.js';
import type {ProfileRef} from '../planning-profile-contract.js';

const enabled=!!process.env.CURSUS_TEST_DATABASE_URL&&!!process.env.CURSUS_TEST_S3_ENDPOINT;

test('snapshot replacement through two APIs is atomic, idempotent, tenant-scoped and fences the whole previous cycle',{skip:!enabled},async()=>{
 const tenant='inputs-'+randomUUID(),bucket='inputs-'+randomUUID(),f=manualFixture();
 const stores=[new StatefulStore(process.env.CURSUS_TEST_DATABASE_URL!),new StatefulStore(process.env.CURSUS_TEST_DATABASE_URL!)],a=stores[0]!,b=stores[1]!;
 const endpoint=process.env.CURSUS_TEST_S3_ENDPOINT!,objects=new ObjectStore(bucket,{endpoint,accessKeyId:'integration',secretAccessKey:'integration'});
 const s3=new S3Client({endpoint,region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:'integration',secretAccessKey:'integration'}});
 const apps:Awaited<ReturnType<typeof createStatefulApi>>[]=[],origins:string[]=[];
 const oldBin=config.surgeBin;
 async function post<T>(i:number,path:string,body:unknown,revision?:number):Promise<T>{
  const r=await apps[i]!.inject({method:'POST',url:path,payload:JSON.stringify(body),headers:{'content-type':'application/json',...(revision===undefined?{}:{'if-match':`"${revision}"`})}});
  assert.ok(r.statusCode<300,`${path}: ${r.statusCode} ${r.body}`);return r.json() as T;
 }
 async function admit(i:number,changed=false,weight=125){
  const request=structuredClone(f.context.day.request);
  if(changed){request.requests=request.requests.map(r=>({...r,id:r.id+1000}));request.tasks[1]!.demand[0]=weight;
   request.tasks.push({...structuredClone(request.tasks[0]!),id:3,ref:'ORDER-3'});request.requests.push({id:1093,delivery_task_id:3});}
  const bundle={schemaVersion:1,days:[{dayId:changed?'revised-day':f.scenario.day,isoDate:'2026-10-26',label:changed?'Revised day':'Original day'}],surgeRequest:request,
   geocoded:request.requests.map(r=>({request_id:r.id,order_no:request.tasks.find(t=>t.id===r.delivery_task_id)!.ref,delivery_date:'2026-10-26',requires_tail_lift:r.delivery_task_id===1,max_gross_weight_kg:null,customer:'Public fixture'}))};
  const form=new FormData();form.set('file',new Blob([JSON.stringify(bundle)],{type:'application/json'}),'prepared.json');
  const upload=await fetch(origins[i]+'/api/import/upload',{method:'POST',body:form});assert.equal(upload.status,201);
  const {datasetId}=await upload.json() as {datasetId:string};
  await post(i,`/api/import/datasets/${datasetId}/validate`,{});
  const row=await post<{manifest:ConvertedManifest}>(1-i,`/api/import/datasets/${datasetId}/admit`,{});
  return {datasetId,manifest:row.manifest};
 }
 try{
  await a.migrate();await a.ensureTenant(tenant,'Public input update tests');await s3.send(new CreateBucketCommand({Bucket:bucket}));
  for(const store of stores){const app=await createStatefulApi({store,tenantId:tenant,tenantName:'Inputs',objects,inputUpdatesEnabled:true,fleetSettings:f.context,manualPlanning:admittedManualDatasetLoader(store,objects,tenant,f.context)});apps.push(app);origins.push(await app.listen({host:'127.0.0.1',port:0}));}
  const old=await admit(0),next=await admit(1,true);
  async function fleetProfile(manifest:ConvertedManifest):Promise<ProfileRef>{
   const sha=manifest.artifacts!.request!.sha256;
   const p=await post<ProfileRef&{version:number}>(0,'/api/profiles',{content:{schemaVersion:1,kind:'fleet',datasetSha256:sha,label:'Reviewed synthetic fleet',reason:'Verified unchanged inventory',settings:{datasetSha256:sha,tariff:f.context.tariff,
    vehicles:f.context.day.request.vehicles.map(v=>({id:v.id,ref:v.ref,vehicleClass:null,isSubcontractor:false,tonnage:12,hasTailLift:true,reloadSec:120,available:true,capacityKg:1000,capacityPallets:10}))}}},0);
   await post(1,`/api/profiles/${p.id}/activate`,{revision:p.revision},p.version);
   return {id:p.id,kind:'fleet',revision:p.revision,sha256:p.sha256};
  }
  const oldFleet=await fleetProfile(old.manifest),nextFleet=await fleetProfile(next.manifest);
  const base:Scenario={...f.scenario,id:'source-base',kind:'base',planningProfiles:[oldFleet],planningPolicy:{version:1,id:'approved-test-exception',date:'2026-10-26',datasetRequestSha256:old.manifest.artifacts!.request!.sha256,
   approvedAt:new Date().toISOString(),approvedBy:'test-admin',exceptions:[{orderNo:'ORDER-1',reason:'Verified synthetic unloading',originalRequiresTailLift:true,requiresTailLift:false}]}};
  await a.createScenario(tenant,base.id,base);
  const day=await loadConvertedDay(objects,tenant,old.manifest,base,await new ProfileRepository(a,tenant).resolve([oldFleet]));
  const parent=mapSolutionToPlan({day,request:day.request,solution:f.context.day.solution,enrichment:day.enrichment,vehicleInfo:f.context.vehicleInfo,tariff:f.context.tariff,
   scenarioId:base.id,scenarioRevision:base.revision,planId:'source-plan',source:'live',createdAt:new Date().toISOString()});
  await a.pool.query('INSERT INTO plans(tenant_id,id,scenario_id,scenario_revision,body) VALUES($1,$2,$3,1,$4)',[tenant,parent.id,base.id,parent]);
  const source=await post<Plan>(0,`/api/scenarios/${base.id}/manual-plan`,{parentPlanId:parent.id,batch:{operationId:'retained',datasetSha256:day.datasetRequestSha256,commands:[{op:'assign',requestId:91,vehicleId:7,tripId:'trip-0',position:0}]}},1);
  const scenario=(await b.getScenario(tenant,source.scenarioId))!,sourceDigest=planDigest(source);
  const workflow=new PlanWorkflow(a,tenant);
  await workflow.transition(source.id,'plan.review',0,scenario.revision,true);
  await workflow.transition(source.id,'plan.approve',1,scenario.revision,true);
  const intent:InputUpdateIntent={operationId:'revision-one',parentPlanId:source.id,datasetId:next.datasetId,dayId:'revised-day',reason:'Reviewed revised orders',matches:[{from:91,to:1091},{from:92,to:1092}],
   releaseRequestIds:[],unlockVehicleIds:[],profiles:[nextFleet],identityReviewed:true,carryExceptions:true,acknowledgeInvalid:true};
  const path=`/api/scenarios/${scenario.id}/input-update-`;
  const options=await apps[1]!.inject({url:`/api/scenarios/${scenario.id}/input-update-options?planId=${source.id}&datasetId=${next.datasetId}&dayId=revised-day`});
  assert.equal(options.statusCode,200);assert.deepEqual(options.json().suggested,intent.matches);
  assert.deepEqual(options.json().manualRequestIds,[91]);
  assert.deepEqual(options.json().requiredProfiles,['fleet']);assert.equal(options.json().exceptions.length,1);
  assert.equal((await apps[0]!.inject({method:'POST',url:path+'preview',headers:{'if-match':`"${scenario.revision}"`},payload:{...intent,profiles:[]}})).statusCode,409);
  assert.equal((await apps[0]!.inject({method:'POST',url:path+'preview',headers:{'if-match':`"${scenario.revision}"`},payload:{...intent,carryExceptions:false}})).statusCode,409);
  let preview=await post<{previewSha256:string;diff:{added:unknown[];changed:unknown[];retainedDecisions:number;conflicts:unknown[]};stats:Plan['stats']}>(0,path+'preview',intent,scenario.revision);
  assert.equal(preview.diff.added.length,1);assert.equal(preview.diff.changed.length,1);assert.equal(preview.diff.retainedDecisions,1);assert.deepEqual(preview.diff.conflicts,[]);
  assert.equal(preview.stats.totalOrders,3);assert.equal(preview.stats.servedOrders,2);
  const invalidTarget=await admit(1,true,2000);
  const unsafe={...intent,datasetId:invalidTarget.datasetId,profiles:[await fleetProfile(invalidTarget.manifest)],operationId:'without-invalid-ack',acknowledgeInvalid:false};
  const unsafePreview=await post<{previewSha256:string}>(0,path+'preview',unsafe,scenario.revision);
  assert.equal((await apps[1]!.inject({method:'POST',url:path+'apply',headers:{'if-match':`"${scenario.revision}"`},payload:{intent:unsafe,previewSha256:unsafePreview.previewSha256,acknowledgeSupersession:true}})).statusCode,409);
  const alternative=await new ScenarioRepository(b,tenant).edit(base.id,[{op:'removeVehicle',vehicleId:42}],base.revision);
  assert.equal((await apps[0]!.inject({method:'POST',url:path+'apply',headers:{'if-match':`"${scenario.revision}"`},payload:{intent,previewSha256:preview.previewSha256,acknowledgeSupersession:true}})).statusCode,409,'new alternatives invalidate a reviewed supersession scope');
  preview=await post<typeof preview>(0,path+'preview',intent,scenario.revision);
  const apply={intent,previewSha256:preview.previewSha256,acknowledgeSupersession:true};
  const transfers=new TransferRepository(a,tenant),destination=parseDestinations({destinations:[{id:'test-warehouse',tenantId:tenant,label:'Synthetic receiver',protocol:'cursus.handoff.v1',url:'https://warehouse.example.test/instructions',tokenFile:'/tmp/unused-test-token'}]})[0]!;
  const command={operationId:'input-handoff',destinationId:destination.id,version:0,operation:'publish',reason:'Synthetic accepted instruction',approvalVersion:2};
  await transfers.enqueue(source.id,scenario.revision,command,destination);
  const blocked=await post<{diff:{conflicts:{code:string}[]}}>(1,path+'preview',intent,scenario.revision);
  assert.ok(blocked.diff.conflicts.some(c=>c.code==='downstream_commitment'));
  assert.equal((await apps[0]!.inject({method:'POST',url:path+'apply',headers:{'if-match':`"${scenario.revision}"`},payload:apply})).statusCode,409);
  const transferLease=(await a.claimJob('handoff','synthetic-receiver',30,tenant))!,prepared=await transfers.prepare(transferLease,destination);
  const envelope=JSON.parse(prepared.request.body);
  const acknowledgement={status:'accepted' as const,receiptId:'test-receipt',idempotencyKey:prepared.request.idempotencyKey,payloadSha256:prepared.request.payloadSha256,generation:envelope.generation,planSha256:envelope.planSha256,scenarioRevision:envelope.scenarioRevision};
  await transfers.acknowledge(transferLease,acknowledgement);
  assert.ok((await post<{diff:{conflicts:{code:string}[]}}>(1,path+'preview',intent,scenario.revision)).diff.conflicts.some(c=>c.code==='downstream_commitment'));
  await transfers.enqueue(source.id,scenario.revision,{...command,operationId:'input-cancel',operation:'cancel',version:1,previousIntentId:envelope.intentId},destination);
  const cancelLease=(await a.claimJob('handoff','synthetic-receiver',30,tenant))!,cancel=await transfers.prepare(cancelLease,destination),cancelEnvelope=JSON.parse(cancel.request.body);
  await transfers.acknowledge(cancelLease,{...acknowledgement,receiptId:'test-cancel',idempotencyKey:cancel.request.idempotencyKey,payloadSha256:cancel.request.payloadSha256,generation:cancelEnvelope.generation});
  assert.equal((await apps[0]!.inject({method:'POST',url:path+'apply',headers:{'if-match':`"${scenario.revision}"`},payload:{...apply,acknowledgeSupersession:false}})).statusCode,400);
  const userId=randomUUID();await a.pool.query('INSERT INTO users(id,email) VALUES($1,$2)',[userId,`${userId}@example.test`]);
  await a.pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'reviewer')",[tenant,userId]);
  const service=new InputUpdates(a,objects,tenant,admittedManualDatasetLoader(a,objects,tenant,f.context));
  await assert.rejects(()=>service.apply(scenario.id,scenario.revision,intent,preview.previewSha256,{userId,tenantId:tenant,email:'public@example.test',role:'admin'},true),/permission changed/);
  await assert.rejects(()=>service.preview(scenario.id,scenario.revision,intent,{userId,tenantId:tenant,email:'public@example.test',role:'planner'}),/Only Admin/);
  // A foreign tenant cannot resolve either source or replacement object identity.
  const foreign='inputs-foreign-'+randomUUID();await a.ensureTenant(foreign,'Foreign');
  await assert.rejects(()=>new InputUpdates(a,objects,foreign,admittedManualDatasetLoader(a,objects,foreign,f.context)).preview(scenario.id,scenario.revision,intent),/not found/);
  // Force failure at the final audit insert; every publication/archive must roll back.
  await a.pool.query(`CREATE FUNCTION input_update_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='input.update' AND NEW.tenant_id='${tenant}' THEN RAISE EXCEPTION 'test rollback'; END IF; RETURN NEW; END $$`);
  await a.pool.query('CREATE TRIGGER input_update_test_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION input_update_test_failure()');
  try{const failed=await apps[0]!.inject({method:'POST',url:path+'apply',headers:{'if-match':`"${scenario.revision}"`},payload:apply});assert.equal(failed.statusCode,422,failed.body);
   assert.equal((await a.getScenario(tenant,base.id))!.supersededBy,undefined);assert.equal((await a.listPlans(tenant)).length,2);
  }finally{await a.pool.query('DROP TRIGGER input_update_test_failure ON audit_events');await a.pool.query('DROP FUNCTION input_update_test_failure()');}
  const job=await post<{jobId:string}>(1,`/api/scenarios/${scenario.id}/solve`,{budgetSec:1},scenario.revision);
  const lease=await a.claimJob('solve','old-worker',60,tenant);assert.equal(lease?.id,job.jobId);
  // Competing operations on distinct servers: exactly one new cycle can win.
  const other={...intent,operationId:'revision-two'},otherPreview=await post<{previewSha256:string}>(1,path+'preview',other,scenario.revision);
  const race=await Promise.all(apps.map((app,i)=>app.inject({method:'POST',url:path+'apply',headers:{'if-match':`"${scenario.revision}"`},payload:i===0?apply:{intent:other,previewSha256:otherPreview.previewSha256,acknowledgeSupersession:true}})));
  assert.deepEqual(race.map(r=>r.statusCode).sort(),[201,409],race.map(r=>r.body).join('\n'));
  const winner=race.findIndex(r=>r.statusCode===201),updated=race[winner]!.json() as Plan;
  const replay=await post<Plan>(1-winner,path+'apply',winner===0?apply:{intent:other,previewSha256:otherPreview.previewSha256,acknowledgeSupersession:true},scenario.revision);
  assert.equal(replay.id,updated.id);assert.equal((await a.listPlans(tenant)).length,4);
  const current=(await b.getScenario(tenant,updated.scenarioId))!;
  assert.equal((await new ScenarioRepository(a,tenant).ensureBase(current.day,'Ignored duplicate')).id,current.parentId,'logical aliases reuse their actual base');
  assert.equal(current.datasetBinding?.datasetId,next.datasetId);assert.equal(current.datasetBinding?.dayId,'revised-day');
  assert.deepEqual(current.manualDecisions?.decisions['1091'],{kind:'vehicle',vehicleId:7});
  assert.equal(updated.stats.totalOrders,3);assert.equal(updated.stats.servedOrders,2);assert.equal(updated.unassigned[0]?.requestId,1093);
  assert.equal(updated.vehicles.find(v=>v.id===7)!.trips.reduce((n,t)=>n+t.loadKg,0),225);
  assert.equal(updated.manual?.parentScenario,undefined);
  assert.equal((await workflow.get(source.id)).state,'superseded');
  assert.equal((await apps[0]!.inject({url:`/api/plans/${source.id}/handoff.json?approval=required`})).statusCode,409);
  assert.equal((await apps[1]!.inject({url:`/api/plans/${source.id}/handoff.json`})).statusCode,200);
  assert.equal(planDigest((await a.pool.query('SELECT body FROM plans WHERE tenant_id=$1 AND id=$2',[tenant,source.id])).rows[0].body),sourceDigest);
  for(const s of [base,scenario,alternative]){
   const archived=(await a.getScenario(tenant,s.id))!;assert.equal(archived.supersededBy?.planId,updated.id);
   assert.equal((await apps[1]!.inject({method:'POST',url:`/api/scenarios/${s.id}/solve`,headers:{'if-match':`"${archived.revision}"`},payload:{budgetSec:1}})).statusCode,409);
   assert.equal((await apps[0]!.inject({method:'POST',url:'/api/scenarios',payload:{from:s.id}})).statusCode,409);
  }
  const oldJob=await a.pool.query('SELECT state,fence FROM jobs WHERE tenant_id=$1 AND id=$2',[tenant,job.jobId]);assert.equal(oldJob.rows[0].state,'failed');assert.ok(Number(oldJob.rows[0].fence)>lease!.fence);
  await assert.rejects(()=>a.completeSolve(lease!,'stale-result',scenario.id,scenario.revision,{...source,id:'stale-result'}));
  assert.equal(await a.getPlan(tenant,'stale-result'),null);
  const summaries=(await apps[1]!.inject({url:`/api/scenarios?day=${scenario.day}`})).json() as {id:string;latest:{planId:string}|null}[];
  assert.equal(summaries.find(s=>s.id===scenario.id)?.latest?.planId,source.id,'archived results remain readable');
  assert.equal((await apps[0]!.inject({url:`/api/plans/${updated.id}/manual-context`})).json().enabled,true);
  assert.equal((await apps[1]!.inject({url:`/api/plans/${updated.id}/handoff.json`})).json().handoff.status,'Draft');
  assert.equal((await new PlanWorkflow(b,tenant).get(updated.id)).state,'draft');
  // Native HGS on the new alias must use its bound admitted day and retained assignment.
  if(process.env.CURSUS_TEST_SURGE_BIN){
   (config as {surgeBin:string}).surgeBin=process.env.CURSUS_TEST_SURGE_BIN;
   const solved=await solveConvertedDataset(objects,tenant,next.manifest,current,1,'vehicles',AbortSignal.timeout(30000),false,f.context,undefined,await new ProfileRepository(b,tenant).resolve(current.planningProfiles??[]));
   assert.equal(solved.stats.servedOrders,3);assert.equal(solved.provenance.validation.valid,true);
   assert.ok(solved.vehicles.find(v=>v.id===7)?.trips.some(t=>t.stops.some(s=>s.requestId===1091)));
   assert.equal(solved.provenance.inputUpdate?.operationId,updated.provenance.inputUpdate?.operationId);
  }
 }finally{(config as {surgeBin:string}).surgeBin=oldBin;for(const app of apps)await app.close();await Promise.all(stores.map(s=>s.close()));s3.destroy();}
});

test('input-update routes enforce Reviewer and View-as restrictions before reading storage',{skip:!enabled},async()=>{
 const store=new StatefulStore(process.env.CURSUS_TEST_DATABASE_URL!),tenant='inputs-roles-'+randomUUID();
 let role:'admin'|'planner'|'reviewer'='reviewer',loads=0;
 const auth={initialize:async()=>{},authenticate:async()=>({userId:randomUUID(),tenantId:tenant,email:'public@example.test',role}),recordAccessAudit:async()=>{}} as unknown as StatefulAuthService;
 const objects=new ObjectStore('unused',{endpoint:process.env.CURSUS_TEST_S3_ENDPOINT,accessKeyId:'integration',secretAccessKey:'integration'});
 const app=await createStatefulApi({store,tenantId:tenant,tenantName:'Roles',objects,inputUpdatesEnabled:true,auth,publicOrigin:'https://fixture.test',manualPlanning:async()=>{loads++;return manualFixture().context;}});
 const disabled=await createStatefulApi({store,tenantId:tenant,tenantName:'Roles',objects,manualPlanning:async()=>{loads++;return manualFixture().context;}});
 try{
  assert.equal((await disabled.inject({url:'/api/auth/me'})).json().features.inputUpdates,false);
  assert.equal((await disabled.inject({method:'POST',url:'/api/scenarios/unknown/input-update-preview',headers:{'if-match':'"1"'},payload:{}})).statusCode,503);
  const headers={origin:'https://fixture.test',cookie:'cursus_session=fixture','if-match':'"1"'};
  for(const action of ['preview','apply'])assert.equal((await app.inject({method:'POST',url:`/api/scenarios/unknown/input-update-${action}`,headers,payload:{}})).statusCode,403);
  role='admin';const token=createHash('sha256').update('fixture').digest('hex');
  assert.equal((await app.inject({method:'POST',url:'/api/scenarios/unknown/input-update-preview',headers:{...headers,cookie:`cursus_session=fixture; cursus_view_as=reviewer.${token}`},payload:{}})).statusCode,403);
  role='planner';assert.equal((await app.inject({method:'POST',url:'/api/scenarios/unknown/input-update-preview',headers,payload:{}})).statusCode,400);
  assert.equal(loads,0);
 }finally{await app.close();await disabled.close();await store.close();}
});
