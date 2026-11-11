/** Saved decision evidence, not a live fleet registry or feasibility certificate. */
export interface FleetFact {
  operatingLimits?:import('./planning-profile-contract.js').OperatingLimits;
  id:number;ref:string;availability:'available'|'excluded'|'unavailable';
  capacityKg:number|null;capacityPallets:number|null;
  shiftStartSec:number|null;shiftEndSec:number|null;
  maxDurationSec:number|null;maxDistanceKm:number|null;maxTrips:number|null;reloadSec:number|null;
}
export interface FleetSnapshot {
  version:1;planId:string;scenarioId:string;scenarioRevision:number;inputSha256:string;
  scope:'complete'|'eligible_only';vehicles:FleetFact[];
}
