/** Receiver acknowledgement is acceptance of an instruction, not proof of delivery. */
export type HandoffOperation='publish'|'amend'|'cancel';
export type TransferState='queued'|'sending'|'retrying'|'acknowledged'|'acknowledged_superseded'|'rejected'|'stale'|'needs_reconciliation';
export interface TransferEnvelope {
  protocol:'cursus.handoff.v1';intentId:string;tenantId:string;destinationId:string;
  scenarioId:string;generation:number;operation:HandoffOperation;reason:string;createdAt:string;
  planId:string;scenarioRevision:number;planSha256:string;approvalVersion:number;
  previousReceiptId:string|null;plan?:unknown;
}
export interface TransferAcknowledgement {
  status:'accepted'|'rejected';receiptId:string;idempotencyKey:string;payloadSha256:string;
  generation:number;planSha256:string;scenarioRevision:number;
}
export interface TransferSummary {
  id:string;destinationId:string;scenarioId:string;planId:string;scenarioRevision:number;generation:number;
  operation:HandoffOperation;reason:string;state:TransferState;createdAt:string;acknowledgedAt:string|null;
  receipt:TransferAcknowledgement|null;lastError:string|null;attempts:number;planSha256:string;
  payloadSha256:string;idempotencyKey:string;deadline:string;
  approvalVersion:number;
}
export interface DestinationSummary {id:string;label:string;protocol:'cursus.handoff.v1'}
