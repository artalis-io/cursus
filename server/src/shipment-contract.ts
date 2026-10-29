/** Commercial identity is distinct from the atomic native delivery request. */
export interface ShipmentLine {
  id:string; productRef:string; quantity:number; unit:string;
  netWeightKg?:number; grossWeightKg?:number;
}
export interface Shipment {
  id:string; reference:string; splitPolicy:'indivisible'|'explicit'; lines:ShipmentLine[];
}
export interface LoadUnit {
  id:string; kind:string; quantity:number; stackable:boolean|null;
  grossWeightKg?:number; volumeM3?:number;
}
export interface DeliveryMetadata {
  id:string; requestId:number; reference:string; locationId:number; date:string;
  shipmentId:string|null; allocations:{lineId:string;quantity:number}[];
  planningWeightKg:number; palletEquivalent:number;
  weightBasis:'unspecified'|'gross'|'net'; loadUnits:LoadUnit[];
  detail:'summary'|'line_items';
}
export interface ShipmentDocument {
  schemaVersion:1; datasetSha256:string; shipments:Shipment[]; deliveries:DeliveryMetadata[];
}
export interface ShipmentSnapshot {
  datasetSha256:string;sourceSha256:string;loadingFeasibility:'not_evaluated';
  shipments:Shipment[];deliveries:DeliveryMetadata[];
}
