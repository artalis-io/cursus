import {createHash,randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {Principal} from '../auth.js';
import {hasPermission,type Permission} from '../roles.js';
import type {TransferEnvelope,TransferAcknowledgement,TransferSummary,TransferState,HandoffOperation} from '../integration-contract.js';
import {planToHandoffJson} from '../export.js';
import {PlanWorkflow,WorkflowError,planDigest} from './plan-workflow.js';
import {StaleFenceError,type StatefulStore,type Lease} from './postgres.js';
import {validateAcknowledgement,type Destination,type TransferRequest} from './handoff-sender.js';

export interface TransferCommand {operationId:string;destinationId:string;version:number;operation:HandoffOperation;reason:string;previousIntentId?:string;approvalVersion:number}
interface IntentRow {
 tenant_id:string;id:string;scenario_id:string;destination_id:string;generation:string;operation_id:string;request_sha256:string;destination_sha256:string;
 operation:HandoffOperation;reason:string;plan_id:string;scenario_revision:string;approval_version:string;plan_sha256:string;payload_text:string;payload_sha256:string;idempotency_key:string;
 state:TransferState;attempts:number;created_at:Date;deadline:Date;acknowledged_at:Date|null;acknowledgement:TransferAcknowledgement|null;last_error:string|null;
}
interface HeadRow {generation:string;current_intent:string|null;accepted_intent:string|null}
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
export class TransferHalt extends Error {constructor(readonly state:'stale'|'needs_reconciliation',message:string){super(message);}}
const summary=(r:IntentRow):TransferSummary=>({id:r.id,destinationId:r.destination_id,scenarioId:r.scenario_id,planId:r.plan_id,scenarioRevision:Number(r.scenario_revision),generation:Number(r.generation),
 operation:r.operation,reason:r.reason,state:r.state,createdAt:r.created_at.toISOString(),acknowledgedAt:r.acknowledged_at?.toISOString()??null,receipt:r.acknowledgement,
 lastError:r.last_error,attempts:r.attempts,planSha256:r.plan_sha256,payloadSha256:r.payload_sha256,idempotencyKey:r.idempotency_key,deadline:r.deadline.toISOString(),approvalVersion:Number(r.approval_version)});

export function parseTransferCommand(value:unknown):TransferCommand{
 const b=value as TransferCommand;
 if(!b||typeof b!=='object'||Object.keys(b).some(k=>!['operationId','destinationId','version','operation','reason','previousIntentId','approvalVersion'].includes(k))||
  typeof b.operationId!=='string'||typeof b.destinationId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(b.operationId)||!/^[a-zA-Z0-9_-]{1,64}$/.test(b.destinationId)||!Number.isSafeInteger(b.version)||b.version<0||
  !['publish','amend','cancel'].includes(b.operation)||typeof b.reason!=='string'||!b.reason.trim()||b.reason.length>500||
  !Number.isSafeInteger(b.approvalVersion)||b.approvalVersion<1||b.previousIntentId!==undefined&&!/^[a-f0-9-]{36}$/.test(b.previousIntentId))
  throw new WorkflowError(400,'A destination, operation identity, exact versions and reason are required.');
 return {...b,reason:b.reason.trim()};
}

/** Durable intent and approval share the scenario transaction. Network I/O
 * happens only after commit, through the leased worker. */
export class TransferRepository {
 constructor(private store:StatefulStore,private tenantId:string,private workflow=new PlanWorkflow(store,tenantId)){}
 private async authorize(client:PoolClient,actor:Principal|undefined,permission:Permission){
  if(!actor)return;
  if(actor.tenantId!==this.tenantId)throw new WorkflowError(403,'Tenant mismatch.');
  const row=await client.query<{role:string}>('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2 FOR SHARE',[this.tenantId,actor.userId]);
  if(!hasPermission(row.rows[0]?.role,permission))throw new WorkflowError(403,'Handoff permission changed.');
 }
 private async operation(client:PoolClient,id:string,hash:string){
  const found=await client.query<IntentRow>('SELECT * FROM handoff_intents WHERE tenant_id=$1 AND operation_id=$2',[this.tenantId,id]);
  const row=found.rows[0];if(row&&row.request_sha256!==hash)throw new WorkflowError(409,'Operation identity was already used for a different instruction.');return row;
 }
 async status(planId:string){
  const plan=await this.store.getPlan(this.tenantId,planId);if(!plan)throw new WorkflowError(404,'Plan not found.');
  const intents=await this.store.pool.query<IntentRow>(`SELECT id,destination_id,scenario_id,plan_id,scenario_revision,generation,operation,reason,state,created_at,acknowledged_at,
   acknowledgement,last_error,attempts,plan_sha256,payload_sha256,idempotency_key,deadline,approval_version FROM handoff_intents
   WHERE tenant_id=$1 AND scenario_id=$2 AND (id IN (SELECT id FROM handoff_intents WHERE tenant_id=$1 AND scenario_id=$2 ORDER BY created_at DESC LIMIT 100)
    OR id IN (SELECT accepted_intent FROM handoff_heads WHERE tenant_id=$1 AND scenario_id=$2)
    OR id IN (SELECT current_intent FROM handoff_heads WHERE tenant_id=$1 AND scenario_id=$2)) ORDER BY created_at DESC`,[this.tenantId,plan.scenarioId]);
  const heads=await this.store.pool.query<{destination_id:string;generation:string;current_intent:string|null;accepted_intent:string|null}>('SELECT destination_id,generation,current_intent,accepted_intent FROM handoff_heads WHERE tenant_id=$1 AND scenario_id=$2',[this.tenantId,plan.scenarioId]);
  return {intents:intents.rows.map(summary),heads:heads.rows.map(h=>({destinationId:h.destination_id,version:Number(h.generation),currentIntentId:h.current_intent,acceptedIntentId:h.accepted_intent}))};
 }
 async enqueue(planId:string,revision:number,input:unknown,destination:Destination,actor?:Principal):Promise<TransferSummary>{
  const command=parseTransferCommand(input),permission=command.operation==='cancel'?'handoff.cancel':'handoff.send';
  if(destination.tenantId!==this.tenantId||destination.id!==command.destinationId)throw new WorkflowError(400,'Destination is not configured for this tenant.');
  const requestHash=planDigest({planId,revision,command});
  const replay=await this.store.tx(async client=>{await this.authorize(client,actor,permission);return this.operation(client,command.operationId,requestHash);});
  if(replay)return summary(replay);
  let created:IntentRow|undefined;
  try{await this.workflow.renderExport(planId,command.operation!=='cancel',(plan,metadata)=>JSON.stringify(planToHandoffJson(plan,plan.day,metadata)),async(client,plan,metadata,body)=>{
   const existing=await this.operation(client,command.operationId,requestHash);if(existing){created=existing;return;}
   if(metadata.currentScenarioRevision!==revision)throw new WorkflowError(409,'Scenario changed before handoff.');
   if(command.operation!=='cancel'){
    const ids=plan.vehicles.flatMap(v=>v.trips.flatMap(t=>t.stops.map(s=>s.requestId)));
    if(!/^[a-f0-9]{64}$/.test(plan.provenance.datasetSha256??'')||ids.length!==plan.stats.totalOrders||
     ids.some(id=>!Number.isSafeInteger(id)||Number(id)<0)||new Set(ids).size!==ids.length)
     throw new WorkflowError(409,'Acknowledged handoff requires complete dataset-scoped delivery identities. Replan legacy results before sending.');
   }
   await client.query('INSERT INTO handoff_heads(tenant_id,scenario_id,destination_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[this.tenantId,plan.scenarioId,destination.id]);
   const heads=await client.query<HeadRow>('SELECT generation,current_intent,accepted_intent FROM handoff_heads WHERE tenant_id=$1 AND scenario_id=$2 AND destination_id=$3 FOR UPDATE',[this.tenantId,plan.scenarioId,destination.id]);
   const head=heads.rows[0]!;
   if(Number(head.generation)!==command.version)throw new WorkflowError(409,'Handoff state changed; refresh before sending.');
   const current=head.current_intent?(await client.query<IntentRow>('SELECT * FROM handoff_intents WHERE tenant_id=$1 AND id=$2',[this.tenantId,head.current_intent])).rows[0]:undefined;
   if(current&&['queued','sending','retrying','needs_reconciliation'].includes(current.state))throw new WorkflowError(409,'Resolve the outstanding instruction before creating another.');
   const accepted=head.accepted_intent?(await client.query<IntentRow>('SELECT * FROM handoff_intents WHERE tenant_id=$1 AND id=$2',[this.tenantId,head.accepted_intent])).rows[0]:undefined;
   if((accepted?.id??undefined)!==command.previousIntentId)throw new WorkflowError(409,'The previous receiver receipt changed.');
   const active=accepted&&accepted.operation!=='cancel';
   if(command.operation==='publish'&&active)throw new WorkflowError(409,'Use an amendment for an already accepted instruction.');
   if(command.operation!=='publish'&&!active)throw new WorkflowError(409,'There is no accepted instruction to amend or cancel.');
   const approvalVersion=command.operation==='cancel'?Number(accepted!.approval_version):metadata.approval?.workflowVersion;
   if(approvalVersion!==command.approvalVersion)throw new WorkflowError(409,'Approval evidence changed before handoff.');
   if(command.operation==='amend'&&accepted!.plan_sha256===metadata.planSha256)throw new WorkflowError(409,'This exact approved plan is already acknowledged.');
   const id=randomUUID(),generation=Number(head.generation)+1,idempotencyKey=`cursus-${id}`;
   if(!Number.isSafeInteger(generation))throw new WorkflowError(409,'Handoff generation is outside the supported range.');
   const envelope:TransferEnvelope={protocol:'cursus.handoff.v1',intentId:id,tenantId:this.tenantId,destinationId:destination.id,scenarioId:plan.scenarioId,generation,
    operation:command.operation,reason:command.reason,createdAt:metadata.checkedAt,planId:command.operation==='cancel'?accepted!.plan_id:plan.id,
    scenarioRevision:command.operation==='cancel'?Number(accepted!.scenario_revision):plan.scenarioRevision,planSha256:command.operation==='cancel'?accepted!.plan_sha256:metadata.planSha256,
    approvalVersion:approvalVersion!,previousReceiptId:accepted?.acknowledgement?.receiptId??null,...(command.operation==='cancel'?{}:{plan:JSON.parse(body)})};
   const payload=JSON.stringify(envelope);if(Buffer.byteLength(payload)>16*1024*1024)throw new WorkflowError(413,'Handoff exceeds the supported payload size.');
   await client.query("INSERT INTO jobs(tenant_id,id,kind,idempotency_key,payload) VALUES($1,$2,'handoff',$3,$4)",[this.tenantId,id,command.operationId,{intentId:id}]);
   const inserted=await client.query<IntentRow>(`INSERT INTO handoff_intents(tenant_id,id,scenario_id,destination_id,generation,operation_id,request_sha256,destination_sha256,
    operation,reason,plan_id,scenario_revision,approval_version,plan_sha256,payload_text,payload_sha256,idempotency_key,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
    [this.tenantId,id,plan.scenarioId,destination.id,generation,command.operationId,requestHash,destination.sha256,command.operation,command.reason,envelope.planId,envelope.scenarioRevision,
     approvalVersion,envelope.planSha256,payload,digest(payload),idempotencyKey,actor?.userId??null]);
   await client.query('UPDATE handoff_heads SET generation=$4,current_intent=$5 WHERE tenant_id=$1 AND scenario_id=$2 AND destination_id=$3',[this.tenantId,plan.scenarioId,destination.id,generation,id]);
   await client.query("INSERT INTO audit_events(tenant_id,user_id,action,detail) VALUES($1,$2,'handoff.queue',$3)",[this.tenantId,actor?.userId??null,{intentId:id,planId:envelope.planId,generation,destinationId:destination.id,operation:command.operation,authorizingRevision:revision}]);
   created=inserted.rows[0];
  },client=>this.authorize(client,actor,permission));}
  catch(error){if((error as {code?:string}).code==='23505'){
   const found=await this.store.tx(client=>this.operation(client,command.operationId,requestHash));if(found)return summary(found);
  }throw error;}
  if(!created)throw new Error('Handoff transaction did not publish an intent.');return summary(created);
 }

 private async leasedRow(lease:Lease):Promise<IntentRow>{
  if(lease.tenantId!==this.tenantId||(lease.payload as {intentId?:unknown})?.intentId!==lease.id)throw new StaleFenceError();
  const row=(await this.store.pool.query<IntentRow>('SELECT * FROM handoff_intents WHERE tenant_id=$1 AND id=$2',[this.tenantId,lease.id])).rows[0];
  if(!row)throw new WorkflowError(404,'Handoff intent is unavailable.');return row;
 }
 private request(row:IntentRow):TransferRequest{
  let envelope:TransferEnvelope;try{envelope=JSON.parse(row.payload_text) as TransferEnvelope;}catch{throw new TransferHalt('needs_reconciliation','Stored instruction integrity check failed.');}
  if(digest(row.payload_text)!==row.payload_sha256||envelope.protocol!=='cursus.handoff.v1'||envelope.intentId!==row.id||envelope.tenantId!==row.tenant_id||
   envelope.destinationId!==row.destination_id||envelope.scenarioId!==row.scenario_id||envelope.generation!==Number(row.generation)||
   !Number.isSafeInteger(envelope.generation)||envelope.operation!==row.operation||envelope.planId!==row.plan_id||envelope.scenarioRevision!==Number(row.scenario_revision)||
   envelope.planSha256!==row.plan_sha256||envelope.approvalVersion!==Number(row.approval_version))throw new TransferHalt('needs_reconciliation','Stored instruction integrity check failed.');
  return {body:row.payload_text,payloadSha256:row.payload_sha256,idempotencyKey:row.idempotency_key,envelope};
 }
 private async lock(client:PoolClient,row:IntentRow){
  const head=(await client.query<HeadRow>('SELECT generation,current_intent,accepted_intent FROM handoff_heads WHERE tenant_id=$1 AND scenario_id=$2 AND destination_id=$3 FOR UPDATE',[this.tenantId,row.scenario_id,row.destination_id])).rows[0];
  const current=(await client.query<IntentRow>('SELECT * FROM handoff_intents WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[this.tenantId,row.id])).rows[0];
  if(!head||!current)throw new WorkflowError(409,'Handoff state is incomplete.');return {head,current};
 }
 private async owned(client:PoolClient,lease:Lease){
  const found=await client.query(`SELECT id FROM jobs WHERE tenant_id=$1 AND id=$2 AND kind='handoff' AND state='running'
   AND lease_owner=$3 AND fence=$4 AND lease_expires_at>=clock_timestamp() FOR UPDATE`,[this.tenantId,lease.id,lease.owner,lease.fence]);
  if(found.rowCount!==1)throw new StaleFenceError();
 }
 private async finishJob(client:PoolClient,lease:Lease,state:'succeeded'|'failed'|'queued',detail:unknown,error:string|null=null,delay=0){
  const done=await client.query(`UPDATE jobs SET state=$5,result=$6,error=$7,lease_owner=NULL,lease_expires_at=NULL,
   available_at=clock_timestamp()+make_interval(secs=>$8),updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND kind='handoff'
   AND state='running' AND lease_owner=$3 AND fence=$4 AND lease_expires_at>=clock_timestamp() RETURNING id`,[this.tenantId,lease.id,lease.owner,lease.fence,state,detail,error,delay]);
  if(done.rowCount!==1)throw new StaleFenceError();
 }

 async prepare(lease:Lease,destination:Destination):Promise<{request:TransferRequest;lookupOnly:boolean}>{
  const row=await this.leasedRow(lease);let prepared:{request:TransferRequest;lookupOnly:boolean}|undefined;
  await this.workflow.renderExport(row.plan_id,false,()=>'',async(client,_plan,metadata)=>{
   const {head,current}=await this.lock(client,row);await this.owned(client,lease);
   if(head.current_intent!==row.id||Number(head.generation)!==Number(row.generation))throw new TransferHalt('stale','A newer instruction exists.');
   if(destination.tenantId!==this.tenantId||destination.id!==current.destination_id||destination.sha256!==current.destination_sha256)
    throw new TransferHalt(current.attempts?'needs_reconciliation':'stale','Destination configuration changed; no request was sent.');
   const clock=(await client.query<{at:Date}>('SELECT clock_timestamp() at')).rows[0]!.at;
   const approved=current.operation==='cancel'||metadata.status==='Approved'&&metadata.planSha256===current.plan_sha256&&metadata.approval?.workflowVersion===Number(current.approval_version);
   const expired=clock>=current.deadline||lease.attempt>8;
   if((!approved||expired)&&current.attempts===0)throw new TransferHalt('stale',expired?'Instruction expired before any delivery attempt.':'Plan is no longer currently approved.');
   const lookupOnly=(lease.payload as {lookupOnly?:boolean}).lookupOnly===true||!approved||expired;
   const request=this.request(current);
   if(current.acknowledgement)throw new TransferHalt('needs_reconciliation','Instruction already has a receiver receipt.');
   await client.query("UPDATE handoff_attempts SET outcome='interrupted',ended_at=clock_timestamp() WHERE tenant_id=$1 AND intent_id=$2 AND outcome='started'",[this.tenantId,row.id]);
   await client.query('INSERT INTO handoff_attempts(tenant_id,intent_id,attempt,fence,method) VALUES($1,$2,$3,$4,$5)',[this.tenantId,row.id,lease.attempt,lease.fence,lookupOnly?'GET':'POST']);
   await client.query("UPDATE handoff_intents SET state='sending',attempts=greatest(attempts,$3),last_error=NULL WHERE tenant_id=$1 AND id=$2",[this.tenantId,row.id,lease.attempt]);
   prepared={request,lookupOnly};
  });
  if(!prepared)throw new Error('Handoff preflight did not complete.');return prepared;
 }

 async acknowledge(lease:Lease,value:unknown):Promise<TransferSummary>{
  const row=await this.leasedRow(lease),ack=validateAcknowledgement(value,this.request(row));let result:IntentRow|undefined;
  await this.workflow.renderExport(row.plan_id,false,()=>'',async(client,_plan,metadata)=>{
   const {head,current}=await this.lock(client,row);await this.owned(client,lease);
   const fresh=head.current_intent===row.id&&Number(head.generation)===Number(row.generation)&&
    (row.operation==='cancel'||metadata.status==='Approved'&&metadata.planSha256===row.plan_sha256&&metadata.approval?.workflowVersion===Number(row.approval_version));
   const state:TransferState=ack.status==='rejected'?'rejected':fresh?'acknowledged':'acknowledged_superseded';
   if(current.acknowledgement)throw new WorkflowError(409,'Receiver evidence already recorded.');
   await this.finishJob(client,lease,ack.status==='accepted'?'succeeded':'failed',{intentId:row.id,state},ack.status==='rejected'?'Receiver rejected the instruction.':null);
   result=(await client.query<IntentRow>(`UPDATE handoff_intents SET state=$3,acknowledged_at=clock_timestamp(),acknowledgement=$4,last_error=$5
    WHERE tenant_id=$1 AND id=$2 RETURNING *`,[this.tenantId,row.id,state,ack,ack.status==='rejected'?'Receiver rejected the instruction.':null])).rows[0];
   if(ack.status==='accepted'&&head.current_intent===row.id&&Number(head.generation)===Number(row.generation))
    await client.query('UPDATE handoff_heads SET accepted_intent=$4 WHERE tenant_id=$1 AND scenario_id=$2 AND destination_id=$3',[this.tenantId,row.scenario_id,row.destination_id,row.id]);
   await client.query("UPDATE handoff_attempts SET outcome=$4,ended_at=clock_timestamp() WHERE tenant_id=$1 AND intent_id=$2 AND attempt=$3 AND fence=$5 AND outcome='started'",[this.tenantId,row.id,lease.attempt,ack.status==='accepted'?'accepted':'rejected',lease.fence]);
   await client.query("INSERT INTO audit_events(tenant_id,action,detail) VALUES($1,'handoff.acknowledge',$2)",[this.tenantId,{intentId:row.id,generation:Number(row.generation),receiptId:ack.receiptId,payloadSha256:ack.payloadSha256,state}]);
  });
  if(!result)throw new Error('Handoff acknowledgement did not commit.');return summary(result);
 }

 async failed(lease:Lease,message:string,retryable:boolean,requestedState?:'stale'|'needs_reconciliation'){
  const row=await this.leasedRow(lease);
  await this.store.tx(async client=>{
   await client.query('SELECT id FROM scenarios WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[this.tenantId,row.scenario_id]);
   const {current}=await this.lock(client,row);await this.owned(client,lease);
   const clock=(await client.query<{at:Date}>('SELECT clock_timestamp() at')).rows[0]!.at;
   const retry=retryable&&!requestedState&&lease.attempt<8&&clock<current.deadline;
   const state:TransferState=retry?'retrying':requestedState==='stale'&&current.attempts===0?'stale':'needs_reconciliation';
   const safe=message.slice(0,500);
   await this.finishJob(client,lease,retry?'queued':'failed',{intentId:row.id,state},safe,retry?Math.min(60,2**lease.attempt):0);
   await client.query('UPDATE handoff_intents SET state=$3,last_error=$4 WHERE tenant_id=$1 AND id=$2',[this.tenantId,row.id,state,safe]);
   await client.query("UPDATE handoff_attempts SET outcome='ambiguous',ended_at=clock_timestamp(),detail=$4 WHERE tenant_id=$1 AND intent_id=$2 AND attempt=$3 AND fence=$5 AND outcome='started'",[this.tenantId,row.id,lease.attempt,safe,lease.fence]);
  });
 }

 async retry(id:string,mode:'retry'|'lookup',actor?:Principal):Promise<TransferSummary>{
  if(!/^[a-f0-9-]{36}$/.test(id)||!['retry','lookup'].includes(mode))throw new WorkflowError(400,'Invalid retry request.');
  return this.store.tx(async client=>{
   await this.authorize(client,actor,'handoff.send');
   const row=(await client.query<IntentRow>('SELECT * FROM handoff_intents WHERE tenant_id=$1 AND id=$2',[this.tenantId,id])).rows[0];
   if(!row)throw new WorkflowError(404,'Handoff not found.');
   if(row.operation==='cancel')await this.authorize(client,actor,'handoff.cancel');
   await client.query('SELECT id FROM scenarios WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[this.tenantId,row.scenario_id]);
   const {head,current}=await this.lock(client,row);
   if(head.current_intent!==id||current.acknowledgement||!['retrying','needs_reconciliation'].includes(current.state))throw new WorkflowError(409,'Only the current unacknowledged instruction can be retried.');
   const job=await client.query("UPDATE jobs SET state='queued',payload=$3,available_at=clock_timestamp(),error=NULL WHERE tenant_id=$1 AND id=$2 AND state IN ('failed','queued') RETURNING id",[this.tenantId,id,{intentId:id,lookupOnly:mode==='lookup'}]);
   if(job.rowCount!==1)throw new WorkflowError(409,'An attempt is still running.');
   const updated=(await client.query<IntentRow>("UPDATE handoff_intents SET state='retrying' WHERE tenant_id=$1 AND id=$2 RETURNING *",[this.tenantId,id])).rows[0]!;
   await client.query("INSERT INTO audit_events(tenant_id,user_id,action,detail) VALUES($1,$2,'handoff.retry',$3)",[this.tenantId,actor?.userId??null,{intentId:id,mode,idempotencyKey:row.idempotency_key}]);
   return summary(updated);
  });
 }
}
