/** Read-only catalogue evidence at one server snapshot; never an approval command. */
export interface PlanIdentity {
  version:1;planId:string;scenarioId:string;planRevision:number;scenarioRevision:number;
  selected:boolean;latest:boolean;
  approval:'draft'|'reviewed'|'approved'|'superseded'|'unknown';
  freshness:'current'|'stale'|'archived'|'unknown';checkedAt:string|null;planSha256:string|null;
}
