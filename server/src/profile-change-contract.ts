import type {ProfileRef} from './planning-profile-contract.js';
export interface ProfileChangeIntent {
 operationId:string;parentPlanId:string;profiles:ProfileRef[];reason:string;
 releaseRequestIds:number[];unlockVehicleIds:number[];clearVehicleOverrideIds:number[];
 acknowledgeInvalid:boolean;
}
export interface ProfileChangeLineage {
 sourcePlanId:string;sourceScenarioId:string;sourceRevision:number;datasetSha256:string;
 operationId:string;reason:string;at:string;actorId:string;
 before:ProfileRef[];after:ProfileRef[];
 releasedRequestIds:number[];unlockedVehicleIds:number[];clearedVehicleOverrideIds:number[];
}
export interface ProfileChangeConflict {code:'override'|'locked_route'|'retained_decision'|'downstream_commitment';message:string;vehicleId?:number;requestId?:number}
export interface ProfileSettingChange {kind:'fleet'|'location'|'tariff';id:number|string;label:string;field:string;before:unknown;after:unknown}
export interface ProfileChangePreview {
 previewSha256:string;changes:ProfileSettingChange[];conflicts:ProfileChangeConflict[];
 stats:{totalOrders:number;servedOrders:number;deliveryStops:number;unassignedOrders:number;vehiclesUsed:number;trips:number;totalDistanceKm:number}|null;
 cost:{total:number;fixed:number;variable:number;currency:string;source:string}|null;
 validation:{valid:boolean;violations:{type:string;vehicle_id?:number;request_id?:number;actual?:number;limit?:number}[]}|null;
 physicalLoadingPending:boolean;
 retained:{assignments:number;decisions:number;routeOrders:number;lockedVehicles:number;overrides:number};
 options:{decisions:{requestId:number;label:string}[];routes:{vehicleId:number;label:string;locked:boolean}[];overrides:{vehicleId:number;label:string}[]};
}
