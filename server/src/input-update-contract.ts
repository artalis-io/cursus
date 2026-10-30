import type {ProfileRef} from './planning-profile-contract.js';
export interface DatasetBinding {datasetId:string;dayId:string;requestSha256:string}
export interface InputUpdateLineage {
  sourcePlanId:string;sourceScenarioId:string;sourceRevision:number;sourceDatasetSha256:string;
  targetDatasetId:string;targetDatasetSha256:string;operationId:string;reason:string;at:string;
  matches:{from:number;to:number}[];releasedRequestIds:number[];unlockedVehicleIds:number[];
}
export interface InputUpdateIntent {
  operationId:string;parentPlanId:string;datasetId:string;dayId:string;reason:string;
  matches:{from:number;to:number}[];releaseRequestIds:number[];unlockVehicleIds:number[];
  profiles:ProfileRef[];identityReviewed:true;carryExceptions:boolean;acknowledgeInvalid:boolean;
}
export interface UpdateDelivery {id:number;reference:string;customer:string;address:string;weightKg:number;pallets:number}
export interface InputUpdateDiff {
  added:UpdateDelivery[];cancelled:UpdateDelivery[];
  changed:{before:UpdateDelivery;after:UpdateDelivery;fields:string[]}[];
  unchanged:number;affectedVehicles:number[];matrixChanged:boolean;
  conflicts:{code:string;requestId?:number;vehicleId?:number;message:string}[];
  retainedDecisions:number;
}
