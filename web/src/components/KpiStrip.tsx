import { ChevronDown, ChevronUp } from 'lucide-react';
import { km, money, seconds } from '@/lib/format';
import { useT } from '@/i18n';
import type { Plan } from '@/types';
import type { JobView } from '@/App';
import { reviewComparison } from '@/lib/readiness';

function Delta({ value, goodWhenNegative, unit = '', suffix,allowImprovement=true }: { value: number; goodWhenNegative?: boolean; unit?: string; suffix?: string;allowImprovement?:boolean }) {
  const t = useT();
  const tail = suffix ?? t('kpi.vsBaseline');
  if (value === 0) return <span className="tnum text-[11px] text-muted-foreground">±0{unit} {tail}</span>;
  const good = allowImprovement && (goodWhenNegative ? value < 0 : value > 0);
  const sign = value > 0 ? '+' : '';
  // A glyph (not just color) carries the better/worse signal: ▲ = improved,
  // ▼ = worse. Keeps the signal legible for red-green color-deficient users.
  return (
    <span className={`tnum text-[11px] font-medium ${!allowImprovement ? 'text-muted-foreground' : good ? 'text-primary' : 'text-warning'}`}>
      <span aria-hidden>{allowImprovement ? good ? '▲' : '▼' : ''}</span> {sign}{value % 1 === 0 ? value : value.toFixed(0)}{unit} {tail}
    </span>
  );
}

function Kpi({ name, label, value, detail, compact, warning=false }: { name:string; label:string; value:string; detail?:React.ReactNode; compact:boolean; warning?:boolean }) {
  return <div data-kpi={name} className={`min-w-0 border-divider px-3 ${compact?'py-1.5':'py-2.5'} [&:not(:nth-child(3n+1))]:border-l sm:[&:not(:first-child)]:border-l`}>
    <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground sm:text-[11px]">{label}</dt>
    <dd data-kpi-value className={`tnum mt-0.5 break-words font-semibold leading-tight ${compact?'text-base':'text-xl'} ${warning?'text-warning':''}`}>{value}</dd>
    {detail&&<dd className="mt-1 text-[11px] text-muted-foreground">{detail}</dd>}
  </div>;
}

/* Compact KPI strip with fine dividers; shows deltas vs the baseline on replan.
 * previewDistanceKm/previewCostTotal, when set, reflect staged-but-not-replanned
 * reorders: saved totals remain authoritative, with a separately labeled
 * preview beside them until Replan commits it. Compact never hides core metrics. */
export function KpiStrip({ plan, baseline, compare, job, previewDistanceKm, previewCostTotal, compact=false, onToggleDetails }: {
  plan: Plan; baseline: Plan; compare: boolean; job: JobView | null;
  previewDistanceKm?: number | null; previewCostTotal?: number | null;
  compact?:boolean; onToggleDetails?:()=>void;
}) {
  const t = useT();
  const s = plan.stats;
  const b = baseline.stats;
  const evidence=reviewComparison(baseline,plan),allowImprovement=!compare||evidence.improvementEligible;
  const solveT = s.solveElapsedSeconds ?? (job?.status === 'running' ? job.elapsedSec : null);
  const costDelta = compare && plan.cost && baseline.cost ? plan.cost.total - baseline.cost.total : null;
  const distPreview = previewDistanceKm != null && Math.round(previewDistanceKm) !== Math.round(s.totalDistanceKm);
  const costPreview = previewCostTotal != null && plan.cost != null && Math.round(previewCostTotal) !== Math.round(plan.cost.total);

  return <section aria-label={t('kpi.summary')} className="shrink-0 border-b border-divider bg-card" data-compact={compact}>
    <div className="flex items-center justify-between gap-2 px-3 pt-1.5 text-[11px]">
      <div className="min-w-0 text-muted-foreground"><span className="font-medium">{t('kpi.summary')}</span>
        <span id="cursus-kpi-details" hidden={compact} className="ml-3 text-[11px]">
          {t('kpi.deliveryStops')}: <span className="tnum">{s.deliveryStops}</span> · {t('kpi.solveTime')}: <span className="tnum">{solveT!=null?seconds(solveT,1):'—'}</span>
        </span>
      </div>
      {onToggleDetails&&<button type="button" className="flex min-h-6 items-center gap-1 rounded px-1 text-muted-foreground hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" aria-expanded={!compact} aria-controls="cursus-kpi-details" onClick={onToggleDetails}>
        {t(compact?'layout.openKpis':'layout.collapseKpis')}{compact?<ChevronDown aria-hidden className="h-3 w-3"/>:<ChevronUp aria-hidden className="h-3 w-3"/>}
      </button>}
    </div>
    <dl className="grid grid-cols-3 sm:grid-cols-6">
      <Kpi name="served" compact={compact} label={t('kpi.servedTotal')} value={`${s.servedOrders} / ${s.totalOrders}`}
        detail={!compact&&compare?<Delta value={s.servedOrders-b.servedOrders} goodWhenNegative={false}/>:undefined}/>
      <Kpi name="unassigned" compact={compact} label={t('kpi.unassigned')} value={`${plan.unassigned.length}`} warning={plan.unassigned.length>0}/>
      <Kpi name="vehicles" compact={compact} label={t('kpi.vehiclesUsed')} value={`${s.vehiclesUsed}`}
        detail={!compact&&compare?<Delta value={s.vehiclesUsed-b.vehiclesUsed} goodWhenNegative allowImprovement={allowImprovement}/>:undefined}/>
      <Kpi name="trips" compact={compact} label={t('compare.trips')} value={`${s.trips}`}
        detail={!compact&&compare?<Delta value={s.trips-b.trips} goodWhenNegative allowImprovement={allowImprovement}/>:undefined}/>
      <Kpi name="distance" compact={compact} label={t('kpi.totalDistance')} value={km(s.totalDistanceKm)}
        detail={distPreview?<span>{t('kpi.previewTotal')}: {km(previewDistanceKm!)} · {t('kpi.preview')}</span>
          :!compact&&compare?<Delta value={Math.round(s.totalDistanceKm-b.totalDistanceKm)} goodWhenNegative allowImprovement={allowImprovement} unit=" km"/>:undefined}/>
      <Kpi name="cost" compact={compact} label={t('kpi.cost')} value={plan.cost?money(plan.cost.total,plan.cost.currency,true):'—'}
        detail={costPreview&&plan.cost?<span>{t('kpi.previewTotal')}: {money(previewCostTotal!,plan.cost.currency,true)} · {t('kpi.preview')}</span>
          :!compact&&costDelta!=null&&plan.cost?<span className={allowImprovement&&costDelta<0?'text-primary':costDelta>0?'text-warning':'text-muted-foreground'}>{costDelta>0?'+':costDelta<0?'−':'±'}{money(Math.abs(costDelta),plan.cost.currency,true)} {t('kpi.vsBaseline')}</span>
          :!compact&&plan.cost?t(plan.cost.source==='demo'?'kpi.demoTariff':'kpi.extTariff'):undefined}/>
    </dl>
  </section>;
}
