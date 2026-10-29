import {randomUUID} from 'node:crypto';
import {StaleFenceError,type StatefulStore} from './postgres.js';
import {TransferRepository,TransferHalt} from './transfers.js';
import {TransferFailure,type Destination,type HandoffSender} from './handoff-sender.js';
import {PlanWorkflow} from './plan-workflow.js';
import type {Plan} from '../types.js';

/** A single bounded delivery attempt. Provider I/O never holds a DB transaction. */
export async function workOneTransfer(store:StatefulStore,tenantId:string,destinations:Destination[],sender:HandoffSender,
 workerId=`handoff-${randomUUID()}`,leaseSeconds=30,policyBlockers?:(plan:Plan)=>string[]):Promise<boolean>{
 const lease=await store.claimJob('handoff',workerId,leaseSeconds,tenantId);if(!lease)return false;
 const repo=new TransferRepository(store,tenantId,new PlanWorkflow(store,tenantId,policyBlockers)),abort=new AbortController();let pending:Promise<unknown>|undefined;
 const timer=setInterval(()=>{if(!pending)pending=store.heartbeatJob(lease,leaseSeconds).catch(()=>abort.abort()).finally(()=>{pending=undefined;});},Math.max(250,leaseSeconds*500));
 try{
  const state=await store.pool.query<{destination_id:string}>('SELECT destination_id FROM handoff_intents WHERE tenant_id=$1 AND id=$2',[tenantId,lease.id]);
  const destination=destinations.find(d=>d.tenantId===tenantId&&d.id===state.rows[0]?.destination_id);
  if(!destination)throw new TransferHalt('needs_reconciliation','Destination is unavailable; no request was sent.');
  const prepared=await repo.prepare(lease,destination);
  const acknowledgement=prepared.lookupOnly?await sender.lookup(destination,prepared.request,abort.signal):await sender.send(destination,prepared.request,abort.signal);
  if(!acknowledgement)throw new TransferHalt('needs_reconciliation','No receipt found. A late request may still be accepted; do not create a replacement instruction.');
  await repo.acknowledge(lease,acknowledgement);
 }catch(error){
  if(!(error instanceof StaleFenceError))try{
   await repo.failed(lease,error instanceof TransferHalt||error instanceof TransferFailure?error.message:'Handoff attempt failed; inspect receiver evidence before retrying.',
    error instanceof TransferFailure&&error.retryable,error instanceof TransferHalt?error.state:undefined);
  }catch(failure){if(!(failure instanceof StaleFenceError))throw failure;}
 }finally{clearInterval(timer);await pending;}
 return true;
}
