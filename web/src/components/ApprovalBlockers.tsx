import type {Workflow} from '../../../server/src/workflow-contract';
import {boundBlockerEvidence,blockerSelection} from '@/lib/review-targets';
import type {Plan,Selection} from '@/types';
import {useI18n,useT} from '@/i18n';
export type ReviewSection='issues'|'changes'|'constraints'|'loading';
export function ApprovalBlockers({workflow,plan,revision,onSelect,onSection,onReload,reloadDisabled,onRetry}:{
 workflow:Workflow;plan:Plan;revision:number;onSelect?:(selection:Selection)=>void;onSection?:(section:ReviewSection)=>void;onReload?:()=>void;reloadDisabled?:boolean;onRetry?:()=>void;
}){
 const t=useT(),{lang}=useI18n(),details=boundBlockerEvidence(workflow,plan);
 if(!workflow.blockers.length)return null;
 if(!details)return <div className="mt-2 space-y-1 text-muted-foreground"><p>{t('review.detailsUnavailable')}</p>{lang==='en'&&<p>{workflow.blockers.join(' ')}</p>}{onRetry&&<button type="button" className="underline" onClick={onRetry}>{t('review.retry')}</button>}</div>;
 const seen=new Set<string>(),items=details.items.filter(i=>{const k=JSON.stringify([i.code,i.target]);if(seen.has(k))return false;seen.add(k);return true;});
 return <ul aria-label={t('review.blockers')} className="mt-2 max-h-56 space-y-2 overflow-y-auto">
  {items.map((issue,index)=>{
   const target=issue.target,selection=blockerSelection(plan,target);
   const vehicle=target.kind!=='section'?plan.vehicles.find(v=>v.id===target.vehicleId):null;
   const label=target.kind==='stop'?`${target.orderNo}${target.requestId!==undefined?` · ${t('review.delivery',{id:target.requestId})}`:''} · ${vehicle?.ref??target.vehicleId}`:
    target.kind==='trip'?`${vehicle?.ref??target.vehicleId} · ${t('fleet.tripLabel',{n:target.tripIndex+1})}`:target.kind==='vehicle'?vehicle?.ref??String(target.vehicleId):null;
   const needsReload=target.kind==='section'&&target.section==='changes'&&workflow.currentRevision!==revision;
   return <li key={index} data-review-blocker={issue.code} className="rounded border border-divider p-2">
    <p>{t(`review.${issue.code}`)}</p>{label&&<p className="break-words text-muted-foreground">{label}</p>}
    {selection&&onSelect?<button type="button" className="mt-1 underline" onClick={()=>onSelect(selection)}>{t(`review.view.${selection.kind}`)}</button>:
     target.kind==='section'&&onSection&&!needsReload?<button type="button" className="mt-1 underline" onClick={()=>onSection(target.section)}>{t(`review.view.${target.section}`)}</button>:
     !needsReload&&<p className="text-muted-foreground">{t('review.targetUnavailable')}</p>}
    {target.kind==='section'&&target.section==='changes'&&onReload&&<button type="button" className="ml-2 mt-1 underline disabled:opacity-40" disabled={reloadDisabled} onClick={onReload}>{t('review.reload')}</button>}
   </li>;
  })}
 </ul>;
}
