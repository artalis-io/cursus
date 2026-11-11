import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {Principal} from '../auth.js';
import {hasPermission} from '../roles.js';
import type {Scenario} from '../store.js';
import type {Plan} from '../types.js';
import type {ProfileChangeIntent,ProfileChangeLineage,ProfileChangePreview} from '../profile-change-contract.js';
import {reviewProfileChange} from '../plan/profile-change.js';
import {prepareManualInput,materializeManualPlan,type ManualDatasetContext} from '../plan/manual-adapter.js';
import type {StatefulStore} from './postgres.js';
import type {ManualDatasetLoader} from './manual.js';
import {manualSettings} from './manual-settings.js';
import {ProfileRepository} from './profiles.js';
import {planDigest,WorkflowError} from './plan-workflow.js';
const need=(v:unknown,message:string,status=409):void=>{if(!v)throw new WorkflowError(status,message);};
const permissions=['scenario.edit','scenario.create','plan.evaluate'] as const;
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function parseProfileChange(value:unknown):ProfileChangeIntent{
 need(record(value),'Profile change intent required.',400);const b=value as Record<string,unknown>;
 need(Object.keys(b).every(k=>['operationId','parentPlanId','profiles','reason','releaseRequestIds','unlockVehicleIds','clearVehicleOverrideIds','acknowledgeInvalid'].includes(k)), 'Unsupported profile change fields.',400);
 need(typeof b.operationId==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(b.operationId)&&typeof b.parentPlanId==='string'&&b.parentPlanId.length>0&&b.parentPlanId.length<=128&&!/[\u0000-\u001f]/.test(b.parentPlanId),'Invalid profile change identity.',400);
 need(typeof b.reason==='string'&&b.reason.trim().length>0&&b.reason.length<=500&&typeof b.acknowledgeInvalid==='boolean'&&Array.isArray(b.profiles)&&b.profiles.length<=2,'Profiles, reason and draft acknowledgement are required.',400);
 for(const k of ['releaseRequestIds','unlockVehicleIds','clearVehicleOverrideIds'])need(Array.isArray(b[k])&&(b[k] as unknown[]).length<=10000&&(b[k] as unknown[]).every(n=>Number.isSafeInteger(n)&&Number(n)>=0)&&new Set(b[k] as unknown[]).size===(b[k] as unknown[]).length,'Invalid or duplicate decision resolutions.',400);
 return structuredClone(b) as unknown as ProfileChangeIntent;
}
function recordedContext(context:ManualDatasetContext,scenario:Scenario):ManualDatasetContext{
 const saved=scenario.manualDecisions;if(!saved)return context;
 need(saved.tariff&&saved.fleetInfo&&saved.reloadSeconds,'Recorded planning settings are incomplete.',422);
 const info=new Map(saved.fleetInfo),reload=new Map(saved.reloadSeconds),operating=new Map(saved.operatingLimits??[]);
 const settings=manualSettings({datasetSha256:saved.datasetSha256,tariff:saved.tariff,vehicles:context.day.request.vehicles.map(v=>{
  const row=info.get(v.ref.replace(/[^a-z0-9]/gi,'').toUpperCase());need(row,'Recorded vehicle evidence is missing.',422);
  return {id:v.id,ref:v.ref,vehicleClass:row!.vehicleClass,isSubcontractor:row!.isSubcontractor,tonnage:row!.tonnage,hasTailLift:row!.hasTailLift,reloadSec:reload.get(v.id),operatingLimits:operating.get(v.id),available:!saved.unavailableVehicleIds?.includes(v.id)};
 })});
 return {...settings,day:context.day};
}
export class ProfileChanges{
 constructor(private store:StatefulStore,private tenant:string,private load:ManualDatasetLoader){}
 private allowed(actor?:Principal){need(!actor||actor.tenantId===this.tenant&&permissions.every(p=>hasPermission(actor.role,p)),'Profile draft permission required.',403);}
 private async authorize(client:PoolClient,actor?:Principal){
  this.allowed(actor);if(!actor)return;
  const role=await client.query<{role:string}>('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2 FOR SHARE',[this.tenant,actor.userId]);
  need(permissions.every(p=>hasPermission(role.rows[0]?.role,p)),'Profile draft permission changed.',403);
 }
 private async pending(client:Pick<PoolClient,'query'>,id:string,lock=false){
  if(lock)await client.query('SELECT 1 FROM handoff_heads WHERE tenant_id=$1 AND scenario_id=$2 FOR UPDATE',[this.tenant,id]);
  const r=await client.query(`SELECT 1 FROM handoff_heads h LEFT JOIN handoff_intents a ON a.tenant_id=h.tenant_id AND a.id=h.accepted_intent
   LEFT JOIN handoff_intents c ON c.tenant_id=h.tenant_id AND c.id=h.current_intent WHERE h.tenant_id=$1 AND h.scenario_id=$2 AND
   (a.operation IS NOT NULL AND a.operation<>'cancel' OR c.state IN ('queued','sending','retrying','needs_reconciliation')) LIMIT 1`,[this.tenant,id]);return !!r.rowCount;
 }
 private async build(id:string,revision:number,intent:ProfileChangeIntent,actor?:Principal){
  this.allowed(actor);need(Number.isSafeInteger(revision)&&revision>=0,'Invalid planning revision.',400);
  const [source,rows]=await Promise.all([this.store.getScenario(this.tenant,id),this.store.pool.query<{body:Plan}>('SELECT body FROM plans WHERE tenant_id=$1 AND id=$2',[this.tenant,intent.parentPlanId])]);
  const parent=rows.rows[0]?.body;need(source&&parent&&parent.scenarioId===id,'Scenario or parent plan not found.',404);
  need(!source!.supersededBy&&source!.revision===revision&&parent!.scenarioRevision===revision&&(!source!.manualPlanId||source!.manualPlanId===parent!.id)&&(!source!.selectedPlanId||source!.selectedPlanId===parent!.id),'Open the current selected plan before changing profiles.');
  const ordered=(refs:Scenario['planningProfiles'])=>planDigest([...(refs??[])].sort((a,b)=>a.kind.localeCompare(b.kind)));
  need(ordered(intent.profiles)!==ordered(source!.planningProfiles),'Choose different approved profile revisions.');
  const profiles=await new ProfileRepository(this.store,this.tenant).resolve(intent.profiles);
  need((source!.planningProfiles??[]).every(p=>profiles.some(next=>next.kind===p.kind)),'Choose an approved replacement for every pinned profile kind.');
  const old=recordedContext(await this.load(parent!,source!),source!);prepareManualInput(parent!,source!,old);
  const sha=old.day.datasetRequestSha256!;need(profiles.every(p=>p.content.datasetSha256===sha),'Profiles must match the current immutable dataset.');
  const datasets=(await this.store.listDatasets(this.tenant,true)).filter(d=>(!source!.datasetBinding||d.id===source!.datasetBinding.datasetId)&&
   (d.manifest as {artifacts?:{request?:{sha256:string}}}).artifacts?.request?.sha256===sha&&
   (d.manifest as {days?:{dayId:string;isoDate:string}[]}).days?.some(d=>d.dayId===(source!.datasetBinding?.dayId??source!.day)&&d.isoDate===parent!.day));
  need(datasets.length===1,'Exactly one admitted source must match the current plan.');
  const targetScenario={...source!,manualDecisions:undefined,planningProfiles:intent.profiles};
  const target=await this.load(parent!,targetScenario);
  const result=reviewProfileChange(parent!,source!,old,target,intent,{actorId:actor?.userId??'local',at:parent!.createdAt});
  if(await this.pending(this.store.pool,id))result.conflicts.push({code:'downstream_commitment',message:'Cancel or reconcile accepted, in-flight or uncertain handoffs before changing profiles.'});
  const contextKey=(c:ManualDatasetContext)=>({fleet:[...c.vehicleInfo],reload:[...c.reloadSeconds],operating:[...(c.operatingLimits??[])],unavailable:c.unavailableVehicleIds??[],tariff:c.tariff});
  const hash=planDigest({intent,source,parent,dataset:datasets[0],profiles,old:contextKey(old),target:contextKey(target),changes:result.changes,conflicts:result.conflicts,plan:result.plan});
  return {source:source!,parent:parent!,dataset:datasets[0]!,profiles,target,result,hash};
 }
 async preview(id:string,revision:number,body:unknown,actor?:Principal):Promise<ProfileChangePreview>{
  const intent=parseProfileChange(body),x=await this.build(id,revision,intent,actor);
  // A native completion/selection can advance without increasing the revision.
  need(planDigest(await this.store.getScenario(this.tenant,id))===planDigest(x.source),'Workspace changed during profile review.');
  const p=x.result.plan;
  return {previewSha256:x.hash,changes:x.result.changes,conflicts:x.result.conflicts,options:x.result.options,retained:x.result.retained,
   stats:p?{...p.stats,unassignedOrders:p.unassigned.length}:null,cost:p?.cost??null,
   validation:p?{valid:p.provenance.validation.valid,violations:p.provenance.validation.violations as NonNullable<ProfileChangePreview['validation']>['violations']}:null,
   physicalLoadingPending:p?.physicalLoading?.mode==='hard'};
 }
 async apply(id:string,revision:number,body:unknown,digest:unknown,actor?:Principal,confirmed=false):Promise<{scenario:Scenario;plan:Plan}>{
  this.allowed(actor);need(confirmed,'Explicitly confirm creating a new draft.',400);need(typeof digest==='string'&&/^[a-f0-9]{64}$/.test(digest),'A matching profile preview is required.',400);
  const intent=parseProfileChange(body),payload=planDigest({id,revision,intent,digest}),actorId=actor?.userId??'local';
  const receipt=async(client:PoolClient)=>{
   await this.authorize(client,actor);await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`profile-change/${this.tenant}/${intent.operationId}`]);
   const r=await client.query<{detail:{payload:string;actorId:string;planId:string;scenarioId:string;scenario:Scenario}}>("SELECT detail FROM audit_events WHERE tenant_id=$1 AND action='profiles.change' AND detail->>'operationId'=$2",[this.tenant,intent.operationId]);
   if(!r.rows[0])return null;const d=r.rows[0].detail;need(d.payload===payload&&d.actorId===actorId,'Operation key already used for another profile change.');
   const [p,s]=await Promise.all([client.query<{body:Plan}>('SELECT body FROM plans WHERE tenant_id=$1 AND id=$2',[this.tenant,d.planId]),client.query<{body:Scenario}>('SELECT body FROM scenarios WHERE tenant_id=$1 AND id=$2',[this.tenant,d.scenarioId])]);
   need(p.rows[0]&&s.rows[0],'Profile draft receipt is incomplete.');return {scenario:d.scenario,plan:p.rows[0]!.body};
  };
  const replay=await this.store.tx(receipt);if(replay)return replay;
  const x=await this.build(id,revision,intent,actor);need(x.hash===digest,'Settings or workspace changed after preview.');need(!x.result.conflicts.length,'Resolve profile change conflicts before creating a draft.');need(x.result.plan,'A complete evaluation is required.');
  need(x.result.plan!.provenance.validation.valid||intent.acknowledgeInvalid,'Explicitly acknowledge an invalid draft before continuing.');
  const now=new Date().toISOString(),scenarioId=`scn_${randomUUID()}`,planId=`pln_${randomUUID()}`;
  const lineage:ProfileChangeLineage={sourcePlanId:x.parent.id,sourceScenarioId:id,sourceRevision:revision,datasetSha256:x.target.day.datasetRequestSha256!,operationId:intent.operationId,reason:intent.reason,at:now,actorId,
   before:x.source.planningProfiles??[],after:intent.profiles,releasedRequestIds:intent.releaseRequestIds,unlockedVehicleIds:intent.unlockVehicleIds,clearedVehicleOverrideIds:intent.clearVehicleOverrideIds};
  const scenario:Scenario={...x.result.scenario,id:scenarioId,parentId:id,kind:'copy',revision:1,label:`${x.source.label} (profiles)`.slice(0,240),createdAt:now,
   manualPlanId:planId,selectedPlanId:planId,selectionVersion:1,profileChange:lineage};
  // Immutable assignment history keeps its original timestamps. Only newly
  // requested release events receive this authoritative commit timestamp.
  for(const event of scenario.manualDecisions!.history??[])if(event.operationId===intent.operationId)event.at=now;
  const input=x.result.input!;
  for(const event of input.layout.history)if(event.operationId===intent.operationId)event.at=now;
  const plan=materializeManualPlan(x.parent,scenario,input,x.result.evaluation!,x.target,planId,now);
  plan.provenance.planningProfiles=structuredClone(intent.profiles);plan.provenance.profileChange=lineage;
  return this.store.tx(async client=>{
   const again=await receipt(client);if(again)return again;
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`input-day/${this.tenant}/${x.source.day}`]);
   const current=await client.query<{body:Scenario}>('SELECT body FROM scenarios WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[this.tenant,id]);
   need(current.rows[0]&&planDigest(current.rows[0].body)===planDigest(x.source),'Source workspace changed during review.');
   const p=await client.query<{body:Plan}>('SELECT body FROM plans WHERE tenant_id=$1 AND id=$2 FOR SHARE',[this.tenant,x.parent.id]);need(p.rows[0]&&planDigest(p.rows[0].body)===planDigest(x.parent),'Source plan changed during review.');
   const dataset=await client.query('SELECT status,manifest FROM datasets WHERE tenant_id=$1 AND id=$2 FOR SHARE',[this.tenant,x.dataset.id]);need(dataset.rows[0]?.status==='admitted'&&planDigest(dataset.rows[0].manifest)===planDigest(x.dataset.manifest),'Admitted source changed.');
   for(const profile of x.profiles){const row=await client.query('SELECT body,sha256,approved_at FROM planning_profile_revisions WHERE tenant_id=$1 AND profile_id=$2 AND revision=$3 FOR SHARE',[this.tenant,profile.id,profile.revision]);need(row.rows[0]?.approved_at&&row.rows[0].sha256===profile.sha256&&planDigest(row.rows[0].body)===planDigest(profile.content),'Approved profile changed.');}
   need(!await this.pending(client,id,true),'Downstream commitment changed during review.');
   await client.query('INSERT INTO scenarios(tenant_id,id,revision,body) VALUES($1,$2,1,$3)',[this.tenant,scenarioId,scenario]);
   await client.query('INSERT INTO plans(tenant_id,id,scenario_id,scenario_revision,body) VALUES($1,$2,$3,1,$4)',[this.tenant,planId,scenarioId,plan]);
   await client.query("INSERT INTO audit_events(tenant_id,user_id,action,detail) VALUES($1,$2,'profiles.change',$3)",[this.tenant,actor?.userId??null,{payload,actorId,operationId:intent.operationId,planId,scenarioId,scenario,lineage,previewSha256:digest}]);
   return {scenario,plan};
  });
 }
}
