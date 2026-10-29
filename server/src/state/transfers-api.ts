import type {FastifyInstance} from 'fastify';
import type {StatefulStore} from './postgres.js';
import {TransferRepository,parseTransferCommand} from './transfers.js';
import type {Destination} from './handoff-sender.js';
import {WorkflowError,PlanWorkflow} from './plan-workflow.js';
import {expectedRevision} from '../revisions.js';

export function registerTransferApi(app:FastifyInstance,store:StatefulStore,tenantId:string,destinations:Destination[],workflow:PlanWorkflow){
 const repository=new TransferRepository(store,tenantId,workflow);
 app.get('/api/handoff/destinations',{config:{permission:'workspace.read'}},async(_req,reply)=>{
  reply.header('Cache-Control','private, no-store');return destinations.filter(d=>d.tenantId===tenantId).map(({id,label,protocol})=>({id,label,protocol}));
 });
 app.get<{Params:{id:string}}>('/api/plans/:id/transfers',{config:{permission:'workspace.read'}},async(req,reply)=>{
  reply.header('Cache-Control','private, no-store');try{return await repository.status(req.params.id);}catch(e){if(e instanceof WorkflowError)return reply.code(e.status).send({error:e.message});throw e;}
 });
 for(const operation of ['publish','amend','cancel'] as const)app.post<{Params:{id:string};Body:unknown}>(`/api/plans/:id/transfers/${operation}`,
  {config:{permission:operation==='cancel'?'handoff.cancel':'handoff.send'}},async(req,reply)=>{
   const revision=expectedRevision(req.headers);if(revision===null)return reply.code(428).send({error:'If-Match scenario revision is required.'});
   try{
    const command=parseTransferCommand(req.body);if(command.operation!==operation)throw new WorkflowError(400,'Operation does not match this endpoint.');
    const destination=destinations.find(d=>d.tenantId===tenantId&&d.id===command.destinationId);if(!destination)throw new WorkflowError(409,'Destination is not configured.');
    return reply.code(202).send(await repository.enqueue(req.params.id,revision,command,destination,req.cursusPrincipal));
   }catch(e){if(e instanceof WorkflowError)return reply.code(e.status).send({error:e.message});throw e;}
  });
 app.post<{Params:{id:string};Body:{mode?:unknown}}>('/api/handoff/:id/retry',{config:{permission:'handoff.send'}},async(req,reply)=>{
  if(!req.body||Object.keys(req.body).some(k=>k!=='mode')||!['retry','lookup'].includes(String(req.body.mode)))return reply.code(400).send({error:'Choose retry or receipt lookup.'});
  try{return reply.code(202).send(await repository.retry(req.params.id,req.body.mode as 'retry'|'lookup',req.cursusPrincipal));}
  catch(e){if(e instanceof WorkflowError)return reply.code(e.status).send({error:e.message});throw e;}
 });
}
