/** Physical facts are imported separately from pallet equivalents. Importing
 * this document never enables the native hard-loading constraint. */
export interface PhysicalUnit {id:string;heightMm:number;weightG:number;stackClass:number;maxWeightAboveG:number;maxUnitsAbove:number;cgOffsetMm?:MassInterval}
export interface PhysicalVehicle {vehicleId:number;slotCount:number;maxLayers:number;clearanceMm:number;maxStackWeightG:number;payloadG:number;access:'side_free'|'rear_lifo';allowedTop:number[][];slots:{lane:number;depth:number}[];axles?:PhysicalAxles}
export interface LoadingDocument {schemaVersion:1|2;requiredCapabilities?:LoadingCapability[];datasetSha256:string;mode:'disabled';vehicles:PhysicalVehicle[];requests:{requestId:number;deliveryTaskId?:number;units:PhysicalUnit[]}[]}
export interface LoadingSnapshot {requiredCapabilities?:LoadingCapability[];sourceSha256:string;datasetSha256:string;mode:'disabled';status:'not_evaluated';rounds:{vehicleId:number;tripIndex:number;unitCount:number;status:'not_evaluated'}[]}

/** Native IDs are compact indices; public certificate IDs are stable dataset IDs. */
export interface LoadingPlacement {request_id:number;unit_index:number;slot:number;layer:number}
export interface LoadingRound {vehicle_id:number;trip_index:number;outcome:'feasible'|'infeasible'|'unknown';reason:string;nodes:number;placements:LoadingPlacement[];operations?:LoadingOperation[];axle_states?:AxleState[];stops?:LoadingStop[];extra_moves?:number;extra_service_sec?:number;extra_fee_units?:number}
export interface LoadingDiagnostic {request_id:number;scope:'loading_alone_not_route_insertability'|'physical_singleton_not_route_insertability';diagnostic_node_budget:number;feasible_vehicles:number;infeasible_vehicles:number;unknown_vehicles:number}
export interface NativeLoadingResult {version:1|2;required_capabilities?:LoadingCapability[];mode:'hard';node_budget:number;rounds:LoadingRound[];unassigned_checks:LoadingDiagnostic[]}
export interface NativeLoadingInput {version:1|2;required_capabilities?:LoadingCapability[];mode:'hard';node_budget:number;vehicles:{vehicle_id:number;access_model:'side_free'|'rear_lifo';slots:{lane:number;depth:number}[];max_layers:number;clearance_mm:number;max_stack_weight_g:number;payload_g:number;allowed_top:number[][];axles?:NativeAxles}[];requests:{request_id:number;units:{height_mm:number;weight_g:number;stack_class:number;max_weight_above_g:number;max_units_above:number;cg_offset_mm?:MassInterval}[]}[]}
export interface HardLoadingSnapshot {
 requiredCapabilities?:LoadingCapability[];sourceSha256:string;datasetSha256:string;mode:'hard';status:'feasible'|'stale';
 rounds:{vehicleId:number;tripIndex:number;unitCount:number;status:'feasible'|'not_evaluated'}[];
 certificate?:{
  version:1|2;requiredCapabilities?:LoadingCapability[];nativeCapabilities?:NativeLoadingCapabilities;planId:string;scenarioId:string;scenarioRevision:number;scenarioSha256:string;layoutSha256:string;
  requestSha256:string;solverSha256:string;requestIds:number[];vehicleIds:number[];
  /** Deflated immutable source JSON, SHA-256 checked before bounded replay. */
  facts:string;result:NativeLoadingResult;sha256:string;
 };
}
export type PhysicalLoadingEvidence=LoadingSnapshot|HardLoadingSnapshot;

export type LoadingCapability='stacking'|'axle_loads';
export interface MassInterval {min:number;max:number}
export interface PhysicalAxles {
 model:'rigid_two_axle_v1';profileSha256:string;wheelbaseMm:number;footprintLengthMm:number;
 deckMinMm:number;deckMaxMm:number;slotCentresMm:number[];
 frontTareG:MassInterval;rearTareG:MassInterval;frontLimitsG:MassInterval;rearLimitsG:MassInterval;
 maxGrossG:number;minFrontFraction:null|{numerator:number;denominator:number};
}
export interface NativeAxles {model:'rigid_two_axle_v1';profile_sha256:string;wheelbase_mm:number;footprint_length_mm:number;deck_min_mm:number;deck_max_mm:number;slot_centres_mm:number[];front_tare_g:MassInterval;rear_tare_g:MassInterval;front_limits_g:MassInterval;rear_limits_g:MassInterval;max_gross_g:number;min_front_fraction:null|{numerator:number;denominator:number}}
export interface LoadingOperation {kind:'load'|'deliver';stop_index:number|null;request_id:number;unit_index:number;slot:number;layer:number}
export interface AxleState {step:number;front_min_g:{numerator:string;denominator:number};front_max_g:{numerator:string;denominator:number};rear_min_g:{numerator:string;denominator:number};rear_max_g:{numerator:string;denominator:number};gross_min_g:number;gross_max_g:number}
export interface LoadingStop {stop_index:number;task_id:number;arrival_sec:number;service_start_sec:number;departure_sec:number;base_service_sec:number;extra_moves:number;extra_service_sec:number;extra_fee_units:number}
export interface NativeLoadingCapabilities {schema_version:2;implemented_capabilities:string[];axle_models:string[];handling_models:string[];limits:Record<string,number>}
export interface LoadingRequirement {version:1|2;requiredCapabilities:LoadingCapability[];sourceSha256:string}
