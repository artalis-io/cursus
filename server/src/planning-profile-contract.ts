export type ProfileKind = 'fleet' | 'locations';
export interface LocationRule {
  label?:string;
  locationId: number;
  maxGrossWeightKg: number | null;
  requiresTailLift: boolean;
  serviceSeconds: number;
  windowStartSeconds: number;
  windowEndSeconds: number;
  reason: string;
}
export interface FleetProfileVehicle {
  id: number; ref: string; vehicleClass: string | null; isSubcontractor: boolean;
  tonnage: number | null; hasTailLift: boolean; reloadSec: number; available?: boolean;
  capacityKg?:number;capacityPallets?:number;configurationRef?:string;
}
export interface ProfileContent {
  schemaVersion: 1; datasetSha256: string; label: string; reason: string; kind: ProfileKind;
  settings?: {datasetSha256:string;vehicles:FleetProfileVehicle[];tariff:unknown};
  locations?: LocationRule[];
}
export interface ProfileRef { id: string; kind: ProfileKind; revision: number; sha256: string }
export interface ApprovedProfile extends ProfileRef { content: ProfileContent; approvedAt: string; approvedBy: string | null }
export interface ProfileRevision {
  id:string;kind:ProfileKind;version:number;active_revision:number|null;revision:number;body:ProfileContent;sha256:string;
  proposed_at:string;approved_at:string|null;proposed_by:string|null;approved_by:string|null;
}
