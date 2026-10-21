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
}
