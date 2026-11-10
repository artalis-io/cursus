import type {PlanSummary} from './api';
import type {PlanIdentity} from '../../../server/src/library-contract';
export const searchText=(value:string)=>value.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase();
export function matchesPlan(plan:PlanSummary,query:string){
  return !query.trim()||searchText([plan.id,plan.scenarioId,plan.label].join(' ')).includes(searchText(query.trim()));
}
/** Missing/old/mismatched evidence is Unknown, never an inferred approval. */
export function verifiedIdentity(plan:PlanSummary,verified:boolean):PlanIdentity|null{
  const v=plan.identity;
  if(!verified||!v||v.version!==1||v.planId!==plan.id||v.scenarioId!==plan.scenarioId||
    !Number.isSafeInteger(v.planRevision)||v.planRevision<0||!Number.isSafeInteger(v.scenarioRevision)||v.scenarioRevision<0||
    typeof v.selected!=='boolean'||typeof v.latest!=='boolean'||!['draft','reviewed','approved','superseded','unknown'].includes(v.approval)||
    !['current','stale','archived','unknown'].includes(v.freshness)||typeof v.checkedAt!=='string'||!v.checkedAt||!Number.isFinite(Date.parse(v.checkedAt))||
    v.approval!=='unknown'&&!/^[a-f0-9]{64}$/.test(v.planSha256??'')||
    ['approved','reviewed'].includes(v.approval)&&v.freshness!=='current'||v.freshness==='current'&&v.planRevision!==v.scenarioRevision)return null;
  return v;
}
