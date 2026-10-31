import type {Workflow} from '../../../server/src/workflow-contract';

/** Presentation only: neither freshness nor these labels authorize a write. */
export type Freshness = 'loading'|'saving'|'running'|'candidate'|'revalidate'|'archived'|'stale'|'current';
export function workspaceFreshness(input:{loading:boolean;saving:boolean;running:boolean;candidate:boolean;revalidate:boolean;archived:boolean;conflict:boolean;fresh:boolean}):Freshness{
 if(input.loading)return 'loading';
 if(input.conflict)return 'stale';
 if(input.archived)return 'archived';
 if(input.revalidate)return 'revalidate';
 if(input.saving)return 'saving';
 if(input.running)return 'running';
 if(input.candidate)return 'candidate';
 return input.fresh?'current':'stale';
}
export function approvalSummary(workflow:Workflow|null,phase:'loading'|'ready'|'unavailable'|'error',revision:number,pending:boolean){
 if(phase!=='ready'||!workflow)return {state:phase==='loading'?'loading' as const:'unknown' as const,confirmed:false,savedSnapshot:false};
 const current=!pending&&workflow.currentRevision===revision&&workflow.scenarioRevision===revision&&workflow.blockers.length===0;
 return {state:workflow.state,confirmed:workflow.state==='approved'&&current,savedSnapshot:workflow.state==='approved'&&!current};
}

export function isWorkflowEvidence(value:unknown):value is Workflow{
 if(!value||typeof value!=='object')return false;
 const w=value as Partial<Workflow>;
 return ['draft','reviewed','approved','superseded'].includes(w.state??'')
  &&[w.version,w.currentRevision,w.scenarioRevision].every(n=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0)
  &&typeof w.planSha256==='string'&&/^[a-f0-9]{64}$/.test(w.planSha256)
  &&Array.isArray(w.blockers)&&w.blockers.every(b=>typeof b==='string')
  &&(w.actor===null||typeof w.actor==='string')
  &&(w.at===null||typeof w.at==='string'&&Number.isFinite(Date.parse(w.at)));
}
