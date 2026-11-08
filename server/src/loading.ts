import {config} from './config.js';
import type {SurgeRequest} from './types.js';
import type {LoadingDocument} from './loading-contract.js';
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
function need(v:unknown,message:string):asserts v{if(!v)throw new Error(`Physical loading: ${message}`);}
const number=(v:unknown,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&Number(v)>=0&&Number(v)<=max;
const keys=(o:Record<string,unknown>,allowed:string[])=>Object.keys(o).every(k=>allowed.includes(k))&&allowed.every(k=>k in o);
/** Complete, checksum-bound declarations only. No geometry is inferred from
 * summary quantities, net weights, stackability flags or commercial lines. */
export function validateLoading(value:unknown,request:SurgeRequest,sha:string):LoadingDocument{
 need(object(value)&&keys(value,['schemaVersion','datasetSha256','mode','vehicles','requests'])&&value.schemaVersion===1&&value.mode==='disabled'&&value.datasetSha256===sha&&/^[a-f0-9]{64}$/.test(sha),'disabled, dataset-bound schemaVersion=1 required');
 need(Array.isArray(value.vehicles)&&value.vehicles.length===request.vehicles.length&&Array.isArray(value.requests)&&value.requests.length===request.requests.length,'complete vehicle and request inventories required');
 const vehicles=new Set(request.vehicles.map(v=>v.id)),requests=new Map(request.requests.map(r=>[r.id,r]));let total=0,classCount=64;
 need(!request.vehicles.some(v=>('open_start' in v&&v.open_start!==false)||'initial_load' in v),'open starts and initial cargo are unsupported');
 for(const raw of value.vehicles){
  need(object(raw)&&keys(raw,['vehicleId','slotCount','maxLayers','clearanceMm','maxStackWeightG','payloadG','access','allowedTop','slots'])&&number(raw.vehicleId)&&vehicles.delete(Number(raw.vehicleId)),'duplicate or unknown vehicle');
  need(number(raw.slotCount,128)&&Number(raw.slotCount)>0&&number(raw.maxLayers,8)&&Number(raw.maxLayers)>0&&number(raw.clearanceMm,4294967295)&&Number(raw.clearanceMm)>0&&number(raw.maxStackWeightG)&&number(raw.payloadG),'invalid geometry or weight');
  need(raw.access==='side_free'||raw.access==='rear_lifo','unsupported access mode');
  const support=raw.allowedTop;
  need(Array.isArray(support)&&support.length>0&&support.length<=64&&support.every(row=>Array.isArray(row)&&new Set(row).size===row.length&&row.every(c=>number(c,support.length-1))),'explicit directed support classes required');
  classCount=Math.min(classCount,support.length);
  need(Array.isArray(raw.slots)&&raw.slots.length===raw.slotCount&&raw.slots.every(s=>object(s)&&keys(s,['lane','depth'])&&number(s.lane,65535)&&number(s.depth,65535))&&new Set(raw.slots.map(s=>`${s.lane}:${s.depth}`)).size===raw.slots.length,'unique lane/depth per slot required');
 }

 for(const raw of value.requests){
  need(object(raw)&&keys(raw,['requestId','units'])&&number(raw.requestId)&&requests.has(Number(raw.requestId)),'duplicate or unknown request');
  const source=requests.get(Number(raw.requestId))!;requests.delete(Number(raw.requestId));
  need((source as unknown as Record<string,unknown>).pickup_task_id===undefined||(source as unknown as Record<string,unknown>).pickup_task_id===null,'delivery-only loading supported');
  need(Array.isArray(raw.units)&&raw.units.length<=128,'explicit units required');total+=raw.units.length;need(total<=100000,'unit inventory exceeds import limit');
  const ids=new Set<string>();
  for(const u of raw.units){
   need(object(u)&&keys(u,['id','heightMm','weightG','stackClass','maxWeightAboveG','maxUnitsAbove'])&&typeof u.id==='string'&&u.id.trim().length>0&&u.id.length<=128&&!/[\u0000-\u001f]/.test(u.id)&&!ids.has(u.id),'unique physical unit identities required');ids.add(u.id);
   need(number(u.heightMm,4294967295)&&Number(u.heightMm)>0&&number(u.weightG)&&number(u.stackClass,classCount-1)&&number(u.maxWeightAboveG)&&number(u.maxUnitsAbove,128),'invalid physical unit');
  }
 }
 return structuredClone(value) as unknown as LoadingDocument;
}

export function loadingSnapshot(document:LoadingDocument,sourceSha256:string,vehicles:import('./types.js').PlanVehicle[],required=config.hardLoadingEnabled):import('./loading-contract.js').PhysicalLoadingEvidence{
 const counts=new Map(document.requests.map(r=>[r.requestId,r.units.length]));
 return {sourceSha256,datasetSha256:document.datasetSha256,...(required?{mode:'hard' as const,status:'stale' as const}:{mode:'disabled' as const,status:'not_evaluated' as const}),rounds:vehicles.flatMap(v=>v.trips.map(t=>({vehicleId:v.id,tripIndex:t.index,unitCount:t.stops.reduce((n,s)=>n+(s.requestId===undefined?0:counts.get(s.requestId)??0),0),status:'not_evaluated' as const})))};
}
