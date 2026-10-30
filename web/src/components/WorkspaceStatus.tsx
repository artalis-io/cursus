import {PlanApproval} from '@/components/PlanApproval';
import {ReadinessPanel} from '@/components/ReadinessPanel';
import {approvalSummary,workspaceFreshness} from '@/lib/workspace-status';
import {useT} from '@/i18n';
import type {Plan,Scenario} from '@/types';

/** A single disclosure; its children stay mounted while closed. Critical
 * warnings and candidate decisions remain outside this component in App. */
export function WorkspaceStatus({plan,baseline,scenario,loading,saving,running,candidate,conflict,revalidate,changesCount,onOpenChanges}:{
 plan:Plan;baseline:Plan;scenario:Scenario;loading:boolean;saving:boolean;running:boolean;candidate:boolean;conflict:boolean;revalidate:boolean;changesCount:number;onOpenChanges:()=>void;
}){
 const t=useT();
 const fresh=plan.scenarioId===scenario.id&&plan.scenarioRevision===scenario.revision;
 const freshness=workspaceFreshness({loading,saving,running,candidate,conflict,revalidate,archived:!!scenario.supersededBy,fresh});
 const pending=freshness!=='current';
 return <PlanApproval key={plan.id} planId={plan.id} revision={scenario.revision} pending={pending}>
  {(evidence,detail)=>{
   const approval=approvalSummary(evidence.workflow,evidence.phase,scenario.revision,pending);
   return <ReadinessPanel plan={plan} baseline={baseline} scenario={scenario} pending={pending}
    freshness={<>{freshness==='current'?t('readiness.current'):t(`status.freshness.${freshness}`)}{freshness==='stale'&&changesCount>0&&!conflict&&<span className="block">{t('edits.pending',{n:changesCount})}</span>}</>}
    changesCount={freshness==='stale'&&!conflict&&!fresh?changesCount:0} onOpenChanges={onOpenChanges}
    approval={<span data-testid="status-approval" className="min-w-0 flex-1 basis-32">
     <span className="font-semibold">{t('status.approval')}</span>
     <span className={`mt-0.5 block ${approval.confirmed?'text-primary':approval.state==='loading'?'text-muted-foreground':'text-warning'}`}>{t(`status.approval.${approval.state}`)}{approval.savedSnapshot?` · ${t('status.savedSnapshot')}`:''}</span>
    </span>}>
     <div id="cursus-plan-review" tabIndex={-1} className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">{detail}</div>
   </ReadinessPanel>;
  }}
 </PlanApproval>;
}
