import {createHash} from 'node:crypto';
import {deflateSync,inflateSync} from 'node:zlib';
import type {PoolClient,Pool} from 'pg';
import type {LoadingDocument,PhysicalVehicle,PhysicalUnit,HardLoadingSnapshot,NativeLoadingResult} from './loading-contract.js';
import type {Plan,SurgeRequest,SurgeSolution} from './types.js';
import type {Scenario} from './store.js';

const need=(condition:unknown,message:string):void=>{if(!condition)throw new Error('Physical loading: '+message);};
const integer=(n:unknown)=>Number.isSafeInteger(n)&&Number(n)>=0;
export function canonical(value:unknown):string{
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
 return JSON.stringify(value)??'null';
}
export const digest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
const bytesHash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
export function scenarioDigest(scenario:Scenario){
 const {selectedPlanId,selectionVersion,manualPlanId,label,createdAt,hardLoadingRequired,...safety}=scenario;
 void selectedPlanId;void selectionVersion;void manualPlanId;void label;void createdAt;void hardLoadingRequired;
 return digest(safety);
}
function layout(plan:Plan){return plan.vehicles.map(v=>({vehicleId:v.id,trips:v.trips.map(t=>({tripIndex:t.index,requests:t.stops.map(s=>s.requestId)}))}));}
export const layoutDigest=(plan:Plan)=>digest({routes:layout(plan),unassigned:plan.unassigned.map(s=>s.requestId)});

/** Only immutable declarations supply physical facts; never derive them from pallets or weights. */
export function attachHardLoading(request:SurgeRequest,facts:LoadingDocument,nodeBudget=10000){
 need(integer(nodeBudget)&&nodeBudget>0&&nodeBudget<=100000,'invalid search budget');
 const vehicles=new Map(facts.vehicles.map(v=>[v.vehicleId,v])),orders=new Map(facts.requests.map(r=>[r.requestId,r]));
 request.loading={version:1,mode:'hard',node_budget:nodeBudget,
  vehicles:request.vehicles.map(v=>{const f=vehicles.get(v.id);need(f,'missing vehicle facts');return {vehicle_id:v.id,access_model:f!.access,slots:f!.slots,max_layers:f!.maxLayers,clearance_mm:f!.clearanceMm,max_stack_weight_g:f!.maxStackWeightG,payload_g:f!.payloadG,allowed_top:f!.allowedTop};}),
  requests:request.requests.map(r=>{const f=orders.get(r.id);need(f,'missing request facts');return {request_id:r.id,units:f!.units.map(u=>({height_mm:u.heightMm,weight_g:u.weightG,stack_class:u.stackClass,max_weight_above_g:u.maxWeightAboveG,max_units_above:u.maxUnitsAbove}))};})};
}

/** Witness replay only: no packing/search or native subprocess at the write boundary. */
function replay(vehicle:PhysicalVehicle,units:(PhysicalUnit&{stop:number})[],placements:{slot:number;layer:number}[]){
 need(units.length<=128&&units.length===placements.length,'unit inventory mismatch');
 need(new Set(placements.map(p=>p.slot+':'+p.layer)).size===placements.length,'duplicate placement');
 need(placements.every(p=>integer(p.slot)&&p.slot<vehicle.slotCount&&integer(p.layer)&&p.layer<vehicle.maxLayers),'placement outside vehicle');
 need(units.reduce((n,u)=>n+u.weightG,0)<=vehicle.payloadG,'vehicle payload exceeded');
 for(let slot=0;slot<vehicle.slotCount;slot++){
  const members=placements.map((p,i)=>({...p,u:units[i]!})).filter(p=>p.slot===slot).sort((a,b)=>a.layer-b.layer);
  need(members.every((p,i)=>p.layer===i),'unsupported floating layer');
  need(members.reduce((n,p)=>n+p.u.heightMm,0)<=vehicle.clearanceMm,'height clearance exceeded');
  need(members.reduce((n,p)=>n+p.u.weightG,0)<=vehicle.maxStackWeightG,'stack weight exceeded');
 }
 for(let i=0;i<units.length;i++){
  const u=units[i]!,p=placements[i]!,above=units.filter((_,j)=>placements[j]!.slot===p.slot&&placements[j]!.layer>p.layer);
  need(above.length<=u.maxUnitsAbove&&above.reduce((n,o)=>n+o.weightG,0)<=u.maxWeightAboveG,'support strength/count exceeded');
  for(let j=0;j<units.length;j++){
   const other=units[j]!,op=placements[j]!;
   if(op.slot===p.slot&&op.layer===p.layer+1)need(vehicle.allowedTop[u.stackClass]?.includes(other.stackClass),'support class prohibited');
   if(vehicle.access==='rear_lifo'){
    if(op.slot===p.slot&&op.layer>p.layer)need(other.stop<=u.stop,'unloading blocked by upper unit');
    const near=vehicle.slots[p.slot]!,far=vehicle.slots[op.slot]!;
    if(near.lane===far.lane&&near.depth<far.depth)need(u.stop<=other.stop,'unloading blocked by nearer slot');
   }
  }
 }
}
function verify(plan:Plan,evidence:HardLoadingSnapshot,scenario?:Scenario){
 const certificate=evidence.certificate;need(evidence.status==='feasible'&&certificate?.version===1,'Replan required: loading evidence is missing or stale');
 const c=certificate!;const {sha256,...signed}=c;
 need(digest(signed)===sha256,'certificate checksum mismatch');
 need(c.planId===plan.id&&c.scenarioId===plan.scenarioId&&c.scenarioRevision===plan.scenarioRevision,'certificate scenario identity mismatch');
 need(!scenario||(scenario.id===plan.scenarioId&&scenario.revision===plan.scenarioRevision&&scenarioDigest(scenario)===c.scenarioSha256),'scenario edits invalidate loading evidence');
 need(layoutDigest(plan)===c.layoutSha256,'route edits invalidate loading evidence');
 need([c.requestSha256,c.solverSha256,c.scenarioSha256,evidence.sourceSha256,evidence.datasetSha256].every(h=>/^[a-f0-9]{64}$/.test(h)),'missing executable/input identity');
 need(evidence.datasetSha256===plan.provenance.datasetSha256,'dataset identity mismatch');
 const bytes=inflateSync(Buffer.from(c.facts,'base64'),{maxOutputLength:64*1024*1024});
 need(bytesHash(bytes)===evidence.sourceSha256,'source facts checksum mismatch');
 const facts=JSON.parse(bytes.toString()) as LoadingDocument;
 need(facts.schemaVersion===1&&facts.datasetSha256===evidence.datasetSha256,'source dataset binding mismatch');
 need(new Set(c.requestIds).size===c.requestIds.length&&c.requestIds.every(integer)&&new Set(c.vehicleIds).size===c.vehicleIds.length&&c.vehicleIds.every(integer),'invalid scoped inventory');
 const result=c.result;need(result?.version===1&&result.mode==='hard'&&integer(result.node_budget)&&result.node_budget>0&&result.node_budget<=100000,'invalid native certificate');
 const expected=plan.vehicles.flatMap(v=>v.trips.map(t=>({v,t}))),remaining=new Map(expected.map(r=>[r.v.id+':'+r.t.index,r]));
 need(remaining.size===expected.length&&result.rounds.length===expected.length,'missing or duplicate round certificate');
 const inventory=new Map(facts.requests.map(r=>[r.requestId,r.units])),seen=new Set<number>();
 for(const r of result.rounds){
  need(c.vehicleIds.includes(r.vehicle_id)&&r.placements.every(p=>[p.request_id,p.unit_index,p.slot,p.layer].every(integer)),'invalid native placement identity');
  need(integer(r.nodes)&&r.nodes<=result.node_budget,'invalid search node count');
  need(r.outcome==='feasible'&&r.reason==='witness','UNKNOWN or infeasible round cannot be published');
  const key=r.vehicle_id+':'+r.trip_index,round=remaining.get(key);need(round,'unknown or duplicate round');remaining.delete(key);
  const geometry=facts.vehicles.find(v=>v.vehicleId===r.vehicle_id);need(geometry,'missing vehicle geometry');
  const ids:string[]=[],units:(PhysicalUnit&{stop:number})[]=[];
  round!.t.stops.forEach((stop,ordinal)=>{
   need(stop.requestId!==undefined&&!seen.has(stop.requestId),'duplicate or unknown served request');seen.add(stop.requestId!);
   const declared=inventory.get(stop.requestId!);need(declared,'missing physical units');
   declared!.forEach((u,i)=>{ids.push(stop.requestId+':'+i);units.push({...u,stop:ordinal});});
  });
  const supplied=new Map(r.placements.map(p=>[p.request_id+':'+p.unit_index,p]));
  need(supplied.size===r.placements.length&&supplied.size===ids.length&&ids.every(id=>supplied.has(id)),'missing/duplicate/foreign unit witness');
  replay(geometry!,units,ids.map(id=>supplied.get(id)!));
 }
 const unassigned=new Set(plan.unassigned.map(r=>r.requestId));
 need(seen.size+unassigned.size===c.requestIds.length&&c.requestIds.every(id=>seen.has(id)||unassigned.has(id)),'incomplete scoped request coverage');
 need(!unassigned.has(undefined)&&unassigned.size===plan.unassigned.length,'unassigned identities missing or duplicated');
 need([...unassigned].every(id=>inventory.has(id!)&&!seen.has(id!)),'served/unassigned overlap or foreign request');
 need(result.unassigned_checks.length===unassigned.size,'missing unassigned loading diagnostics');
 for(const d of result.unassigned_checks){
  need(unassigned.has(d.request_id),'duplicate or unknown unassigned diagnostic');unassigned.delete(d.request_id);
  need(d.scope==='loading_alone_not_route_insertability'&&[d.feasible_vehicles,d.infeasible_vehicles,d.unknown_vehicles].every(integer),'invalid unassigned diagnostics');
  need(d.feasible_vehicles+d.infeasible_vehicles+d.unknown_vehicles===c.vehicleIds.length,'incomplete vehicle diagnostics');
  need(d.unknown_vehicles===0,'native loading is UNKNOWN; no plan published. Recheck facts/search budget');
 }
 need(evidence.rounds.length===expected.length&&expected.every(({v,t})=>evidence.rounds.some(r=>r.vehicleId===v.id&&r.tripIndex===t.index&&r.status==='feasible'&&r.unitCount===t.stops.reduce((n,s)=>n+(inventory.get(s.requestId!)?.length??0),0))),'round summary mismatch');
}
export function certifyLoading(plan:Plan,scenario:Scenario,document:LoadingDocument,sourceSha256:string,requestSha256:string,solverSha256:string,result:NativeLoadingResult|undefined,request:SurgeRequest):HardLoadingSnapshot{
 need(result,'native certificate missing');
 need(result!.node_budget===request.loading?.node_budget,'native search budget identity mismatch');
 const facts=Buffer.from(JSON.stringify(document));need(bytesHash(facts)===sourceSha256,'immutable facts identity mismatch');
 const counts=new Map(document.requests.map(r=>[r.requestId,r.units.length]));
 const body={version:1 as const,planId:plan.id,scenarioId:scenario.id,scenarioRevision:scenario.revision,scenarioSha256:scenarioDigest(scenario),layoutSha256:layoutDigest(plan),requestSha256,solverSha256,requestIds:request.requests.map(r=>r.id),vehicleIds:request.vehicles.map(v=>v.id),facts:deflateSync(facts).toString('base64'),result:result!};
 const evidence:HardLoadingSnapshot={sourceSha256,datasetSha256:document.datasetSha256,mode:'hard',status:'feasible',
  rounds:plan.vehicles.flatMap(v=>v.trips.map(t=>({vehicleId:v.id,tripIndex:t.index,unitCount:t.stops.reduce((n,s)=>n+(counts.get(s.requestId!)??0),0),status:'feasible' as const}))),certificate:{...body,sha256:digest(body)}};
 verify(plan,evidence,scenario);return evidence;
}
export function loadingBlockers(plan:Plan,scenario?:Scenario,source?:string):string[]{
 try{
  const evidence=plan.physicalLoading;
  if(source||scenario?.hardLoadingRequired)need(evidence?.mode==='hard'&&(!source||evidence.sourceSha256===source),'hard loading required by admitted facts; Replan before approval/export');
  if(evidence?.mode==='hard')verify(plan,evidence,scenario);
  return [];
 }catch(error){const message=(error as Error).message;return [message.startsWith('Physical loading:')?message:'Physical loading: invalid certificate; Replan required.'];}
}
/** SQL-only policy lookup. Source facts remain immutable; no object/network I/O under row locks. */
export async function loadingSource(db:Pick<Pool|PoolClient,'query'>,tenant:string,scenario:Scenario,sha?:string):Promise<string|undefined>{
 const rows=await db.query<{id:string;manifest:{days?:{dayId:string}[];artifacts?:{request?:{sha256:string};physicalLoading?:{sha256:string}}}}>("SELECT id,manifest FROM datasets WHERE tenant_id=$1 AND status='admitted'",[tenant]);
 const matches=rows.rows.filter(r=>(!scenario.datasetBinding||r.id===scenario.datasetBinding.datasetId)&&r.manifest.days?.some(d=>d.dayId===(scenario.datasetBinding?.dayId??scenario.day))&&(!sha||r.manifest.artifacts?.request?.sha256===sha));
 const sources=matches.map(r=>r.manifest.artifacts?.physicalLoading?.sha256);
 need(matches.length<=1||!sources.some(Boolean),'ambiguous admitted loading sources');
 return sources[0];
}

/** Published hard evidence latches its immutable source; changing an env flag
 * cannot silently relax that source on another branch or replica. */
export async function loadingRequired(db:Pick<Pool|PoolClient,'query'>,tenant:string,scenario:Scenario,source:string|undefined,enabled:boolean):Promise<boolean>{
 if(scenario.hardLoadingRequired||enabled&&source)return true;
 if(!source)return false;
 const found=await db.query("SELECT 1 FROM plans WHERE tenant_id=$1 AND body->'physicalLoading'->>'mode'='hard' AND body->'physicalLoading'->>'sourceSha256'=$2 LIMIT 1",[tenant,source]);
 return found.rows.length>0;
}
