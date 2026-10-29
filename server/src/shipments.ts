import type {SurgeRequest} from './types.js';
import type {ShipmentDocument} from './shipment-contract.js';
export type {ShipmentDocument,DeliveryMetadata,Shipment,ShipmentLine,LoadUnit} from './shipment-contract.js';

const obj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const str=(v:unknown,max=128):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
const positive=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>0;
const nonnegative=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
const keys=(v:Record<string,unknown>,allowed:string[])=>Object.keys(v).every(k=>allowed.includes(k));
const equal=(a:number,b:number)=>Math.abs(a-b)<=1e-6*Math.max(1,Math.abs(a),Math.abs(b));
function requireThat(value:unknown,message:string):asserts value{if(!value)throw new Error(`Shipment metadata: ${message}`);}

/** Validate the complete allocation partition against the actual native input.
 * Explicit split deliveries must already exist; this never splits a request. */
export function validateShipments(value:unknown,request:SurgeRequest,datasetSha256:string):ShipmentDocument{
 requireThat(obj(value)&&keys(value,['schemaVersion','datasetSha256','shipments','deliveries'])&&value.schemaVersion===1&&
  value.datasetSha256===datasetSha256&&/^[a-f0-9]{64}$/.test(datasetSha256)&&Array.isArray(value.shipments)&&Array.isArray(value.deliveries),'invalid version or dataset identity');
 requireThat(value.shipments.length<=100000&&value.deliveries.length===request.requests.length,'delivery inventory mismatch');
 const shipments=new Map<string,{lines:Map<string,{quantity:number;netWeightKg?:number;grossWeightKg?:number}>;splitPolicy:string}>();
 for(const shipment of value.shipments){
  requireThat(obj(shipment)&&keys(shipment,['id','reference','splitPolicy','lines'])&&str(shipment.id)&&str(shipment.reference)&&
   !shipments.has(shipment.id)&&['indivisible','explicit'].includes(String(shipment.splitPolicy??'indivisible'))&&Array.isArray(shipment.lines)&&shipment.lines.length>0,'invalid shipment');
  const lines=new Map<string,{quantity:number;netWeightKg?:number;grossWeightKg?:number}>();
  for(const line of shipment.lines){
   requireThat(obj(line)&&keys(line,['id','productRef','quantity','unit','netWeightKg','grossWeightKg'])&&str(line.id)&&!lines.has(line.id)&&str(line.productRef)&&str(line.unit,32)&&positive(line.quantity)&&
    (line.netWeightKg===undefined||nonnegative(line.netWeightKg))&&(line.grossWeightKg===undefined||nonnegative(line.grossWeightKg))&&
    !(typeof line.netWeightKg==='number'&&typeof line.grossWeightKg==='number'&&line.netWeightKg>line.grossWeightKg),'invalid line or weight units');
   lines.set(line.id,line as unknown as {quantity:number;netWeightKg?:number;grossWeightKg?:number});
  }
  shipments.set(shipment.id,{lines,splitPolicy:String(shipment.splitPolicy??'indivisible')});
 }
 const tasks=new Map(request.tasks.map(t=>[t.id,t])),requests=new Map(request.requests.map(r=>[r.id,r]));
 const seenIds=new Set<string>(),seenRequests=new Set<number>(),allocated=new Map<string,Map<string,number>>(),destinations=new Map<string,Set<string>>();
 for(const delivery of value.deliveries){
  requireThat(obj(delivery)&&keys(delivery,['id','requestId','reference','locationId','date','shipmentId','allocations','planningWeightKg','palletEquivalent','weightBasis','loadUnits','detail'])&&
   str(delivery.id)&&!seenIds.has(delivery.id)&&Number.isSafeInteger(delivery.requestId)&&!seenRequests.has(Number(delivery.requestId))&&
   str(delivery.reference)&&typeof delivery.date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(delivery.date)&&
   Number.isFinite(Date.parse(delivery.date))&&new Date(delivery.date).toISOString().slice(0,10)===delivery.date&&
   nonnegative(delivery.planningWeightKg)&&nonnegative(delivery.palletEquivalent)&&['unspecified','gross','net'].includes(String(delivery.weightBasis))&&
   Array.isArray(delivery.allocations)&&Array.isArray(delivery.loadUnits)&&['summary','line_items'].includes(String(delivery.detail)),'invalid delivery');
  const order=requests.get(Number(delivery.requestId)),task=order&&tasks.get(order.delivery_task_id);
  requireThat(task&&task.ref===delivery.reference&&task.location_id===delivery.locationId&&
   equal(task.demand[0]??0,Number(delivery.planningWeightKg))&&equal(task.demand[1]??0,Number(delivery.palletEquivalent)),'native delivery identity or capacity totals mismatch');
  seenIds.add(delivery.id);seenRequests.add(Number(delivery.requestId));
  const units=new Set<string>();
  for(const unit of delivery.loadUnits){
   requireThat(obj(unit)&&keys(unit,['id','kind','quantity','stackable','grossWeightKg','volumeM3'])&&str(unit.id)&&!units.has(unit.id)&&str(unit.kind,64)&&
    Number.isSafeInteger(unit.quantity)&&Number(unit.quantity)>0&&(unit.stackable===null||typeof unit.stackable==='boolean')&&
    (unit.grossWeightKg===undefined||nonnegative(unit.grossWeightKg))&&(unit.volumeM3===undefined||nonnegative(unit.volumeM3)),'invalid physical load unit');
   units.add(unit.id);
  }
  if(delivery.detail==='summary'){
   requireThat(delivery.shipmentId===null&&delivery.allocations.length===0&&delivery.weightBasis==='unspecified','summary cannot manufacture commercial allocations or weight evidence');continue;
  }
  requireThat(str(delivery.shipmentId)&&shipments.has(delivery.shipmentId)&&delivery.allocations.length>0,'line-item delivery requires a shipment');
  const shipment=shipments.get(delivery.shipmentId)!,totals=allocated.get(delivery.shipmentId)??new Map<string,number>(),local=new Set<string>();
  let weight=0,weightKnown=true;
  for(const allocation of delivery.allocations){
   requireThat(obj(allocation)&&keys(allocation,['lineId','quantity'])&&str(allocation.lineId)&&!local.has(allocation.lineId)&&positive(allocation.quantity)&&shipment.lines.has(allocation.lineId),'invalid allocation');
   local.add(allocation.lineId);const line=shipment.lines.get(allocation.lineId)!;
   totals.set(allocation.lineId,(totals.get(allocation.lineId)??0)+Number(allocation.quantity));
   const source=delivery.weightBasis==='gross'?line.grossWeightKg:delivery.weightBasis==='net'?line.netWeightKg:undefined;
   if(source===undefined)weightKnown=false;else weight+=source*Number(allocation.quantity)/line.quantity;
  }
  if(delivery.weightBasis!=='unspecified')requireThat(weightKnown&&equal(weight,Number(delivery.planningWeightKg)),'declared line weights do not match delivery planning weight');
  allocated.set(delivery.shipmentId,totals);const used=destinations.get(delivery.shipmentId)??new Set<string>();used.add(delivery.id);destinations.set(delivery.shipmentId,used);
 }
 for(const [id,shipment] of shipments){
  requireThat(shipment.splitPolicy==='explicit'||destinations.get(id)?.size===1,'indivisible shipment was split');
  for(const [lineId,line]of shipment.lines)requireThat(equal(allocated.get(id)?.get(lineId)??0,line.quantity),'line quantities are missing or overallocated');
 }
 const result=structuredClone(value) as unknown as ShipmentDocument;
 for(const shipment of result.shipments)shipment.splitPolicy??='indivisible';
 return result;
}

/** Legacy/native conversion supplies summaries only. Never infer commercial
 * order grouping or fabricate SKU lines from a repeated display reference. */
export function summarizeShipments(request:SurgeRequest,rows:Record<string,unknown>[],datasetSha256:string,
 days:{date?:string;isoDate:string}[]):ShipmentDocument{
 const tasks=new Map(request.tasks.map(t=>[t.id,t])),byId=new Map<number,Record<string,unknown>>();
 for(const row of rows)if(Number.isSafeInteger(row.request_id)){
  const id=Number(row.request_id);requireThat(!byId.has(id),'duplicate source delivery identity');byId.set(id,row);
 }
 const deliveries=request.requests.map(order=>{
  const task=tasks.get(order.delivery_task_id),row=byId.get(order.id);
  requireThat(task&&row&&String(row.order_no)===task.ref,'source rows need exact request identities');
  const date=days.find(d=>String(d.date??d.isoDate)===String(row.delivery_date))?.isoDate;
  requireThat(date,'source delivery date is outside the admitted days');
  return {id:`delivery:${order.id}`,requestId:order.id,reference:task.ref,locationId:task.location_id,date,
   shipmentId:null,allocations:[],planningWeightKg:task.demand[0]??0,palletEquivalent:task.demand[1]??0,
   weightBasis:'unspecified' as const,loadUnits:[],detail:'summary' as const};
 });
 return validateShipments({schemaVersion:1,datasetSha256,shipments:[],deliveries},request,datasetSha256);
}
