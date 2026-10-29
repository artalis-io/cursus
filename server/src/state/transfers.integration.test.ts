import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StatefulStore,StaleFenceError} from './postgres.js';
import {PlanWorkflow} from './plan-workflow.js';
import {validPlan} from './plan-workflow.test.js';
import {TransferRepository,TransferHalt} from './transfers.js';
import {parseDestinations,HttpHandoffSender,type TransferRequest} from './handoff-sender.js';
import {workOneTransfer} from './transfer-worker.js';
import {createStatefulApi} from './api.js';
import type {Scenario} from '../store.js';
import type {TransferAcknowledgement} from '../integration-contract.js';

test('durable handoff across replicas: approval, deduplication after provider acceptance, fencing, amendments, cancellation and isolation',{
 skip:!process.env.CURSUS_TEST_DATABASE_URL,timeout:60000},async()=>{
 const a=new StatefulStore(process.env.CURSUS_TEST_DATABASE_URL!),b=new StatefulStore(process.env.CURSUS_TEST_DATABASE_URL!),tenant='transfer-'+randomUUID();
 const scratch=await mkdtemp(join(tmpdir(),'cursus-handoff-')),token=join(scratch,'token');await writeFile(token,'public-integration-secret',{mode:0o600});
 const receipts=new Map<string,{hash:string;ack:TransferAcknowledgement}>();let posts=0;
 const receiver=createServer(async(req,res)=>{
  assert.equal(req.headers.authorization,'Bearer public-integration-secret');const key=String(req.headers['idempotency-key']),hash=String(req.headers['x-cursus-payload-sha256']);
  if(req.method==='GET'){const prior=receipts.get(key);res.writeHead(prior?200:404,{'content-type':'application/json'});res.end(JSON.stringify(prior?.ack??{}));return;}
  posts++;let body='';for await(const part of req)body+=part;const envelope=JSON.parse(body);
  const prior=receipts.get(key);if(prior){assert.equal(prior.hash,hash);res.end(JSON.stringify(prior.ack));return;}
  const ack:TransferAcknowledgement={status:'accepted',receiptId:`receipt-${receipts.size+1}`,idempotencyKey:key,payloadSha256:hash,generation:envelope.generation,planSha256:envelope.planSha256,scenarioRevision:envelope.scenarioRevision};
  receipts.set(key,{hash,ack});res.end(JSON.stringify(ack));
 });
 await new Promise<void>(r=>receiver.listen(0,'127.0.0.1',r));const port=(receiver.address() as {port:number}).port;
 const destination=parseDestinations({destinations:[{id:'warehouse',tenantId:tenant,label:'Public receiver',protocol:'cursus.handoff.v1',url:`http://127.0.0.1:${port}`,tokenFile:token}]},true)[0]!;
 const sender=await HttpHandoffSender.create([destination]);
 await a.migrate();await a.ensureTenant(tenant,'Transfer test');
 const plan=validPlan(),scenario:Scenario={id:plan.scenarioId,day:plan.day,kind:'copy',parentId:null,revision:1,label:'Public',createdAt:new Date().toISOString(),removedVehicleIds:[],pins:[],forbids:[],sequences:[],vehicleOverrides:[]};
 await a.createScenario(tenant,scenario.id,scenario);await a.pool.query('INSERT INTO plans(tenant_id,id,scenario_id,scenario_revision,body) VALUES($1,$2,$3,1,$4)',[tenant,plan.id,scenario.id,plan]);
 const workflow=new PlanWorkflow(a,tenant),repo=new TransferRepository(a,tenant),peer=new TransferRepository(b,tenant);
 const apps=await Promise.all([a,b].map(store=>createStatefulApi({store,tenantId:tenant,tenantName:'Transfer test',handoffDestinations:[destination]})));
 const command=(version:number,operation='publish',previousIntentId?:string)=>({operationId:randomUUID(),destinationId:destination.id,version,operation,reason:'Public approved instruction',approvalVersion:2,previousIntentId});
 const send=(node:number,body:ReturnType<typeof command>,rev=1,id=plan.id)=>apps[node]!.inject({method:'POST',url:`/api/plans/${id}/transfers/${body.operation}`,headers:{'if-match':`"${rev}"`},payload:body});
 try{
  assert.equal((await send(0,command(0))).statusCode,409);
  await workflow.transition(plan.id,'plan.review',0,1,true);await workflow.transition(plan.id,'plan.approve',1,1,true);
  const c=command(0),[queued,concurrent]=await Promise.all([send(0,c),send(1,c)]);assert.equal(queued.statusCode,202,queued.body);const first=queued.json();
  assert.equal(concurrent.statusCode,202,concurrent.body);assert.equal(concurrent.json().id,first.id);
  assert.equal((await send(1,c)).json().id,first.id);
  assert.equal((await send(1,{...c,reason:'Different bytes'})).statusCode,409);
  assert.equal((await send(1,command(0))).statusCode,409);
  const old=(await a.claimJob('handoff','lost-worker',30,tenant))!,prepared=await repo.prepare(old,destination);
  const ack=await sender.send(destination,prepared.request,new AbortController().signal);assert.equal(posts,1);
  // Simulate crash AFTER receiver commit, BEFORE local acknowledgement.
  await a.pool.query("UPDATE jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND id=$2",[tenant,old.id]);
  const next=(await b.claimJob('handoff','replacement',30,tenant))!;assert.ok(next.fence>old.fence);
  await assert.rejects(()=>repo.acknowledge(old,ack),StaleFenceError);
  const retry=await peer.prepare(next,destination);assert.equal(retry.request.body,prepared.request.body);assert.equal(retry.request.idempotencyKey,prepared.request.idempotencyKey);
  const repeated=await sender.send(destination,retry.request,new AbortController().signal);await peer.acknowledge(next,repeated);
  assert.equal(posts,2);assert.equal(receipts.size,1);assert.equal((await repo.status(plan.id)).intents[0]!.state,'acknowledged');
  await assert.rejects(()=>a.pool.query('UPDATE handoff_intents SET payload_text=$3 WHERE tenant_id=$1 AND id=$2',[tenant,first.id,'{}']),/immutable/);
  assert.equal((await apps[0]!.inject({method:'DELETE',url:`/api/scenarios/${scenario.id}`,headers:{'if-match':'"1"'}})).statusCode,409);
  // Amendment uses another immutable approved snapshot, same scenario revision.
  const amended={...plan,id:'amended-plan',createdAt:new Date().toISOString()};await a.pool.query('INSERT INTO plans(tenant_id,id,scenario_id,scenario_revision,body) VALUES($1,$2,$3,1,$4)',[tenant,amended.id,scenario.id,amended]);
  await workflow.transition(amended.id,'plan.review',0,1,true);await workflow.transition(amended.id,'plan.approve',1,1,true);
  const amendment=await send(1,command(1,'amend',first.id),1,amended.id);assert.equal(amendment.statusCode,202,amendment.body);
  await workOneTransfer(b,tenant,[destination],sender,'amend-worker');assert.equal(receipts.size,2);
  const cancel=await send(0,command(2,'cancel',amendment.json().id));assert.equal(cancel.statusCode,202,cancel.body);
  await workOneTransfer(a,tenant,[destination],sender,'cancel-worker');assert.equal(receipts.size,3);
  const status=await repo.status(plan.id);assert.equal(status.intents.find(i=>i.id===cancel.json().id)!.state,'acknowledged');assert.equal(status.heads[0]!.acceptedIntentId,cancel.json().id);
  const foreign='foreign-'+randomUUID();await a.ensureTenant(foreign,'Foreign');await assert.rejects(()=>new TransferRepository(a,foreign).status(plan.id),/not found/);
  // A queued plan invalidated before first send never reaches the receiver.
  const fresh=await send(0,command(3,'publish',cancel.json().id));assert.equal(fresh.statusCode,202,fresh.body);
  await a.pool.query('UPDATE scenarios SET revision=2 WHERE tenant_id=$1 AND id=$2',[tenant,scenario.id]);
  const before=posts;await workOneTransfer(b,tenant,[destination],sender,'stale-worker');assert.equal(posts,before);assert.equal((await repo.status(plan.id)).intents.find(i=>i.id===fresh.json().id)!.state,'stale');
 }finally{for(const app of apps)await app.close();receiver.closeAllConnections();await new Promise<void>(r=>receiver.close(()=>r()));await a.close();await b.close();await rm(scratch,{recursive:true,force:true});}
});

test('handoff ambiguity after an edit becomes receipt-only; expired lease cannot publish after waiting for a scenario lock',{
 skip:!process.env.CURSUS_TEST_DATABASE_URL,timeout:30000},async()=>{
 const a=new StatefulStore(process.env.CURSUS_TEST_DATABASE_URL!),b=new StatefulStore(process.env.CURSUS_TEST_DATABASE_URL!),tenant='transfer-stale-'+randomUUID();
 await a.migrate();await a.ensureTenant(tenant,'Public');const plan=validPlan(),scenario={id:plan.scenarioId,day:plan.day,kind:'copy',parentId:null,revision:1,label:'Public',createdAt:new Date().toISOString(),removedVehicleIds:[],pins:[],forbids:[],sequences:[],vehicleOverrides:[]} as Scenario;
 await a.createScenario(tenant,scenario.id,scenario);await a.pool.query('INSERT INTO plans(tenant_id,id,scenario_id,scenario_revision,body) VALUES($1,$2,$3,1,$4)',[tenant,plan.id,scenario.id,plan]);
 const workflow=new PlanWorkflow(a,tenant),repo=new TransferRepository(a,tenant),destination=parseDestinations({destinations:[{id:'warehouse',tenantId:tenant,label:'Public',url:'https://receiver.example.test',tokenFile:'/public/test-only',protocol:'cursus.handoff.v1'}]})[0]!;
 try{
  await workflow.transition(plan.id,'plan.review',0,1,true);await workflow.transition(plan.id,'plan.approve',1,1,true);
  const queued=await repo.enqueue(plan.id,1,{operationId:randomUUID(),destinationId:'warehouse',version:0,operation:'publish',reason:'Public',approvalVersion:2},destination);
  const lease=(await a.claimJob('handoff','first',30,tenant))!,prepared=await repo.prepare(lease,destination);
  await repo.failed(lease,'Ambiguous test response',true);await a.pool.query('UPDATE jobs SET available_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2',[tenant,lease.id]);
  await a.pool.query('UPDATE scenarios SET revision=2 WHERE tenant_id=$1 AND id=$2',[tenant,scenario.id]);
  let posts=0,lookups=0;
  await workOneTransfer(b,tenant,[destination],{send:async()=>{posts++;throw Error('Must not resend stale bytes');},lookup:async()=>{lookups++;return null;}});
  assert.equal(posts,0);assert.equal(lookups,1);assert.equal((await repo.status(plan.id)).intents[0]!.state,'needs_reconciliation');
  await repo.retry(queued.id,'lookup');const next=(await a.claimJob('handoff','late',1,tenant))!;
  const locker=await b.pool.connect();await locker.query('BEGIN');await locker.query('SELECT id FROM scenarios WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenant,scenario.id]);
  const ack={status:'accepted',receiptId:'receipt-after-edit',idempotencyKey:prepared.request.idempotencyKey,payloadSha256:prepared.request.payloadSha256,generation:1,planSha256:prepared.request.envelope.planSha256,scenarioRevision:1};
  const pending=repo.acknowledge(next,ack);const caught=pending.then(()=>null,e=>e);
  await new Promise(r=>setTimeout(r,1200));await locker.query('COMMIT');locker.release();assert.ok(await caught instanceof StaleFenceError);
  assert.equal((await repo.status(plan.id)).intents[0]!.receipt,null);
 }finally{await a.close();await b.close();}
});
