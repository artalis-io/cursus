import {isDeepStrictEqual} from 'node:util';
import type {Plan} from '../types.js';
import type {Scenario} from '../store.js';
import type {LoadedDay} from '../data/dataset.js';
import type {InputUpdateDiff,InputUpdateIntent,UpdateDelivery} from '../input-update-contract.js';
import {prepareManualInput,evaluateManualInput,materializeManualPlan,type ManualDatasetContext} from './manual-adapter.js';
import {mapSolutionToPlan} from './mapper.js';
import {tariffIdentity} from '../cost.js';

export function updateRows(day:LoadedDay):UpdateDelivery[]{
 const tasks=new Map(day.request.tasks.map(t=>[t.id,t]));
 return day.request.requests.map(r=>{const t=tasks.get(r.delivery_task_id)!,i=day.deliveryEnrichment?.get(r.id)??day.enrichment.get(t.ref);
  if(!i)throw new Error('Delivery source facts are unavailable');
  return {id:r.id,reference:t.ref,customer:i.customer??'',address:[i.zip,i.city,i.street].filter(Boolean).join(', '),weightKg:t.demand[0]!,pallets:t.demand[1]!};});
}
function facts(day:LoadedDay,id:number){
 const r=day.request.requests.find(r=>r.id===id)!,t=day.request.tasks.find(t=>t.id===r.delivery_task_id)!;
 const i=day.deliveryEnrichment?.get(id)??day.enrichment.get(t.ref)!;
 const d=day.shipmentDocument?.deliveries.find(d=>d.requestId===id),shipment=day.shipmentDocument?.shipments.find(s=>s.id===d?.shipmentId);
 return {reference:t.ref,location:{coordinates:day.request.locations[t.location_id],customer:i.customer,city:i.city,street:i.street,zip:i.zip},
  weight:t.demand[0],pallets:t.demand[1],window:[t.tw_early,t.tw_late],service:t.service_seconds,
  access:[i.maxTonnage,i.requiresTailLift],restrictions:[r.allowed_vehicles??[],r.forbidden_vehicles??[]],
  commercial:d?{detail:d.detail,weightBasis:d.weightBasis,allocations:d.allocations,loadUnits:d.loadUnits,shipment:shipment?{reference:shipment.reference,splitPolicy:shipment.splitPolicy,lines:shipment.lines}:null}:null};
}

/** Pure reconciliation. IDs only cross a snapshot boundary through reviewed
 * one-to-one pairs, never by label or row position. No source is modified. */
export function reconcileInputs(source:Plan,oldScenario:Scenario,old:ManualDatasetContext,target:ManualDatasetContext,
 scenario:Scenario,intent:InputUpdateIntent){
 const before=prepareManualInput(source,oldScenario,old),oldRows=updateRows(old.day),newRows=updateRows(target.day);
 const oldIds=new Set(oldRows.map(r=>r.id)),newIds=new Set(newRows.map(r=>r.id)),map=new Map<number,number>(),used=new Set<number>();
 for(const pair of intent.matches){
  if(!oldIds.has(pair.from)||!newIds.has(pair.to)||map.has(pair.from)||used.has(pair.to))throw new Error('Unknown or duplicate delivery correspondence');
  map.set(pair.from,pair.to);used.add(pair.to);
 }
 const released=new Set(intent.releaseRequestIds),unlocked=new Set(intent.unlockVehicleIds);
 if(released.size!==intent.releaseRequestIds.length||[...released].some(id=>!oldIds.has(id))||unlocked.size!==intent.unlockVehicleIds.length||
  [...unlocked].some(id=>!before.layout.lockedVehicleIds.includes(id)))throw new Error('Unknown or duplicate decision/lock resolution');
 const diff:InputUpdateDiff={added:newRows.filter(r=>!used.has(r.id)),cancelled:oldRows.filter(r=>!map.has(r.id)),changed:[],unchanged:0,
  affectedVehicles:[],matrixChanged:!isDeepStrictEqual(old.day.request.travel,target.day.request.travel),conflicts:[],retainedDecisions:0};
 const changedIds=new Set<number>();
 for(const [from,to] of map){const a=facts(old.day,from),b=facts(target.day,to),fields=Object.keys(a).filter(k=>!isDeepStrictEqual(a[k as keyof typeof a],b[k as keyof typeof b]));
  if(fields.length){diff.changed.push({before:oldRows.find(r=>r.id===from)!,after:newRows.find(r=>r.id===to)!,fields});changedIds.add(from);}else diff.unchanged++;
 }
 const translate=(id:number)=>map.get(id);
 const resolveRef=(ref:string,id?:number)=>{
  const ids=id===undefined?oldRows.filter(r=>r.reference===ref).map(r=>r.id):[id];
  if(ids.length!==1)throw new Error('Legacy restrictions need unambiguous delivery IDs before input update');
  return ids[0]!;
 };
 const obligation=new Set<number>(Object.keys(before.layout.decisions).map(Number));
 for(const rule of [...oldScenario.pins,...oldScenario.forbids])obligation.add(resolveRef(rule.orderNo,rule.requestId));
 for(const id of obligation)if(!map.has(id)&&!released.has(id))diff.conflicts.push({code:'cancelled_decision',requestId:id,message:'Explicitly release the cancelled delivery decision.'});
 for(const route of before.layout.routes){
  if(diff.matrixChanged||route.requestIds.some(id=>changedIds.has(id)||!map.has(id)))diff.affectedVehicles.push(route.vehicleId);
  if(before.layout.lockedVehicleIds.includes(route.vehicleId)&&!unlocked.has(route.vehicleId)&&route.requestIds.some(id=>!map.has(id)||changedIds.has(id)))
   diff.conflicts.push({code:'changed_lock',vehicleId:route.vehicleId,message:'A locked route contains a changed or cancelled delivery. Explicitly unlock it or stop the update.'});
 }
 diff.affectedVehicles=[...new Set(diff.affectedVehicles)];
 const rules=<T extends {orderNo:string;requestId?:number}>(values:T[])=>values.flatMap(rule=>{
  const oldId=resolveRef(rule.orderNo,rule.requestId),id=translate(oldId);if(id===undefined||released.has(oldId))return [];
  return [{...rule,requestId:id,orderNo:newRows.find(r=>r.id===id)!.reference}];});
 scenario.pins=rules(oldScenario.pins);scenario.forbids=rules(oldScenario.forbids);
 scenario.sequences=oldScenario.sequences.flatMap(sequence=>{
  if(unlocked.has(sequence.vehicleId))return []; // explicit release, recorded with its reason
  const ids=sequence.requestIds??sequence.orderNos.map(ref=>resolveRef(ref));
  const surviving=ids.filter(id=>map.has(id)).map(id=>map.get(id)!);
  return surviving.length?[{...sequence,requestIds:surviving,orderNos:surviving.map(id=>newRows.find(r=>r.id===id)!.reference)}]:[];
 });
 scenario.removedVehicleIds=[...oldScenario.removedVehicleIds];scenario.vehicleOverrides=structuredClone(oldScenario.vehicleOverrides);
 const decisions=Object.fromEntries(Object.entries(before.layout.decisions).flatMap(([id,d])=>map.has(Number(id))&&!released.has(Number(id))?[[String(map.get(Number(id))),structuredClone(d)]]:[]));
 const origins=Object.fromEntries(newRows.map(row=>{const prior=[...map].find(([,id])=>id===row.id)?.[0];return [String(row.id),prior===undefined?'import':before.layout.origins[String(prior)]??'historical'];}));
 diff.retainedDecisions=Object.keys(decisions).length;
 // Source history remains immutable on its source plan. Namespace transitions
 // are recorded by lineage, not by rewriting old events onto new numeric IDs.
 scenario.manualDecisions={datasetSha256:target.day.datasetRequestSha256!,decisions,requestIds:newRows.map(r=>r.id),
  tariff:structuredClone(target.tariff),tariffSha256:tariffIdentity(target.tariff),fleetInfo:structuredClone([...target.vehicleInfo]),reloadSeconds:[...target.reloadSeconds],
  unavailableVehicleIds:[...(target.unavailableVehicleIds??[])],origins,history:[]};
 const scaffold=mapSolutionToPlan({day:target.day,request:target.day.request,solution:target.day.solution,enrichment:target.day.enrichment,vehicleInfo:target.vehicleInfo,
  tariff:target.tariff,scenarioId:scenario.id,scenarioRevision:scenario.revision,planId:'input-update-preview',createdAt:source.createdAt,source:'live'});
 scaffold.vehicles=source.vehicles.flatMap(v=>{const trips=v.trips.flatMap(tr=>{
  const stops=tr.stops.filter(s=>map.has(s.requestId!)).map(s=>({...s,requestId:map.get(s.requestId!)!,orderNo:newRows.find(r=>r.id===map.get(s.requestId!))!.reference}));
  return stops.length?[{...tr,stops}]:[];});return trips.length?[{...v,trips}]:[];});
 const served=new Set(scaffold.vehicles.flatMap(v=>v.trips.flatMap(t=>t.stops.map(s=>s.requestId))));
 scaffold.unassigned=scaffold.unassigned.filter(r=>!served.has(r.requestId));
 const input=prepareManualInput(scaffold,{...scenario,manualDecisions:undefined},target);
 input.layout.decisions=decisions;input.layout.origins=origins;
 const evaluation=evaluateManualInput(input,input.layout,scenario);
 for(const v of evaluation.validation.violations)if(input.layout.lockedVehicleIds.includes(v.vehicleId))
  diff.conflicts.push({code:'locked_infeasible',vehicleId:v.vehicleId,message:'The replacement input invalidates a locked route; reconcile its facts or explicitly unlock it.'});
 const plan=materializeManualPlan(scaffold,scenario,input,evaluation,target,scaffold.id,source.createdAt);
 plan.manual!.parentPlanId=source.id; // No parentScenario: Undo must not cross datasets.
 return {diff,scenario,plan};
}
