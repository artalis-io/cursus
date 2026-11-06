/** Physical facts are imported separately from pallet equivalents. Importing
 * this document never enables the native hard-loading constraint. */
export interface PhysicalUnit {id:string;heightMm:number;weightG:number;stackClass:number;maxWeightAboveG:number;maxUnitsAbove:number}
export interface PhysicalVehicle {vehicleId:number;slotCount:number;maxLayers:number;clearanceMm:number;maxStackWeightG:number;payloadG:number;access:'side_free'|'rear_lifo';allowedTop:number[][];slots:{lane:number;depth:number}[]}
export interface LoadingDocument {schemaVersion:1;datasetSha256:string;mode:'disabled';vehicles:PhysicalVehicle[];requests:{requestId:number;units:PhysicalUnit[]}[]}
export interface LoadingSnapshot {sourceSha256:string;datasetSha256:string;mode:'disabled';status:'not_evaluated';rounds:{vehicleId:number;tripIndex:number;unitCount:number;status:'not_evaluated'}[]}
