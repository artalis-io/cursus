import {createHash} from 'node:crypto';
import type {SurgeRequest} from '../types.js';
import {summarizeShipments,validateShipments} from '../shipments.js';

const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const integer=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0&&Number(v)<=2147483647;
const finite=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
function need(v:unknown,message:string):asserts v{if(!v)throw new Error(`Prepared dataset: ${message}`);}

/** Additive prepared-JSON path. Matrix construction stays with OTTO; this
 * validates supplied solver-ready bytes, rather than constructing a matrix. */
export function preparedBundle(value:unknown){
 need(record(value)&&value.schemaVersion===1&&record(value.surgeRequest)&&Array.isArray(value.days)&&value.days.length>0&&Array.isArray(value.geocoded),'days, request and identity-bearing geocoded rows are required');
 const r=value.surgeRequest;
 need(record(r.config)&&r.dimension_count===2&&r.demand_sign_convention===1&&Array.isArray(r.locations)&&r.locations.length>0&&
  Array.isArray(r.depots)&&r.depots.length===1&&record(r.depots[0])&&r.depots[0].location_id===0&&
  Array.isArray(r.vehicles)&&r.vehicles.length>0&&Array.isArray(r.tasks)&&Array.isArray(r.requests)&&r.requests.length>0&&record(r.travel),
  'only two-dimensional, single-depot delivery requests are currently supported');
 for(const loc of r.locations)need(record(loc)&&typeof loc.x==='number'&&Number.isFinite(loc.x)&&Math.abs(loc.x)<=180&&typeof loc.y==='number'&&Number.isFinite(loc.y)&&Math.abs(loc.y)<=90,'invalid coordinates');
 const vehicles=new Set<number>(),tasks=new Map<number,Record<string,unknown>>(),orders=new Set<number>();
 for(const v of r.vehicles){need(record(v)&&integer(v.id)&&!vehicles.has(Number(v.id))&&typeof v.ref==='string'&&v.ref.length>0&&Array.isArray(v.capacity)&&v.capacity.length===2&&v.capacity.every(finite)&&v.start_depot_id===0&&v.end_depot_id===0,'invalid fleet identity or capacity');vehicles.add(Number(v.id));}
 for(const t of r.tasks){need(record(t)&&integer(t.id)&&!tasks.has(Number(t.id))&&t.type==='delivery'&&integer(t.location_id)&&Number(t.location_id)<r.locations.length&&typeof t.ref==='string'&&t.ref.length>0&&Array.isArray(t.demand)&&t.demand.length===2&&t.demand.every(finite)&&finite(t.tw_early)&&finite(t.tw_late)&&finite(t.service_seconds),'invalid delivery task');tasks.set(Number(t.id),t);}
 for(const order of r.requests){need(record(order)&&integer(order.id)&&!orders.has(Number(order.id))&&integer(order.delivery_task_id)&&tasks.has(Number(order.delivery_task_id)),'invalid request identity');orders.add(Number(order.id));
  for(const field of ['allowed_vehicles','forbidden_vehicles'])if(order[field]!==undefined)need(Array.isArray(order[field])&&(order[field] as unknown[]).every(id=>integer(id)&&vehicles.has(Number(id))),'unknown assignment vehicle');
 }
 need(r.travel.location_count===r.locations.length,'matrix dimension mismatch');
 for(const key of ['distances','durations'])need(Array.isArray(r.travel[key])&&(r.travel[key] as unknown[]).length===r.locations.length**2&&(r.travel[key] as unknown[]).every(finite),'incomplete or invalid travel matrix');
 const days=value.days.map(raw=>{
  need(record(raw)&&typeof raw.dayId==='string'&&raw.dayId.length>0&&typeof raw.isoDate==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(raw.isoDate)&&Number.isFinite(Date.parse(raw.isoDate))&&new Date(raw.isoDate).toISOString().slice(0,10)===raw.isoDate,'invalid planning day');
  return {dayId:raw.dayId,isoDate:raw.isoDate,date:typeof raw.date==='string'?raw.date:raw.isoDate,label:typeof raw.label==='string'?raw.label:raw.isoDate};
 });
 need(new Set(days.map(d=>d.dayId)).size===days.length&&new Set(days.map(d=>d.isoDate)).size===days.length,'duplicate planning days');
 const request=r as unknown as SurgeRequest,byId=new Map(request.requests.map(order=>[order.id,order])),seen=new Set<number>();
 const geocoded=value.geocoded.map(raw=>{
  need(record(raw)&&integer(raw.request_id)&&!seen.has(Number(raw.request_id)),'source rows need unique request IDs');
  const order=byId.get(Number(raw.request_id)),task=order&&tasks.get(order.delivery_task_id);
  need(task&&task.ref===raw.order_no&&days.some(day=>day.date===String(raw.delivery_date))&&typeof raw.requires_tail_lift==='boolean'&&
   (raw.max_gross_weight_kg===null||typeof raw.max_gross_weight_kg==='number'&&Number.isFinite(raw.max_gross_weight_kg)&&raw.max_gross_weight_kg>0),'source date, identity and explicit access facts are required');
  seen.add(Number(raw.request_id));return raw;
 });
 need(seen.size===orders.size,'source delivery inventory mismatch');
 const requestBytes=Buffer.from(JSON.stringify(request)),datasetSha256=createHash('sha256').update(requestBytes).digest('hex');
 const shipments=value.shipments===undefined?summarizeShipments(request,geocoded,datasetSha256,days):validateShipments(value.shipments,request,datasetSha256);
 for(const delivery of shipments.deliveries){const raw=geocoded.find(row=>row.request_id===delivery.requestId)!;
  need(days.find(day=>day.date===String(raw.delivery_date))?.isoDate===delivery.date,'commercial and source delivery dates disagree');
 }
 return {requestBytes,request,days,geocoded,shipments};
}
