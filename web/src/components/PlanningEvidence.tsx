import type {Plan} from '@/types';
import {useT} from '@/i18n';
/** Immutable source evidence; never dismiss or resolve a fact through a UI flag. */
export function PlanningEvidence({plan}:{plan:Plan}){
 const t=useT(),evidence=plan.provenance.planningEvidence;
 if(!evidence)return null;
 const groups=new Map<string,number>();for(const issue of evidence.issues)groups.set(issue.code,(groups.get(issue.code)??0)+1);
 return <details data-testid="planning-evidence" className="shrink-0 border-b border-warning/40 bg-warning/10 px-4 py-2 text-xs">
  <summary className="cursor-pointer font-medium text-warning">{t('preliminary.title')} · {t('preliminary.count',{n:evidence.issues.length})} · {t('preliminary.approvalBlocked')}</summary>
  <p className="mt-2 text-muted-foreground">{t('preliminary.scope')}</p>
  <ul className="mt-2 grid gap-1 sm:grid-cols-2">{[...groups].map(([code,n])=><li key={code}>{t(`preliminary.fact.${code}`)}: {n}</li>)}</ul>
 </details>;
}
