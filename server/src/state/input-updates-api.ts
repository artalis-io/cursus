import type {FastifyInstance} from 'fastify';
import type {StatefulStore} from './postgres.js';
import type {ObjectStore} from './objects.js';
import type {ManualDatasetLoader} from './manual.js';
import {InputUpdates} from './input-updates.js';
import {WorkflowError} from './plan-workflow.js';
import {expectedRevision} from '../revisions.js';
import {viewIdentity} from '../access-control.js';

export function registerInputUpdates(app:FastifyInstance,store:StatefulStore,tenant:string,objects?:ObjectStore,load?:ManualDatasetLoader){
 const service=objects&&load?new InputUpdates(store,objects,tenant,load):null;
 app.get<{Params:{id:string};Querystring:{planId?:string;datasetId?:string;dayId?:string}}>('/api/scenarios/:id/input-update-options',{config:{permission:'workspace.read'}},async(req,reply)=>{
  reply.header('Cache-Control','private, no-store');
  if(!service)return reply.code(503).send({error:'Immutable dataset storage and planning settings are required.'});
  if(!req.query.planId)return reply.code(400).send({error:'Source plan required.'});
  try{return await service.options(req.params.id,req.query.planId,req.query.datasetId,req.query.dayId);}
  catch(e){if(e instanceof WorkflowError)return reply.code(e.status).send({error:e.message});return reply.code(422).send({error:'Source planning evidence is unavailable; reconcile the current workspace first.'});}
 });
 let busy=false;
 for(const action of ['preview','apply'] as const)app.post<{Params:{id:string}}>(`/api/scenarios/:id/input-update-${action}`,{config:{permission:action==='preview'?'plan.evaluate':'scenario.edit'}},async(req,reply)=>{
  reply.header('Cache-Control','private, no-store');
  if(!service)return reply.code(503).send({error:'Input snapshot updates are unavailable.'});
  if(req.headers['if-match']===undefined)return reply.code(428).send({error:'If-Match revision required.'});
  const revision=expectedRevision(req.headers);if(revision===null)return reply.code(400).send({error:'Quoted non-negative revision required.'});
  if(busy)return reply.header('Retry-After','2').code(429).send({error:'Input update evaluation is busy. Try again shortly.'});
  busy=true;
  try{
   const actor=req.cursusPrincipal?{...req.cursusPrincipal,role:viewIdentity(req.cursusPrincipal,req.headers.cookie).effectiveRole as typeof req.cursusPrincipal.role}:undefined;
   if(action==='preview')return await service.preview(req.params.id,revision,req.body,actor);
   const body=req.body as {intent?:unknown;previewSha256?:unknown;acknowledgeSupersession?:unknown};
   if(!body||Object.keys(body).some(k=>!['intent','previewSha256','acknowledgeSupersession'].includes(k)))return reply.code(400).send({error:'Update intent and preview required.'});
   return reply.code(201).send(await service.apply(req.params.id,revision,body.intent,body.previewSha256,actor,body.acknowledgeSupersession===true));
  }catch(e){if(e instanceof WorkflowError)return reply.code(e.status).send({error:e.message});return reply.code(422).send({error:'The replacement snapshot cannot be reconciled with the available source evidence.'});}
  finally{busy=false;}
 });
}
