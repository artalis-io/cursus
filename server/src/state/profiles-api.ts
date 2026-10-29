import type { FastifyInstance } from 'fastify';
import type { StatefulStore } from './postgres.js';
import { ProfileRepository } from './profiles.js';
import { expectedRevision } from '../revisions.js';
import { WorkflowError } from './plan-workflow.js';
import type { ProfileRef } from '../planning-profiles.js';
import { parseProfile } from '../planning-profiles.js';
import type { ManualDatasetLoader } from './manual.js';

export function registerProfileApi(app:FastifyInstance,store:StatefulStore,tenantId:string,load?:ManualDatasetLoader){
  const profiles=new ProfileRepository(store,tenantId);
  app.get('/api/profiles',{config:{permission:'workspace.read'}},async(_req,reply)=>{
    reply.header('Cache-Control','private, no-store');return profiles.list();
  });
  app.get<{Querystring:{planId?:string;kind?:string}}>('/api/profiles/template',{config:{permission:'workspace.read'}},async(req,reply)=>{
    reply.header('Cache-Control','private, no-store');
    if(!load)return reply.code(503).send({error:'Trusted source settings are unavailable.'});
    if(!req.query.planId||!['fleet','locations'].includes(req.query.kind??''))return reply.code(400).send({error:'Plan and profile kind required.'});
    const plan=await store.getPlan(tenantId,req.query.planId);
    const scenario=plan&&await store.getScenario(tenantId,plan.scenarioId);
    if(!plan||!scenario)return reply.code(404).send({error:'Plan not found.'});
    if(plan.scenarioRevision!==scenario.revision)return reply.code(409).send({error:'Open a current plan before proposing a profile.'});
    const context=await load(plan,scenario),datasetSha256=context.day.datasetRequestSha256;
    const common={schemaVersion:1,datasetSha256,label:req.query.kind==='fleet'?'Fleet profile':'Location profile',reason:'',kind:req.query.kind};
    if(req.query.kind==='fleet'){
      const vehicles=context.day.request.vehicles.map(v=>{
        const info=context.vehicleInfo.get(v.ref.replace(/[^a-z0-9]/gi,'').toUpperCase());
        if(!info)throw new Error('Trusted vehicle evidence missing.');
        return {id:v.id,ref:v.ref,vehicleClass:info.vehicleClass,isSubcontractor:info.isSubcontractor,tonnage:info.tonnage,
          hasTailLift:info.hasTailLift,reloadSec:context.reloadSeconds.get(v.id),available:!context.unavailableVehicleIds?.includes(v.id),capacityKg:v.capacity[0],capacityPallets:v.capacity[1]};
      });
      return {...common,settings:{datasetSha256,vehicles,tariff:context.tariff}};
    }
    const byLocation=new Map<number,unknown>();
    for(const request of context.day.request.requests){
      const task=context.day.request.tasks.find(t=>t.id===request.delivery_task_id);
      const info=task&&(context.day.deliveryEnrichment?.get(request.id)??context.day.enrichment.get(task.ref));
      if(!task||!info)return reply.code(409).send({error:'Location source evidence is unavailable.'});
      const rule={label:`${info.customer??info.orderNo}${info.city?` · ${info.city}`:''}`.slice(0,240),locationId:task.location_id,maxGrossWeightKg:info.maxTonnage===null?null:info.maxTonnage*1000,
        requiresTailLift:info.requiresTailLift,serviceSeconds:task.service_seconds,windowStartSeconds:task.tw_early,windowEndSeconds:task.tw_late,reason:'Source settings; review before approval'};
      if(byLocation.has(task.location_id)&&JSON.stringify(byLocation.get(task.location_id))!==JSON.stringify(rule))
        return reply.code(409).send({error:'Deliveries at one location have different windows or requirements; reconcile a location-specific profile explicitly.'});
      byLocation.set(task.location_id,rule);
    }
    return {...common,locations:[...byLocation.values()]};
  });
  for(const url of ['/api/profiles','/api/profiles/:id/revisions'])app.post<{Params:{id?:string};Body:{content?:unknown}}>(url,
    {config:{permission:'profile.propose'}},async(req,reply)=>{
      const version=expectedRevision(req.headers);
      if(version===null)return reply.code(428).send({error:'If-Match profile version is required.'});
      let content;try{content=parseProfile(req.body?.content);}catch(error){return reply.code(400).send({error:(error as Error).message});}
      try{return reply.code(201).send(await profiles.propose(content,version,req.params.id,req.cursusPrincipal));}
      catch(error){if(error instanceof WorkflowError)return reply.code(error.status).send({error:error.message});throw error;}
    });
  app.post<{Params:{id:string};Body:{revision?:unknown}}>('/api/profiles/:id/activate',
    {config:{permission:'profile.approve'}},async(req,reply)=>{
      const version=expectedRevision(req.headers);
      if(version===null)return reply.code(428).send({error:'If-Match profile version is required.'});
      try{return await profiles.activate(req.params.id,Number(req.body?.revision),version,req.cursusPrincipal);}
      catch(error){if(error instanceof WorkflowError)return reply.code(error.status).send({error:error.message});throw error;}
    });
  app.post<{Params:{id:string};Body:{profiles?:unknown}}>('/api/scenarios/:id/profiles',
    {config:{permission:'scenario.edit'}},async(req,reply)=>{
      const revision=expectedRevision(req.headers);
      if(revision===null)return reply.code(428).send({error:'If-Match scenario revision is required.'});
      if(!Array.isArray(req.body?.profiles))return reply.code(400).send({error:'Profile references are required.'});
      try{return await profiles.bind(req.params.id,revision,req.body.profiles as ProfileRef[],req.cursusPrincipal);}
      catch(error){if(error instanceof WorkflowError)return reply.code(error.status).send({error:error.message});throw error;}
    });
}
