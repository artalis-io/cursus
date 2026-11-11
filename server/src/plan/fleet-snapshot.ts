import type {Plan,SurgeRequestVehicle} from '../types.js';
import type {FleetSnapshot} from '../fleet-contract.js';
export interface FleetSource {vehicles:SurgeRequestVehicle[];excludedVehicleIds?:number[];unavailableVehicleIds?:number[];complete:boolean}
const positive=(n:unknown):number|null=>typeof n==='number'&&Number.isFinite(n)&&n>0?n:null;
const nonnegative=(n:unknown):number|null=>typeof n==='number'&&Number.isFinite(n)&&n>=0?n:null;
export function captureFleet(plan:Plan,source:FleetSource):FleetSnapshot {
  return {version:1,planId:plan.id,scenarioId:plan.scenarioId,scenarioRevision:plan.scenarioRevision,inputSha256:plan.provenance.inputSha256,
    scope:source.complete?'complete':'eligible_only',vehicles:source.vehicles.map(v=>({id:v.id,ref:v.ref,
      availability:source.unavailableVehicleIds?.includes(v.id)?'unavailable':source.excludedVehicleIds?.includes(v.id)?'excluded':'available',
      capacityKg:positive(v.capacity[0]),capacityPallets:positive(v.capacity[1]),shiftStartSec:nonnegative(v.shift_early),shiftEndSec:positive(v.shift_late),
      maxDurationSec:positive(v.max_duration),maxDistanceKm:positive(v.max_distance)==null?null:v.max_distance!/1000,maxTrips:positive(v.max_trips),reloadSec:nonnegative(v.trip_reload_seconds)}))};
}
/** Input replacement changes IDs only after its new facts have been materialized. */
export function rebindFleet(plan:Plan):void {
  if(plan.provenance.fleet)plan.provenance.fleet={...plan.provenance.fleet,planId:plan.id,scenarioId:plan.scenarioId,scenarioRevision:plan.scenarioRevision,inputSha256:plan.provenance.inputSha256};
}
