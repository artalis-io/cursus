/** Immutable effective rates, captured before JSONB can reorder class-rate maps. */
export interface CostRates {
  vehicleId:number; vehicleClass:string|null; isSubcontractor:boolean;
  fixedBase:number; perKm:number; perDrop:number; includedDrops:number; multiplier:number;
}
export interface CostingSnapshot {
  version:1;planId:string;scenarioId:string;scenarioRevision:number;inputSha256:string;
  tariffSha256:string;currency:string;source:'demo'|'external';model:'per_vehicle'|'per_trip';rates:CostRates[];
}
export type CostIssue='missing_cost'|'missing_rates'|'invalid_snapshot'|'ambiguous_class_rates'|'amount_mismatch'|'trip_allocation_missing';
export interface CostTripReview {
  index:number;distanceKm:number;pricedDistanceKm:number;drops:number;extraDrops:number|null;
  allocatedTotal:number|null;referenceEstimate:number|null;allocationAdjustment:number|null;
}
export interface CostVehicleReview {
  vehicleId:number;ref:string;distanceKm:number;pricedDistanceKm:number;
  fixed:number;variable:number;total:number;rates:CostRates|null;trips:CostTripReview[];
}
export interface CostReview {
  version:1;planId:string;scenarioId:string;scenarioRevision:number;inputSha256:string;createdAt:string;
  currentScenarioRevision:number|null;
  status:'verified'|'partial'|'inconsistent'|'unavailable';issues:CostIssue[];
  total:number|null;fixed:number|null;variable:number|null;currency:string|null;source:'demo'|'external'|null;
  tariffSha256:string|null;model:'per_vehicle'|'per_trip'|null;evidence:'saved_rates'|'matched_tariff'|'missing'|'invalid';
  tariffFreshness:'current'|'changed'|'unknown';currentTariffSha256:string|null;
  vehicles:CostVehicleReview[];
}
