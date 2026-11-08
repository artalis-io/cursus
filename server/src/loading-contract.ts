/** Physical facts are imported separately from pallet equivalents. Importing
 * this document never enables the native hard-loading constraint. */
export interface PhysicalUnit {id:string;heightMm:number;weightG:number;stackClass:number;maxWeightAboveG:number;maxUnitsAbove:number}
export interface PhysicalVehicle {vehicleId:number;slotCount:number;maxLayers:number;clearanceMm:number;maxStackWeightG:number;payloadG:number;access:'side_free'|'rear_lifo';allowedTop:number[][];slots:{lane:number;depth:number}[]}
export interface LoadingDocument {schemaVersion:1;datasetSha256:string;mode:'disabled';vehicles:PhysicalVehicle[];requests:{requestId:number;units:PhysicalUnit[]}[]}
export interface LoadingSnapshot {sourceSha256:string;datasetSha256:string;mode:'disabled';status:'not_evaluated';rounds:{vehicleId:number;tripIndex:number;unitCount:number;status:'not_evaluated'}[]}

/** Native IDs are compact indices; public certificate IDs are stable dataset IDs. */
export interface LoadingPlacement {request_id:number;unit_index:number;slot:number;layer:number}
export interface LoadingRound {vehicle_id:number;trip_index:number;outcome:'feasible'|'infeasible'|'unknown';reason:string;nodes:number;placements:LoadingPlacement[]}
export interface LoadingDiagnostic {request_id:number;scope:'loading_alone_not_route_insertability';diagnostic_node_budget:number;feasible_vehicles:number;infeasible_vehicles:number;unknown_vehicles:number}
export interface NativeLoadingResult {version:1;mode:'hard';node_budget:number;rounds:LoadingRound[];unassigned_checks:LoadingDiagnostic[]}
export interface NativeLoadingInput {version:1;mode:'hard';node_budget:number;vehicles:{vehicle_id:number;access_model:'side_free'|'rear_lifo';slots:{lane:number;depth:number}[];max_layers:number;clearance_mm:number;max_stack_weight_g:number;payload_g:number;allowed_top:number[][]}[];requests:{request_id:number;units:{height_mm:number;weight_g:number;stack_class:number;max_weight_above_g:number;max_units_above:number}[]}[]}
export interface HardLoadingSnapshot {
 sourceSha256:string;datasetSha256:string;mode:'hard';status:'feasible'|'stale';
 rounds:{vehicleId:number;tripIndex:number;unitCount:number;status:'feasible'|'not_evaluated'}[];
 certificate?:{
  version:1;planId:string;scenarioId:string;scenarioRevision:number;scenarioSha256:string;layoutSha256:string;
  requestSha256:string;solverSha256:string;requestIds:number[];vehicleIds:number[];
  /** Deflated immutable source JSON, SHA-256 checked before bounded replay. */
  facts:string;result:NativeLoadingResult;sha256:string;
 };
}
export type PhysicalLoadingEvidence=LoadingSnapshot|HardLoadingSnapshot;
