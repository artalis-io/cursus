import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {StatefulStore} from './postgres.js';
import {ProfileRepository} from './profiles.js';
import {createStatefulApi} from './api.js';
import {manualFixture} from './manual-fixture.js';
import type {StatefulAuthService} from './auth.js';
import type {ProfileContent,ProfileRef} from '../planning-profiles.js';
import {shipmentFixture} from './shipment-fixture.js';
import {ObjectStore} from './objects.js';
import {S3Client,CreateBucketCommand} from '@aws-sdk/client-s3';
import {solveConvertedDataset,type ConvertedManifest} from './conversion.js';
import {admittedManualDatasetLoader} from './manual-dataset.js';
import {config} from '../config.js';
import type {Scenario} from '../store.js';
import type {Plan} from '../types.js';

test('profile governance across two APIs is tenant-isolated, revision-fenced and append-only',{skip:!process.env.CURSUS_TEST_DATABASE_URL},async()=>{
 const stores=[new StatefulStore(process.env.CURSUS_TEST_DATABASE_URL!),new StatefulStore(process.env.CURSUS_TEST_DATABASE_URL!)];
 const tenant='profile-'+randomUUID(),userId=randomUUID(),f=manualFixture(),a=stores[0]!;
 await a.migrate();await a.ensureTenant(tenant,'Public profile test');
 await a.createScenario(tenant,f.scenario.id,f.scenario);
 await a.pool.query('INSERT INTO users(id,email) VALUES($1,$2)',[userId,`profile-${userId}@example.test`]);
 await a.pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'planner')",[tenant,userId]);
 const auth={initialize:async()=>{},authenticate:async()=>({userId,tenantId:tenant,email:'public@example.test',role:'planner'}),recordAccessAudit:async()=>{}} as unknown as StatefulAuthService;
 const apps=await Promise.all(stores.map(store=>createStatefulApi({store,tenantId:tenant,tenantName:'Profile test',auth,publicOrigin:'https://profile.test'})));
 const headers=(version:number)=>({origin:'https://profile.test',cookie:'cursus_session=public-fixture','if-match':`"${version}"`});
 const value:ProfileContent={schemaVersion:1,kind:'locations',label:'Public site',reason:'Source verification',datasetSha256:'a'.repeat(64),
  locations:[{locationId:1,maxGrossWeightKg:7500,requiresTailLift:true,serviceSeconds:60,windowStartSeconds:0,windowEndSeconds:86400,reason:'Verified access'}]};
 try{
  const proposed=await apps[0]!.inject({method:'POST',url:'/api/profiles',headers:headers(0),payload:{content:value}});
  assert.equal(proposed.statusCode,201);const initial=proposed.json() as ProfileRef&{version:number};
  assert.equal((await apps[1]!.inject({method:'GET',url:'/api/profiles',headers:headers(0)})).json().length,1);
  assert.equal((await apps[1]!.inject({method:'POST',url:`/api/profiles/${initial.id}/activate`,headers:headers(1),payload:{revision:1}})).statusCode,403);
  const race=await Promise.all(apps.map(app=>app.inject({method:'POST',url:`/api/profiles/${initial.id}/revisions`,headers:headers(1),payload:{content:{...value,reason:'Revised source'}}})));
  assert.deepEqual(race.map(r=>r.statusCode).sort(),[201,409]);
  const repo=new ProfileRepository(a,tenant),ref={id:initial.id,kind:'locations' as const,revision:1,sha256:initial.sha256};
  await assert.rejects(()=>repo.resolve([ref]),/Approved profile/);
  await a.pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2",[tenant,userId]);
  const actor={userId,tenantId:tenant,email:'public@example.test',role:'admin' as const};
  await assert.rejects(()=>repo.activate(initial.id,1,2,actor),/not admitted/);
  await a.pool.query("INSERT INTO datasets(tenant_id,id,status,manifest) VALUES($1,'profile-input','admitted',$2)",[tenant,{artifacts:{request:{sha256:value.datasetSha256}},days:[{dayId:f.scenario.day}]}]);
  const active=await repo.activate(initial.id,1,2,actor);assert.equal(active.version,3);
  assert.equal((await repo.activate(initial.id,1,3,actor)).version,3,'matching activation is a no-op');
  assert.equal((await repo.resolve([ref]))[0]!.content.reason,value.reason);
  const bindings=await Promise.all(stores.map(store=>new ProfileRepository(store,tenant).bind(f.scenario.id,1,[ref],actor)) .map(p=>p.then(v=>({ok:true,value:v}),()=>({ok:false}))));
  assert.equal(bindings.filter(r=>r.ok).length,1);
  assert.equal((await a.getScenario(tenant,f.scenario.id))!.revision,2);
  const other={...value,datasetSha256:'b'.repeat(64),label:'Other admitted day'};
  await a.pool.query("INSERT INTO datasets(tenant_id,id,status,manifest) VALUES($1,'other-input','admitted',$2)",[tenant,{artifacts:{request:{sha256:other.datasetSha256}},days:[{dayId:'other-day'}]}]);
  const otherVersion=await repo.propose(other,0,undefined,actor);await repo.activate(otherVersion.id,1,1,actor);
  await assert.rejects(()=>repo.bind(f.scenario.id,2,[{id:otherVersion.id,kind:'locations',revision:1,sha256:otherVersion.sha256}],actor),/unambiguous admitted source/);
  assert.equal((await a.getScenario(tenant,f.scenario.id))!.revision,2);
  await assert.rejects(()=>a.pool.query('UPDATE planning_profile_revisions SET body=$3 WHERE tenant_id=$1 AND profile_id=$2',[tenant,initial.id,{}]),/immutable/);
  await assert.rejects(()=>a.pool.query('DELETE FROM planning_profile_revisions WHERE tenant_id=$1 AND profile_id=$2',[tenant,initial.id]),/immutable/);
  const foreign='profile-foreign-'+randomUUID();await a.ensureTenant(foreign,'Foreign');
  assert.equal((await new ProfileRepository(a,foreign).list()).length,0);
  await assert.rejects(()=>new ProfileRepository(a,foreign).resolve([ref]),/unavailable/);
  await a.pool.query("UPDATE memberships SET role='reviewer' WHERE tenant_id=$1 AND user_id=$2",[tenant,userId]);
  await assert.rejects(()=>repo.activate(initial.id,2,3,actor),/permission changed/);
  await assert.rejects(()=>repo.propose(value,3,initial.id,actor),/permission changed/);
 }finally{for(const app of apps)await app.close();for(const store of stores)await store.close();}
});

test('prepared commercial data and approved fleet/location revisions run through real HTTP, R2-compatible objects and native Surge',{
 skip:!process.env.CURSUS_TEST_DATABASE_URL||!process.env.CURSUS_TEST_S3_ENDPOINT||!process.env.CURSUS_TEST_SURGE_BIN,
},async()=>{
 const a=new StatefulStore(process.env.CURSUS_TEST_DATABASE_URL!),b=new StatefulStore(process.env.CURSUS_TEST_DATABASE_URL!);
 const tenant='commercial-'+randomUUID(),bucket='commercial-'+randomUUID(),endpoint=process.env.CURSUS_TEST_S3_ENDPOINT!;
 const objects=new ObjectStore(bucket,{endpoint,accessKeyId:'integration',secretAccessKey:'integration'});
 const s3=new S3Client({endpoint,region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:'integration',secretAccessKey:'integration'}});
 const f=shipmentFixture();f.request.tasks[1]!.ref=f.request.tasks[0]!.ref;
 f.document.deliveries[1]!.reference=f.request.tasks[0]!.ref;
 f.document.datasetSha256=createHash('sha256').update(JSON.stringify(f.request)).digest('hex');
 const source={schemaVersion:1,days:[{dayId:'commercial-day',isoDate:'2026-10-26',label:'Public commercial day'}],surgeRequest:f.request,shipments:f.document,
  geocoded:f.request.requests.map((order,i)=>({request_id:order.id,order_no:f.request.tasks[i]!.ref,delivery_date:'2026-10-26',requires_tail_lift:false,max_gross_weight_kg:null,customer:`Public ${i}`}))};
 const apps:Awaited<ReturnType<typeof createStatefulApi>>[]=[],origins:string[]=[];
 const testConfig=config as {surgeBin:string},oldBin=testConfig.surgeBin;testConfig.surgeBin=process.env.CURSUS_TEST_SURGE_BIN!;
 async function post<T>(origin:string,path:string,body:unknown,revision?:number):Promise<T>{
  const response=await fetch(origin+path,{method:'POST',headers:{'content-type':'application/json',...(revision===undefined?{}:{'if-match':`"${revision}"`})},body:JSON.stringify(body)});
  assert.ok(response.ok,`${path}: ${response.status} ${response.ok?'':await response.text()}`);return await response.json() as T;
 }
 try{
  await a.migrate();await a.ensureTenant(tenant,'Commercial fixture');await s3.send(new CreateBucketCommand({Bucket:bucket}));
  for(const store of [a,b]){const app=await createStatefulApi({store,tenantId:tenant,tenantName:'Commercial fixture',objects,
   fleetSettings:f.context,manualPlanning:admittedManualDatasetLoader(store,objects,tenant,f.context)});apps.push(app);origins.push(await app.listen({host:'127.0.0.1',port:0}));}
  const form=new FormData();form.set('file',new Blob([JSON.stringify(source)],{type:'application/json'}),'prepared.json');
  const upload=await fetch(origins[0]+'/api/import/upload',{method:'POST',body:form});assert.equal(upload.status,201);
  const uploaded=await upload.json() as {datasetId:string};
  await post(origins[1]!,`/api/import/datasets/${uploaded.datasetId}/validate`,{});
  const admitted=await post<{manifest:ConvertedManifest}>(origins[0]!,`/api/import/datasets/${uploaded.datasetId}/admit`,{});
  assert.ok(admitted.manifest.artifacts?.shipments);
  const initial=await post<Scenario>(origins[0]!,'/api/scenarios',{day:'commercial-day'});
  const fleet:ProfileContent={schemaVersion:1,kind:'fleet',datasetSha256:f.document.datasetSha256,label:'Verified public fleet',reason:'Verified equipment',settings:{datasetSha256:f.document.datasetSha256,tariff:f.context.tariff,
   vehicles:f.request.vehicles.map(v=>({id:v.id,ref:v.ref,vehicleClass:null,isSubcontractor:false,tonnage:v.id===42?3.5:12,hasTailLift:true,reloadSec:120,available:true,capacityKg:1000,capacityPallets:10}))}};
  const locations:ProfileContent={schemaVersion:1,kind:'locations',datasetSha256:f.document.datasetSha256,label:'Verified public site',reason:'Verified GVW and unloading',locations:[
   {locationId:1,maxGrossWeightKg:7500,requiresTailLift:true,serviceSeconds:60,windowStartSeconds:0,windowEndSeconds:10000,reason:'Site verification'}]};
  const refs:ProfileRef[]=[];
  for(const content of [fleet,locations]){
   const proposed=await post<ProfileRef&{version:number}>(origins[0]!,'/api/profiles',{content},0);
   await post(origins[1]!,`/api/profiles/${proposed.id}/activate`,{revision:proposed.revision},proposed.version);refs.push({id:proposed.id,kind:content.kind,revision:proposed.revision,sha256:proposed.sha256});
  }
  const scenario=await post<Scenario>(origins[1]!,`/api/scenarios/${initial.id}/profiles`,{profiles:refs},initial.revision);
  const job=await post<{jobId:string}>(origins[0]!,`/api/scenarios/${scenario.id}/solve`,{budgetSec:1},scenario.revision);
  const lease=await a.claimJob('solve','commercial-native',30);assert.ok(lease);assert.equal(lease.id,job.jobId);
  const profiles=await new ProfileRepository(b,tenant).resolve(scenario.planningProfiles??[]);
  const plan=await solveConvertedDataset(objects,tenant,admitted.manifest,scenario,1,'vehicles',AbortSignal.timeout(30000),false,f.context,undefined,profiles);
  assert.equal(plan.stats.servedOrders,2);assert.equal(plan.stats.deliveryStops,2);
  const restricted=plan.vehicles.find(v=>v.trips.some(t=>t.stops.some(s=>s.requestId===91)))!;
  assert.equal(restricted.id,42);assert.equal(restricted.tonnage,3.5);assert.equal(restricted.hasTailLift,true);
  assert.deepEqual(plan.shipmentMetadata?.deliveries.map(d=>d.requestId),[91,92]);
  assert.equal(plan.shipmentMetadata?.shipments.length,2);
  assert.equal(plan.vehicles.flatMap(v=>v.trips.flatMap(t=>t.stops)).reduce((sum,s)=>sum+s.weightKg,0),200);
  await b.completeSolve(lease,plan.id,scenario.id,scenario.revision,plan);
  const peer=await fetch(origins[1]+`/api/plans/${plan.id}`);assert.equal(peer.status,200);
  assert.deepEqual((await peer.json() as Plan).shipmentMetadata,plan.shipmentMetadata);
  const exported=await fetch(origins[0]+`/api/plans/${plan.id}/handoff.json`);assert.equal(exported.status,200);
  const handoff=await exported.json() as {shipmentMetadata:Plan['shipmentMetadata'];handoff:{status:string}};
  assert.deepEqual(handoff.shipmentMetadata,plan.shipmentMetadata);assert.equal(handoff.handoff.status,'Draft');
  const context=await fetch(origins[1]+`/api/plans/${plan.id}/manual-context`);assert.equal(context.status,200);assert.equal((await context.json() as {enabled:boolean}).enabled,true);
  const portable=await fetch(origins[0]+`/api/scenarios/${scenario.id}/export`);assert.equal(portable.status,200);
  const bundle=await portable.json() as {otto_scenario:number};assert.equal(bundle.otto_scenario,2);
  const imported=await post<Scenario>(origins[1]!,'/api/scenarios/import',bundle);
  assert.deepEqual(imported.planningProfiles,scenario.planningProfiles);assert.equal(imported.deliveryDatasetSha256,f.document.datasetSha256);
 }finally{testConfig.surgeBin=oldBin;for(const app of apps)await app.close();await Promise.all([a.close(),b.close()]);s3.destroy();}
});
