import {isDeepStrictEqual} from 'node:util';
import {prepareManualInput,evaluateManualInput,materializeManualPlan,type ManualDatasetContext} from './manual-adapter.js';
import {applyManualBatch} from './manual.js';
import {applyVehicleOverrides} from '../solve.js';
import {applyFleetSettings} from '../state/manual-settings.js';
import {tariffIdentity} from '../cost.js';
import type {ProfileChangeIntent,ProfileSettingChange,ProfileChangeConflict} from '../profile-change-contract.js';
import type {Plan} from '../types.js';
import type {Scenario} from '../store.js';

/** Same admitted dataset only. All temporary policy substitutions are confined to
 * trusted clones; source evidence is verified before evaluating target settings. */
export function reviewProfileChange(source:Plan,original:Scenario,old:ManualDatasetContext,target:ManualDatasetContext,
 intent:ProfileChangeIntent,actor:{actorId:string;at:string}){
 const before=prepareManualInput(source,original,old),sha=before.datasetSha256;
 if(target.day.datasetRequestSha256!==sha||target.day.def.id!==original.day)throw new Error('Profiles must use the current immutable dataset and day');
 const rows=before.request.requests.map(r=>({id:r.id,ref:before.request.tasks.find(t=>t.id===r.delivery_task_id)!.ref}));
 const resolve=(rule:{orderNo:string;requestId?:number})=>{
  const matches=rows.filter(r=>rule.requestId===undefined?r.ref===rule.orderNo:r.id===rule.requestId&&r.ref===rule.orderNo);
  if(matches.length!==1)throw new Error('Resolve ambiguous legacy restrictions before changing profiles');return matches[0]!.id;
 };
 const obligations=new Set([...Object.keys(before.layout.decisions).map(Number),...original.pins.map(resolve),...original.forbids.map(resolve)]);
 const released=new Set(intent.releaseRequestIds),unlocked=new Set(intent.unlockVehicleIds),cleared=new Set(intent.clearVehicleOverrideIds);
 if([...released].some(id=>!obligations.has(id))||[...unlocked].some(id=>!original.sequences.some(s=>s.vehicleId===id))||[...cleared].some(id=>!original.vehicleOverrides.some(v=>v.vehicleId===id)))throw new Error('Unknown decision, route or override resolution');
 const scenario:Scenario={...structuredClone(original),...(source.physicalLoading?.mode==='hard'?{hardLoadingRequired:true}:{}),planningProfiles:structuredClone(intent.profiles),
  vehicleOverrides:original.vehicleOverrides.filter(v=>!cleared.has(v.vehicleId)),sequences:original.sequences.filter(s=>!unlocked.has(s.vehicleId)),
  pins:original.pins.filter(r=>!released.has(resolve(r))),forbids:original.forbids.filter(r=>!released.has(resolve(r)))};
 delete scenario.manualDecisions;
 const sourceParent={...source,provenance:{...source.provenance,planningProfiles:structuredClone(intent.profiles)}};
 const changes:ProfileSettingChange[]=[],conflicts:ProfileChangeConflict[]=[];
 const compare=(kind:ProfileSettingChange['kind'],id:number|string,label:string,a:Record<string,unknown>,b:Record<string,unknown>)=>{
  for(const field of new Set([...Object.keys(a),...Object.keys(b)]))if(!isDeepStrictEqual(a[field],b[field]))changes.push({kind,id,label,field,before:a[field]??null,after:b[field]??null});
 };
 const fleetFacts=(ctx:ManualDatasetContext)=>ctx.day.request.vehicles.map(v=>{
  const info=ctx.vehicleInfo.get(v.ref.replace(/[^a-z0-9]/gi,'').toUpperCase());
  return {id:v.id,ref:v.ref,capacityKg:v.capacity[0],capacityPallets:v.capacity[1],grossWeightTonnes:info?.tonnage,tailLift:info?.hasTailLift,
   available:!ctx.unavailableVehicleIds?.includes(v.id),reloadSeconds:ctx.reloadSeconds.get(v.id),vehicleClass:info?.vehicleClass,subcontractor:info?.isSubcontractor,
   operatingLimits:ctx.operatingLimits?.get(v.id)??null,shiftStartSeconds:v.shift_early,shiftEndSeconds:v.shift_late,maxTrips:v.max_trips,maxDistanceKm:v.max_distance===undefined?undefined:v.max_distance/1000,maxDurationSeconds:v.max_duration};
 });
 const a=fleetFacts(old),b=fleetFacts(target);
 if(a.length!==b.length||a.some(v=>!b.some(w=>w.id===v.id&&w.ref===v.ref)))throw new Error('Verified fleet identity changed');
 for(const v of a)compare('fleet',v.id,v.ref,v,b.find(w=>w.id===v.id)!);
 const locations=(ctx:ManualDatasetContext)=>new Map(ctx.day.request.tasks.filter(t=>ctx.day.scopeTaskIds.has(t.id)).map(t=>{
  const order=ctx.day.request.requests.find(r=>r.delivery_task_id===t.id),info=order&&(ctx.day.deliveryEnrichment?.get(order.id)??ctx.day.enrichment.get(t.ref));
  return [t.id,{locationId:t.location_id,reference:t.ref,openingSeconds:t.tw_early,deadlineSeconds:t.tw_late,serviceSeconds:t.service_seconds,maxGrossWeightTonnes:info?.maxTonnage,tailLiftRequired:info?.requiresTailLift}] as const;
 }));
 const left=locations(old),right=locations(target);
 if(left.size!==right.size||[...left.keys()].some(id=>!right.has(id)))throw new Error('Delivery inventory changed');
 for(const [id,v] of left)compare('location',id,v.reference,v,right.get(id)!);
 compare('tariff','tariff','Rate card',old.tariff as unknown as Record<string,unknown>,target.tariff as unknown as Record<string,unknown>);
 const probe={...target.day.request,vehicles:structuredClone(target.day.request.vehicles)};
 if(!applyFleetSettings(probe,sha,target))throw new Error('Target fleet policy mismatch');
 for(const o of scenario.vehicleOverrides){
  try{if(!probe.vehicles.some(v=>v.id===o.vehicleId))throw new Error('Unknown override vehicle');applyVehicleOverrides({...probe,vehicles:structuredClone(probe.vehicles)},{...scenario,vehicleOverrides:[o]});}
  catch{conflicts.push({code:'override',vehicleId:o.vehicleId,message:'This scenario override exceeds the replacement profile. Explicitly clear it or choose another profile.'});}
 }
 const options={decisions:[...obligations].map(id=>({requestId:id,label:rows.find(r=>r.id===id)!.ref})),
  routes:original.sequences.map(s=>({vehicleId:s.vehicleId,label:a.find(v=>v.id===s.vehicleId)?.ref??String(s.vehicleId),locked:!!s.locked})),
  overrides:original.vehicleOverrides.map(v=>({vehicleId:v.vehicleId,label:a.find(w=>w.id===v.vehicleId)?.ref??String(v.vehicleId)}))};
 const retained={assignments:before.layout.routes.reduce((n,r)=>n+r.requestIds.length,0),decisions:[...obligations].filter(id=>!released.has(id)).length,
  routeOrders:scenario.sequences.length,lockedVehicles:scenario.sequences.filter(s=>s.locked).length,overrides:scenario.vehicleOverrides.length};
 if(conflicts.length)return {changes,conflicts,options,retained,scenario,plan:null};
 const input=prepareManualInput(sourceParent,scenario,target),originalLayout=structuredClone(input.layout);
 if(released.size)input.layout=applyManualBatch(input.layout,{operationId:intent.operationId,datasetSha256:sha,commands:[...released].map(requestId=>({op:'release',requestId}))},actor);
 const evaluation=evaluateManualInput(input,originalLayout,scenario);
 for(const v of evaluation.validation.violations){
  if(input.layout.lockedVehicleIds.includes(v.vehicleId)&&!conflicts.some(c=>c.code==='locked_route'&&c.vehicleId===v.vehicleId))conflicts.push({code:'locked_route',vehicleId:v.vehicleId,message:'New settings invalidate a locked route. Explicitly release its order/lock or stop the change.'});
  const ids=v.requestId===undefined?input.layout.routes.filter(r=>r.vehicleId===v.vehicleId).flatMap(r=>r.requestIds):[v.requestId];
  for(const id of ids)if(obligations.has(id)&&!released.has(id)&&!conflicts.some(c=>c.code==='retained_decision'&&c.requestId===id))
   conflicts.push({code:'retained_decision',requestId:id,vehicleId:v.vehicleId,message:'A retained decision is affected by the new constraint. Explicitly release it for Replan or choose different settings.'});
 }
 scenario.manualDecisions={datasetSha256:sha,decisions:structuredClone(input.layout.decisions),requestIds:[...input.layout.requestIds],origins:structuredClone(input.layout.origins),history:structuredClone(input.layout.history),
  tariff:structuredClone(target.tariff),tariffSha256:tariffIdentity(target.tariff),fleetInfo:structuredClone([...target.vehicleInfo]),reloadSeconds:[...target.reloadSeconds],operatingLimits:[...(target.operatingLimits??[])],unavailableVehicleIds:[...(target.unavailableVehicleIds??[])]};
 const plan=materializeManualPlan(sourceParent,scenario,input,evaluation,target,'profile-change-preview',source.createdAt);
 return {changes,conflicts,options,retained,scenario,plan,input,evaluation};
}
