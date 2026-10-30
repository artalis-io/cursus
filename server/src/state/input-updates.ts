import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {Principal} from '../auth.js';
import {hasPermission} from '../roles.js';
import type {Scenario} from '../store.js';
import type {InputUpdateIntent,InputUpdateLineage} from '../input-update-contract.js';
import type {StatefulStore} from './postgres.js';
import type {ObjectStore} from './objects.js';
import type {ManualDatasetLoader} from './manual.js';
import {loadConvertedDay,type ConvertedManifest} from './conversion.js';
import {ProfileRepository} from './profiles.js';
import {manualSettings} from './manual-settings.js';
import {planDigest,WorkflowError} from './plan-workflow.js';
import {reconcileInputs,updateRows} from '../plan/input-update.js';
import type {PoolClient} from 'pg';
import type {Plan} from '../types.js';

const need=(v:unknown,message:string,status=409):void=>{if(!v)throw new WorkflowError(status,message);};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function parseInputUpdate(v:unknown):InputUpdateIntent{
 need(object(v),'Input update body required.',400);const b=v as Record<string,unknown>;
 need(Object.keys(b).every(k=>['operationId','parentPlanId','datasetId','dayId','reason','matches','releaseRequestIds','unlockVehicleIds','profiles','identityReviewed','carryExceptions','acknowledgeInvalid'].includes(k)), 'Unsupported input update fields.',400);
 for(const k of ['operationId','parentPlanId','datasetId','dayId'])need(typeof b[k]==='string'&&(b[k] as string).trim().length>0&&(b[k] as string).length<=128&&!/[\u0000-\u001f]/.test(b[k] as string),'Invalid update identity.',400);
 need(/^[a-zA-Z0-9_-]{1,128}$/.test(b.operationId as string),'Invalid operation ID.',400);
 need(typeof b.reason==='string'&&b.reason.trim().length>0&&b.reason.length<=500&&b.identityReviewed===true&&typeof b.carryExceptions==='boolean'&&typeof b.acknowledgeInvalid==='boolean','A reason and reviewed correspondence are required.',400);
 for(const k of ['releaseRequestIds','unlockVehicleIds'])need(Array.isArray(b[k])&&(b[k] as unknown[]).length<=10000&&(b[k] as unknown[]).every(id=>Number.isSafeInteger(id)&&Number(id)>=0),'Invalid decision resolution.',400);
 need(Array.isArray(b.matches)&&b.matches.length<=10000&&b.matches.every(p=>object(p)&&Object.keys(p).length===2&&Number.isSafeInteger(p.from)&&Number(p.from)>=0&&Number.isSafeInteger(p.to)&&Number(p.to)>=0)&&Array.isArray(b.profiles)&&b.profiles.length<=2,'Invalid correspondence or profiles.',400);
 return b as unknown as InputUpdateIntent;
}
export class InputUpdates{
 constructor(private store:StatefulStore,private objects:ObjectStore,private tenant:string,private load:ManualDatasetLoader){}
 private async source(id:string,planId:string,revision?:number){
  const [scenario,rows]=await Promise.all([this.store.getScenario(this.tenant,id),this.store.pool.query<{body:Plan}>('SELECT body FROM plans WHERE tenant_id=$1 AND id=$2',[this.tenant,planId])]);
  const plan=rows.rows[0]?.body;
  need(scenario&&plan&&plan.scenarioId===id,'Scenario or source plan not found.',404);
  need(!scenario!.supersededBy&&plan!.scenarioRevision===scenario!.revision&&(revision===undefined||scenario!.revision===revision)&&
   (!scenario!.manualPlanId||scenario!.manualPlanId===planId)&&(!scenario!.selectedPlanId||scenario!.selectedPlanId===planId),'Open the current selected plan before updating inputs.');
  return {scenario:scenario!,plan:plan!};
 }
 private async target(source:Awaited<ReturnType<InputUpdates['source']>>,datasetId:string,dayId:string,refs:InputUpdateIntent['profiles']){
  const row=await this.store.getDataset(this.tenant,datasetId);need(row?.status==='admitted','Replacement snapshot must be admitted in this tenant.',404);
  const manifest=row!.manifest as ConvertedManifest,meta=manifest.days?.find(d=>d.dayId===dayId),sha=manifest.artifacts?.request?.sha256;
  need(meta?.isoDate===source.plan.day&&sha&&sha!==(source.plan.provenance.datasetSha256??source.plan.provenance.planningPolicy?.datasetRequestSha256),'Choose a different admitted snapshot for the same planning date.');
  const profiles=await new ProfileRepository(this.store,this.tenant).resolve(refs);
  need(profiles.every(p=>p.content.datasetSha256===sha),'Replacement profiles must match the replacement checksum.');
  const scenario:Scenario={id:'update-preview',day:'update-preview-day',kind:'copy',parentId:null,revision:1,label:'Updated input draft',createdAt:source.plan.createdAt,
   removedVehicleIds:[],pins:[],forbids:[],sequences:[],vehicleOverrides:[],planningProfiles:refs,deliveryDatasetSha256:sha,
   datasetBinding:{datasetId,dayId,requestSha256:sha!}};
  const day=await loadConvertedDay(this.objects,this.tenant,manifest,scenario,profiles);
  return {row:row!,manifest,sha:sha!,profiles,scenario,day};
 }
 async options(id:string,planId:string,datasetId?:string,dayId?:string){
  const source=await this.source(id,planId),datasets=await this.store.listDatasets(this.tenant,true);
  const choices=datasets.flatMap(row=>{const m=row.manifest as ConvertedManifest,sha=m.artifacts?.request?.sha256;
   if(typeof sha!=='string'||!/^[a-f0-9]{64}$/.test(sha)||!m.artifacts?.geocoded)return [];
   return (m.days??[]).filter(d=>d.isoDate===source.plan.day&&sha!==source.plan.provenance.datasetSha256)
   .map(d=>({datasetId:String(row.id),dayId:d.dayId,label:String((row.manifest as {name?:string;label?:string}).label??(row.manifest as {name?:string}).name??row.id),sha256:sha}));});
  const scope=(await this.store.listScenarios(this.tenant,source.scenario.day)).map(s=>({id:s.id,label:s.label,revision:s.revision}));
  if(!datasetId||!dayId)return {choices,scope};
  const old=await this.load(source.plan,source.scenario),target=await this.target(source,datasetId,dayId,[]),before=updateRows(old.day),after=updateRows(target.day);
  const suggested=before.flatMap(a=>{const b=after.filter(b=>b.reference===a.reference);return b.length===1&&before.filter(r=>r.reference===a.reference).length===1?[{from:a.id,to:b[0]!.id}]:[];});
  const profileRows=await new ProfileRepository(this.store,this.tenant).list();
  const fleetRows=target.day.request.vehicles.map(v=>{const info=old.vehicleInfo.get(v.ref.replace(/[^a-z0-9]/gi,'').toUpperCase()),reload=old.reloadSeconds.get(v.id);
   return info&&reload!==undefined?{id:v.id,ref:v.ref,vehicleClass:info.vehicleClass,isSubcontractor:info.isSubcontractor,tonnage:info.tonnage,hasTailLift:info.hasTailLift,reloadSec:reload,
    capacityKg:v.capacity[0],capacityPallets:v.capacity[1],available:!(old.unavailableVehicleIds??[]).includes(v.id)}:null;});
  const locations=new Map<number,unknown>();let consistent=true;
  for(const order of target.day.request.requests){const task=target.day.request.tasks.find(t=>t.id===order.delivery_task_id)!,info=target.day.deliveryEnrichment?.get(order.id)??target.day.enrichment.get(task.ref)!;
   const rule={locationId:task.location_id,maxGrossWeightKg:info.maxTonnage===null?null:info.maxTonnage*1000,requiresTailLift:info.requiresTailLift,serviceSeconds:task.service_seconds,
    windowStartSeconds:task.tw_early,windowEndSeconds:task.tw_late,reason:'Replacement source facts; review before approval'};
   if(locations.has(task.location_id)&&!isDeepStrictEqual(locations.get(task.location_id),rule))consistent=false;locations.set(task.location_id,rule);
  }
  const common={schemaVersion:1,datasetSha256:target.sha,reason:'Review replacement source facts before approval'};
  return {choices,scope,before,after,suggested,lockedVehicleIds:source.scenario.sequences.filter(s=>s.locked).map(s=>s.vehicleId),
   manualRequestIds:[...new Set([...Object.keys((source.plan.manual??source.plan.assignments)?.layout.decisions??{}).map(Number),...source.scenario.pins.flatMap(p=>p.requestId===undefined?before.filter(r=>r.reference===p.orderNo).map(r=>r.id):[p.requestId]),...source.scenario.forbids.flatMap(p=>p.requestId===undefined?before.filter(r=>r.reference===p.orderNo).map(r=>r.id):[p.requestId])])],
   exceptions:source.scenario.planningPolicy?.exceptions??[],requiredProfiles:[...new Set([...(source.scenario.planningProfiles??[]).map(p=>p.kind),...(old.datasetSha256&&old.datasetSha256!==target.sha?['fleet']:[])])],
   profileTemplates:{fleet:fleetRows.every(Boolean)?{...common,kind:'fleet',label:'Replacement fleet',settings:{datasetSha256:target.sha,vehicles:fleetRows,tariff:old.tariff}}:null,
    locations:consistent?{...common,kind:'locations',label:'Replacement locations',locations:[...locations.values()]}:null},
   profiles:profileRows.filter(p=>p.body.datasetSha256===target.sha)};
 }
 private async build(id:string,revision:number,intent:InputUpdateIntent,actor?:Principal){
  const source=await this.source(id,intent.parentPlanId,revision),old=await this.load(source.plan,source.scenario),target=await this.target(source,intent.datasetId,intent.dayId,intent.profiles);
  const sourceSha=old.day.datasetRequestSha256!,all=await this.store.listDatasets(this.tenant,true);
  const rawRows=all.filter(r=>(!source.scenario.datasetBinding||r.id===source.scenario.datasetBinding.datasetId)&&(r.manifest as ConvertedManifest).artifacts?.request?.sha256===sourceSha);
  need(rawRows.length===1,'Source snapshot identity is ambiguous.');
  const raw=await loadConvertedDay(this.objects,this.tenant,rawRows[0]!.manifest as ConvertedManifest,{...source.scenario,planningProfiles:[],planningPolicy:undefined},[]);
  const targetRaw=await loadConvertedDay(this.objects,this.tenant,target.manifest,{...target.scenario,planningProfiles:[]},[]);
  need(isDeepStrictEqual(raw.request.vehicles,targetRaw.request.vehicles),'Fleet identity/configuration changed. Reconcile verified fleet inputs before updating orders.');
  need(target.profiles.some(p=>p.kind==='fleet')||!old.datasetSha256||old.datasetSha256===target.sha,'External fleet settings are dataset-bound; approve a replacement fleet profile first.');
  const kinds=new Set(target.profiles.map(p=>p.kind));
  need((source.scenario.planningProfiles??[]).every(p=>kinds.has(p.kind)),'Approve and select replacement profiles before transferring this workspace.');
  const fleet=target.profiles.find(p=>p.kind==='fleet'),settings=fleet?manualSettings(fleet.content.settings):old;
  for(const override of source.scenario.vehicleOverrides){const v=target.day.request.vehicles.find(v=>v.id===override.vehicleId);
   need(v&&(override.capacityKg===undefined||override.capacityKg<=v.capacity[0]!)&&(override.capacityPallets===undefined||override.capacityPallets<=v.capacity[1]!), 'An existing capacity override exceeds the replacement profile. Reconcile it before updating.');}
  const exceptions=source.scenario.planningPolicy?.exceptions??[];
  if(exceptions.length){
   need(intent.carryExceptions,'Existing access exceptions require explicit Admin reapproval for the new snapshot.');
   need(!actor||actor.role==='admin','Only Admin can reapprove carried access exceptions.',403);
   const pairs=new Map(intent.matches.map(p=>[p.from,p.to]));
   const coordinates=(day:typeof raw,id:number)=>{const r=day.request.requests.find(r=>r.id===id),task=day.request.tasks.find(t=>t.id===r?.delivery_task_id);return task&&day.request.locations[task.location_id];};
   for(const exception of exceptions){
    const a=updateRows(raw).filter(r=>r.reference===exception.orderNo),b=updateRows(targetRaw).filter(r=>r.reference===exception.orderNo);
    need(a.length>0&&a.length===b.length&&a.every(r=>b.some(t=>t.id===pairs.get(r.id)&&t.address===r.address&&t.customer===r.customer&&isDeepStrictEqual(coordinates(raw,r.id),coordinates(targetRaw,t.id)))),'An exception destination changed or is not fully matched. Reconcile its approved policy before updating.');
   }
   target.scenario.planningPolicy={...structuredClone(source.scenario.planningPolicy!),id:`update_${intent.operationId}`.slice(0,128),datasetRequestSha256:target.sha,approvedBy:actor?.userId??'local',approvedAt:source.plan.createdAt};
   target.day=await loadConvertedDay(this.objects,this.tenant,target.manifest,target.scenario,target.profiles);
  }
  const context={...settings,day:target.day};
  const result=reconcileInputs(source.plan,source.scenario,old,context,target.scenario,intent);
  const scope=await this.store.listScenarios(this.tenant,source.scenario.day);
  need(scope.every(s=>!s.supersededBy),'This planning cycle was already replaced.');
  const pending=await this.store.pool.query(`SELECT 1 FROM handoff_heads h LEFT JOIN handoff_intents a ON a.tenant_id=h.tenant_id AND a.id=h.accepted_intent
   LEFT JOIN handoff_intents c ON c.tenant_id=h.tenant_id AND c.id=h.current_intent WHERE h.tenant_id=$1 AND h.scenario_id=ANY($2::text[]) AND
   (a.operation IS NOT NULL AND a.operation<>'cancel' OR c.state IN ('queued','sending','retrying','needs_reconciliation')) LIMIT 1`,[this.tenant,scope.map(s=>s.id)]);
  if(pending.rowCount)result.diff.conflicts.push({code:'downstream_commitment',message:'Accepted, pending or uncertain handoff: cancel/reconcile downstream instructions first.'});
  const hash=planDigest({intent,sourcePlan:source.plan,scope,target:target.row,profiles:target.profiles,context:{fleet:[...context.vehicleInfo],reload:[...context.reloadSeconds],tariff:context.tariff},diff:result.diff,stats:result.plan.stats,validation:result.plan.provenance.validation});
  return {source,target,scope,result,hash};
 }
 async preview(id:string,revision:number,body:unknown,actor?:Principal){
  const intent=parseInputUpdate(body),x=await this.build(id,revision,intent,actor);
  return {previewSha256:x.hash,diff:x.result.diff,stats:x.result.plan.stats,cost:x.result.plan.cost,validation:x.result.plan.provenance.validation,
   archivedWorkspaces:x.scope.map(s=>({id:s.id,label:s.label})),approval:'Draft' as const};
 }
 private async authorize(client:PoolClient,actor?:Principal,exceptions=false){
  if(!actor)return;
  need(actor.tenantId===this.tenant&&hasPermission(actor.role,'scenario.edit')&&hasPermission(actor.role,'scenario.create')&&(!exceptions||actor.role==='admin'),'Update permission required.',403);
  const found=await client.query<{role:string}>('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2 FOR SHARE',[this.tenant,actor.userId]);
  need(hasPermission(found.rows[0]?.role,'scenario.edit')&&hasPermission(found.rows[0]?.role,'scenario.create')&&(!exceptions||found.rows[0]?.role==='admin'),'Update permission changed.',403);
 }
 async apply(id:string,revision:number,body:unknown,digest:unknown,actor?:Principal,confirmed=false){
  need(confirmed,'Explicitly confirm superseding the previous planning cycle.',400);
  need(typeof digest==='string'&&/^[a-f0-9]{64}$/.test(digest),'A verified preview is required.',400);
  const intent=parseInputUpdate(body),payload=planDigest({id,revision,intent,digest}),actorId=actor?.userId??'local';
  const receipt=async(client:PoolClient)=>{
   await this.authorize(client,actor,intent.carryExceptions);
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`input-update/${this.tenant}/${intent.operationId}`]);
   const row=await client.query<{detail:{payload:string;actorId:string;planId:string}}>("SELECT detail FROM audit_events WHERE tenant_id=$1 AND action='input.update' AND detail->>'operationId'=$2",[this.tenant,intent.operationId]);
   if(!row.rows[0])return null;need(row.rows[0].detail.payload===payload&&row.rows[0].detail.actorId===actorId,'Operation identity was already used for another update.');
   const saved=await client.query<{body:Plan}>('SELECT body FROM plans WHERE tenant_id=$1 AND id=$2',[this.tenant,row.rows[0].detail.planId]);need(saved.rows[0],'Update receipt is incomplete.');return saved.rows[0]!.body;
  };
  const replay=await this.store.tx(receipt);if(replay)return replay;
  const x=await this.build(id,revision,intent,actor);need(x.hash===digest,'Inputs, policies or workspace changed after preview.');need(!x.result.diff.conflicts.length,'Resolve input-update conflicts before applying.');
  need(x.result.plan.provenance.validation.valid||intent.acknowledgeInvalid,'Explicitly acknowledge the invalid draft before continuing.');
  const now=new Date().toISOString(),alias=`input-${randomUUID()}`,baseId=`scn_${randomUUID()}`,scenarioId=`scn_${randomUUID()}`,planId=`pln_${randomUUID()}`,basePlanId=`pln_${randomUUID()}`;
  const lineage:InputUpdateLineage={sourcePlanId:x.source.plan.id,sourceScenarioId:id,sourceRevision:revision,sourceDatasetSha256:x.source.plan.provenance.datasetSha256!,targetDatasetId:intent.datasetId,targetDatasetSha256:x.target.sha,
   operationId:intent.operationId,reason:intent.reason,at:now,matches:intent.matches,releasedRequestIds:intent.releaseRequestIds,unlockedVehicleIds:intent.unlockVehicleIds};
  const scenario:Scenario={...x.result.scenario,id:scenarioId,day:alias,parentId:baseId,label:`${x.source.scenario.label} — updated inputs`,createdAt:now,inputUpdate:lineage,manualPlanId:planId,selectedPlanId:planId,selectionVersion:1};
  if(scenario.planningPolicy)scenario.planningPolicy.approvedAt=now;
  const plan={...x.result.plan,id:planId,scenarioId,createdAt:now,provenance:{...x.result.plan.provenance,inputUpdate:lineage,...(scenario.planningPolicy?{planningPolicy:scenario.planningPolicy}:{})}};
  const baseScenario:Scenario={...structuredClone(scenario),id:baseId,parentId:null,kind:'base',label:`${x.source.plan.day} · updated inputs`,manualPlanId:basePlanId,selectedPlanId:basePlanId};
  const basePlan={...structuredClone(plan),id:basePlanId,scenarioId:baseId};
  return this.store.tx(async client=>{
   const again=await receipt(client);if(again)return again;
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`input-day/${this.tenant}/${x.source.scenario.day}`]);
   const current=await client.query<{body:Scenario}>("SELECT body FROM scenarios WHERE tenant_id=$1 AND body->>'day'=$2 ORDER BY id FOR UPDATE",[this.tenant,x.source.scenario.day]);
   need(planDigest(current.rows.map(r=>r.body).sort((a,b)=>a.id.localeCompare(b.id)))===planDigest([...x.scope].sort((a,b)=>a.id.localeCompare(b.id))),'Workspace changed during reconciliation.');
   const dataset=await client.query('SELECT manifest,status FROM datasets WHERE tenant_id=$1 AND id=$2 FOR SHARE',[this.tenant,intent.datasetId]);
   need(dataset.rows[0]?.status==='admitted'&&planDigest(dataset.rows[0].manifest)===planDigest(x.target.row.manifest),'Replacement snapshot changed.');
   const parent=await client.query('SELECT body FROM plans WHERE tenant_id=$1 AND id=$2 FOR SHARE',[this.tenant,intent.parentPlanId]);
   need(parent.rows[0]&&planDigest(parent.rows[0].body)===planDigest(x.source.plan),'Source plan changed during reconciliation.');
   // Serialize with publication/cancellation and recheck acknowledgements.
   await client.query('SELECT 1 FROM handoff_heads WHERE tenant_id=$1 AND scenario_id=ANY($2::text[]) FOR UPDATE',[this.tenant,x.scope.map(s=>s.id)]);
   const active=await client.query(`SELECT 1 FROM handoff_heads h LEFT JOIN handoff_intents a ON a.tenant_id=h.tenant_id AND a.id=h.accepted_intent LEFT JOIN handoff_intents c ON c.tenant_id=h.tenant_id AND c.id=h.current_intent
    WHERE h.tenant_id=$1 AND h.scenario_id=ANY($2::text[]) AND (a.operation IS NOT NULL AND a.operation<>'cancel' OR c.state IN ('queued','sending','retrying','needs_reconciliation')) LIMIT 1`,[this.tenant,x.scope.map(s=>s.id)]);
   need(!active.rowCount,'Downstream acceptance changed during reconciliation.');
   for(const s of current.rows.map(r=>r.body)){
    const archived={...s,revision:s.revision+1,supersededBy:{scenarioId,planId,at:now}};
    await client.query('UPDATE scenarios SET revision=$3,body=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2',[this.tenant,s.id,archived.revision,archived]);
   }
   for(const s of [baseScenario,scenario])await client.query('INSERT INTO scenarios(tenant_id,id,revision,body) VALUES($1,$2,1,$3)',[this.tenant,s.id,s]);
   for(const p of [basePlan,plan])await client.query('INSERT INTO plans(tenant_id,id,scenario_id,scenario_revision,body) VALUES($1,$2,$3,1,$4)',[this.tenant,p.id,p.scenarioId,p]);
   await client.query(`UPDATE jobs SET state='failed',fence=fence+1,lease_owner=NULL,lease_expires_at=NULL,error='Input snapshot superseded',updated_at=now()
    WHERE tenant_id=$1 AND kind='solve' AND state IN ('queued','running') AND payload->'scenario'->>'id'=ANY($2::text[])`,[this.tenant,x.scope.map(s=>s.id)]);
   await client.query("INSERT INTO audit_events(tenant_id,user_id,action,detail) VALUES($1,$2,'input.update',$3)",[this.tenant,actor?.userId??null,{payload,actorId,operationId:intent.operationId,planId,sourceScenarios:x.scope,lineage,previewSha256:digest}]);
   return plan;
  });
 }
}
