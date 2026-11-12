export const evidenceCodes=['tail_lift','gvw','pallet_quantity','pallet_capacity','equipment','fleet_availability','capacity_conflict','operating_hours','reload','service_semantics','tariff','small_vehicle','appointment','receiving_window','physical_loading','driver_rules'] as const;
export interface PlanningIssue {code:typeof evidenceCodes[number];message:string;requestId?:number;vehicleId?:number}
export interface PlanningEvidence {version:1;sourceSha256:string;datasetSha256?:string;pricing:'unverified';issues:PlanningIssue[]}
