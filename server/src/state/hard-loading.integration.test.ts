import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {S3Client,CreateBucketCommand} from '@aws-sdk/client-s3';
import {StatefulStore,StaleFenceError} from './postgres.js';
import {ObjectStore} from './objects.js';
import {createStatefulApi} from './api.js';
import {DatasetRepository} from './datasets.js';
import {solveConvertedDataset,type ConvertedManifest} from './conversion.js';
import {loadingFixture} from './loading-fixture.js';
import {digest} from '../hard-loading.js';
import type {StatefulAuthService} from './auth.js';
import type {Plan} from '../types.js';

const enabled=!!(process.env.CURSUS_TEST_DATABASE_URL&&process.env.CURSUS_TEST_S3_ENDPOINT&&process.env.CURSUS_TEST_SURGE_BIN);
test('hard loading: real native work, takeover, fenced publication, approval/export and edits across two HTTP replicas', {skip:!enabled},async()=>{
 const db=process.env.CURSUS_TEST_DATABASE_URL!,endpoint=process.env.CURSUS_TEST_S3_ENDPOINT!,tenant='hard-'+randomUUID(),bucket='hard-'+randomUUID();
 const a=new StatefulStore(db,4,true),b=new StatefulStore(db,4,true),f=loadingFixture();
 f.context.day.physicalLoading=f.document;f.context.day.physicalLoadingSha256=createHash('sha256').update(JSON.stringify(f.document)).digest('hex');f.context.day.datasetRequestSha256=f.sha;
 const credentials={accessKeyId:'integration',secretAccessKey:'integration'};
 const objects=new ObjectStore(bucket,{endpoint,...credentials});
 await a.migrate();await a.ensureTenant(tenant,'Hard loading');
 const userId=randomUUID();await a.pool.query('INSERT INTO users(id,email) VALUES($1,$2)',[userId,userId+'@example.test']);
 await a.pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')",[tenant,userId]);
 const auth={initialize:async()=>{},authenticate:async()=>({userId,tenantId:tenant,email:userId+'@example.test',role:'admin'}),recordAccessAudit:async()=>{}} as unknown as StatefulAuthService;
 const s3=new S3Client({endpoint,region:'us-east-1',forcePathStyle:true,credentials});await s3.send(new CreateBucketCommand({Bucket:bucket}));
 const apps=await Promise.all([a,b].map(store=>createStatefulApi({store,objects,tenantId:tenant,tenantName:'Hard',auth,publicOrigin:'https://hard.test',fleetSettings:f.context,manualPlanning:async()=>f.context})));
 const origins=await Promise.all(apps.map(app=>app.listen({host:'127.0.0.1',port:0})));
 async function request(index:number,path:string,body?:unknown,revision=0){return fetch(origins[index]+path,{method:body===undefined?'GET':'POST',headers:{cookie:'cursus_session=synthetic','content-type':'application/json',origin:'https://hard.test','if-match':'"'+revision+'"'},...(body===undefined?{}:{body:JSON.stringify(body)})});}
 try{
  const form=new FormData();form.set('file',new Blob([JSON.stringify(f.bundle)],{type:'application/json'}),'loading.json');
  const upload=await fetch(origins[0]+'/api/import/upload',{method:'POST',headers:{cookie:'cursus_session=synthetic',origin:'https://hard.test'},body:form});assert.equal(upload.status,201);
  const {datasetId}=await upload.json() as {datasetId:string};
  assert.equal((await request(0,`/api/import/datasets/${datasetId}/validate`,{})).status,200);
  assert.equal((await request(1,`/api/import/datasets/${datasetId}/admit`,{})).status,200);
  const manifest=(await new DatasetRepository(a,objects,tenant).get(datasetId))!.manifest as ConvertedManifest;
  const created=await request(0,'/api/scenarios',{day:f.scenario.day});assert.equal(created.status,200);
  const scenario=await created.json() as typeof f.scenario;
  await assert.rejects(()=>solveConvertedDataset(objects,tenant,manifest,scenario,1,'vehicles',AbortSignal.timeout(30000),false,f.context,undefined,[],{enabled:true,nodeBudget:1}),/UNKNOWN/);
  assert.equal((await a.listPlans(tenant)).length,0);
  const submit=await request(0,`/api/scenarios/${scenario.id}/solve`,{budgetSec:1});assert.equal(submit.status,202);
  const lease=(await a.claimJob('solve','old',30,tenant))!;assert.equal((lease.payload as {hardLoadingEnabled:boolean}).hardLoadingEnabled,true);
  const plan=await solveConvertedDataset(objects,tenant,manifest,scenario,1,'vehicles',AbortSignal.timeout(30000),false,f.context,undefined,[],{enabled:true,nodeBudget:10000});
  assert.equal(plan.physicalLoading?.mode,'hard');assert.equal(plan.physicalLoading?.status,'feasible');
  await a.pool.query("UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE tenant_id=$1 AND id=$2",[tenant,lease.id]);
  const successor=(await b.claimJob('solve','new',30,tenant))!;
  await assert.rejects(()=>a.completeSolve(lease,plan.id,scenario.id,scenario.revision,plan),StaleFenceError);
  assert.equal(await b.getPlan(tenant,plan.id),null);
  const bad=structuredClone(plan);
  if(bad.physicalLoading?.mode!=='hard')throw Error('hard certificate required');
  const certificate=bad.physicalLoading.certificate!;certificate.result.rounds[0]!.outcome='unknown';
  const {sha256,...body}=certificate;void sha256;certificate.sha256=digest(body);
  await assert.rejects(()=>b.completeSolve(successor,plan.id,scenario.id,scenario.revision,bad),/UNKNOWN/);
  assert.equal(await a.getPlan(tenant,plan.id),null);
  await b.completeSolve(successor,plan.id,scenario.id,scenario.revision,plan);
  const peer=await request(1,`/api/plans/${plan.id}?geometry=stored`);assert.equal(peer.status,200);assert.deepEqual((await peer.json() as Plan).physicalLoading,plan.physicalLoading);
  const workflow=await (await request(1,`/api/plans/${plan.id}/workflow`)).json() as {blockers:string[]};assert.deepEqual(workflow.blockers,[]);
  assert.equal((await request(0,`/api/plans/${plan.id}/review`,{version:0,revision:scenario.revision,acknowledgeExceptions:true})).status,200);
  const approved=await request(1,`/api/plans/${plan.id}/approve`,{version:1,revision:scenario.revision,acknowledgeExceptions:true});assert.equal(approved.status,200,await approved.text());
  const exported=await request(0,`/api/plans/${plan.id}/handoff.json?approval=required`);assert.equal(exported.status,200);assert.ok(JSON.stringify(await exported.json()).includes('"mode":"hard"'));
  const preview=await request(0,`/api/scenarios/${scenario.id}/manual-preview`,{parentPlanId:plan.id,batch:{operationId:'hard-preview',datasetSha256:f.sha,commands:[{op:'deassign',requestId:91}]}},scenario.revision);
  assert.equal(preview.status,200,await preview.clone().text());const previewBody=await preview.json() as {physicalLoadingPending:boolean;validation:{valid:boolean}};
  assert.equal(previewBody.physicalLoadingPending,true);assert.equal(previewBody.validation.valid,false);
  const manualResponse=await request(1,`/api/scenarios/${scenario.id}/manual-plan`,{parentPlanId:plan.id,batch:{operationId:'hard-manual',datasetSha256:f.sha,commands:[{op:'deassign',requestId:91}]}},scenario.revision);
  assert.equal(manualResponse.status,201,await manualResponse.clone().text());const manual=await manualResponse.json() as Plan;
  assert.equal(manual.physicalLoading?.status,'stale');assert.equal(manual.provenance.validation.valid,false);
  assert.equal((await request(0,`/api/plans/${manual.id}/handoff.json?approval=required`)).status,409);
  assert.equal((await request(1,`/api/plans/${manual.id}/handoff.json`)).status,200);
  // A replica configured without the required policy must refuse this queued work.
  const mismatchJob=await a.enqueueJob(tenant,'solve','flag-drift',{hardLoadingEnabled:true});
  const mismatch=(await a.claimJob('solve','mismatch',30,tenant))!;assert.equal(mismatch.id,mismatchJob);
  const off=new StatefulStore(db,2,false);
  try{await assert.rejects(()=>off.completeSolve(mismatch,plan.id+'-drift',scenario.id,scenario.revision,plan),/policy differs/);}finally{await off.close();}
  await a.failJob(mismatch,'test cleanup');
  const disabled=new StatefulStore(db,2,false);
  const disabledApi=await createStatefulApi({store:disabled,objects,tenantId:tenant,tenantName:'Flag off',auth,publicOrigin:'https://hard.test'});
  try{
    const old=await disabled.getScenario(tenant,scenario.id);assert.equal(old?.hardLoadingRequired,true);
    const legacy=structuredClone(plan);legacy.id='downgrade';legacy.physicalLoading={sourceSha256:f.context.day.physicalLoadingSha256!,datasetSha256:f.sha,mode:'disabled',status:'not_evaluated',rounds:[]};
    await a.enqueueJob(tenant,'solve','cannot-downgrade',{hardLoadingEnabled:false});const guard=(await a.claimJob('solve','guard',30,tenant))!;
    await assert.rejects(()=>disabled.completeSolve(guard,legacy.id,scenario.id,scenario.revision,legacy),/hard loading required/);
    assert.equal(await a.getPlan(tenant,legacy.id),null);await a.failJob(guard,'test cleanup');
    // Source enforcement also covers a different branch with no scenario marker or evidence.
    const branch={...scenario,id:scenario.id+'-branch',hardLoadingRequired:undefined};await a.createScenario(tenant,branch.id,branch);
    const bare=structuredClone(legacy);bare.id='bare-downgrade';bare.scenarioId=branch.id;delete bare.physicalLoading;
    await a.enqueueJob(tenant,'solve','cannot-downgrade-source',{hardLoadingEnabled:false});const sourceGuard=(await a.claimJob('solve','source-guard',30,tenant))!;
    await assert.rejects(()=>disabled.completeSolve(sourceGuard,bare.id,branch.id,branch.revision,bare),/hard loading required/);
    assert.equal(await a.getPlan(tenant,bare.id),null);await a.failJob(sourceGuard,'test cleanup');
    // Simulate a pre-activation legacy plan on that branch: it cannot be approved now.
    await a.pool.query('INSERT INTO plans(tenant_id,id,scenario_id,scenario_revision,body) VALUES($1,$2,$3,$4,$5)',[tenant,bare.id,branch.id,branch.revision,bare]);
    const branchWorkflow=await disabledApi.inject({url:`/api/plans/${bare.id}/workflow`,headers:{cookie:'cursus_session=synthetic'}});assert.equal(branchWorkflow.statusCode,200);assert.ok(branchWorkflow.json().blockers.some((b:string)=>b.includes('hard loading required')));
    assert.equal((await disabledApi.inject({url:`/api/plans/${bare.id}/handoff.json?approval=required`,headers:{cookie:'cursus_session=synthetic'}})).statusCode,409);
    // A changed immutable-source reference invalidates old approval on either policy.
    const originalManifest=structuredClone(manifest);
    await b.pool.query("UPDATE datasets SET manifest=jsonb_set(manifest,'{artifacts,physicalLoading,sha256}',to_jsonb($3::text)) WHERE tenant_id=$1 AND id=$2",[tenant,datasetId,'f'.repeat(64)]);
    assert.equal((await disabledApi.inject({url:`/api/plans/${plan.id}/handoff.json?approval=required`,headers:{cookie:'cursus_session=synthetic'}})).statusCode,409);
    assert.equal((await disabledApi.inject({url:`/api/plans/${plan.id}/handoff.json`,headers:{cookie:'cursus_session=synthetic'}})).statusCode,200);
    await b.pool.query('UPDATE datasets SET manifest=$3 WHERE tenant_id=$1 AND id=$2',[tenant,datasetId,originalManifest]);
  }finally{await disabledApi.close();await disabled.close();}
  // New scenario revision and the stored certificate cannot be combined into Approved bytes.
  await b.updateScenario(tenant,scenario.id,scenario.revision,{...scenario,revision:scenario.revision+1,removedVehicleIds:[42]});
  assert.equal((await request(1,`/api/plans/${plan.id}/handoff.json?approval=required`)).status,409);
  assert.equal((await request(0,`/api/plans/${plan.id}/handoff.json`)).status,200,'draft/superseded export remains available');
  const foreign=await createStatefulApi({store:a,tenantId:'foreign',tenantName:'Foreign'});
  try{assert.equal((await foreign.inject({url:`/api/plans/${plan.id}`})).statusCode,404);}finally{await foreign.close();}
 }finally{await Promise.all(apps.map(app=>app.close()));objects.close();s3.destroy();await Promise.all([a.close(),b.close()]);}
});
