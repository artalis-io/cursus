/** Shared HTTP contract; no Node or PostgreSQL dependencies in browser builds. */
export interface Workflow {
  state: 'draft' | 'reviewed' | 'approved' | 'superseded';
  version: number;
  scenarioRevision: number;
  currentRevision: number;
  planSha256: string;
  actor: string | null;
  at: string | null;
  blockers: string[];
  blockerDetails?: ApprovalBlockerEvidence;
}

/** Additive, snapshot-bound presentation evidence. Never authorizes a write. */
export const approvalBlockerCodes = ['revision_changed','profiles_changed','validation_failed','coverage_incomplete',
  'dataset_identity_missing','shipment_metadata_mismatch','stop_inventory_mismatch','capacity','gvw','tail_lift',
  'time_window','locked_route','constraint_evidence_missing','physical_loading','settings_changed'] as const;
export type ApprovalBlockerCode = typeof approvalBlockerCodes[number];
export type ApprovalBlockerTarget =
  | {kind:'section';section:'issues'|'changes'|'constraints'|'loading'}
  | {kind:'vehicle';vehicleId:number}
  | {kind:'trip';vehicleId:number;tripIndex:number}
  | {kind:'stop';vehicleId:number;tripIndex:number;seq:number;orderNo:string;requestId?:number};
export interface ApprovalBlocker {code:ApprovalBlockerCode;message:string;target:ApprovalBlockerTarget}
export interface ApprovalBlockerEvidence {
  version:1;planId:string;scenarioId:string;planRevision:number;currentRevision:number;planSha256:string;items:ApprovalBlocker[];
}
