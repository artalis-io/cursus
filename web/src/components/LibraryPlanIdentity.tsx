import {Badge} from '@/components/ui/badge';
import {useI18n,useT} from '@/i18n';
import type {PlanSummary} from '@/lib/api';
import {verifiedIdentity} from '@/lib/library-identity';

export function LibraryPlanIdentity({plan,verified,viewed}:{plan:PlanSummary;verified:boolean;viewed:boolean}){
  const t=useT(),{lang}=useI18n(),identity=verifiedIdentity(plan,verified);
  const created=Date.parse(plan.createdAt);
  return <div data-library-identity={plan.id} className="mt-1 min-w-0 space-y-1 text-[11px] text-muted-foreground">
    <div className="flex flex-wrap items-center gap-1">
      {viewed&&<Badge variant="outline">{t('library.viewed')}</Badge>}
      {identity?.selected&&<Badge variant="outline">{t('library.selected')}</Badge>}
      {identity?.latest&&<Badge variant="outline">{t('library.latest')}</Badge>}
      <Badge variant="outline" className="max-w-full whitespace-normal break-words" data-library-approval={identity?.approval??'unknown'}>{t('library.approval')}: {t(`library.${identity?.approval??'unknown'}`)}</Badge>
      <Badge variant="outline" className="max-w-full whitespace-normal break-words" data-library-freshness={identity?.freshness??'unknown'}>{t('library.freshness')}: {t(`library.${identity?.freshness==='stale'?'stalePlan':identity?.freshness??'unknown'}`)}</Badge>
    </div>
    <p className="break-all" title={plan.id}>{t('library.planRef')}: {plan.id}</p>
    {identity&&<p>{t('library.revisions',{p:identity.planRevision,s:identity.scenarioRevision})}</p>}
    <p>{t('library.created')}: {Number.isFinite(created)&&created>0?new Date(created).toLocaleString(lang==='hu'?'hu-HU':'en-GB'):t('library.unknown')}</p>
  </div>;
}
