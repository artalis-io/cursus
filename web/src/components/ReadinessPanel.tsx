import { ChevronDown, ClipboardCheck } from 'lucide-react';
import { useT } from '@/i18n';
import { km, money } from '@/lib/format';
import { reviewComparison, reviewReadiness } from '@/lib/readiness';
import type { Plan, Scenario } from '@/types';

/** No mutations, fetching, permissions or optimistic solver previews here.
 * Every value belongs to the displayed committed plan snapshot. */
export function ReadinessPanel({ plan, baseline, scenario, pending }: { plan: Plan; baseline: Plan; scenario: Scenario; pending: boolean }) {
  const t = useT();
  const review = reviewReadiness(plan, scenario, pending);
  const comparison = reviewComparison(baseline, plan);
  const tone = review.status === 'passed' ? 'text-primary' : 'text-warning';
  return (
    <details className="group shrink-0 border-b border-divider bg-card" aria-label={t('readiness.title')}>
      <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
        <ClipboardCheck className="h-4 w-4 shrink-0" />
        <span className="font-semibold">{t('readiness.title')}</span>
        <span className={`font-medium ${tone}`}>{t(`readiness.${review.status}`)}</span>
        <span className="text-muted-foreground">{t('readiness.coverageCount', { served: plan.stats.servedOrders, total: plan.stats.totalOrders })} · {t(review.fresh ? 'readiness.current' : 'readiness.stale')}</span>
        <span className="ml-auto text-muted-foreground">{t('readiness.details')}</span>
        <ChevronDown aria-hidden className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      <div className="max-h-[48vh] space-y-4 overflow-y-auto border-t border-divider px-4 py-3 text-xs">
        <p className="text-muted-foreground">{t('readiness.scope')}</p>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <section aria-label={t('readiness.coverage')} className="min-w-0 space-y-2">
            <h3 className="font-semibold">{t('readiness.coverage')}</h3>
            <p>{t('readiness.coverageCount', { served: plan.stats.servedOrders, total: plan.stats.totalOrders })} · {t('kpi.unassignedN', { n: plan.unassigned.length })}</p>
            {!review.coverageConsistent && <p className="text-warning">{t('readiness.inconsistent')}</p>}
            {plan.unassigned.length > 0 && <>
              <p className="text-muted-foreground">{t('readiness.inferred')}</p>
              <ul className="max-h-40 space-y-2 overflow-y-auto">
                {plan.unassigned.map((order, i) => <li key={`${order.orderNo}-${i}`} className="break-words"><span className="font-medium">{order.orderNo} · {order.customer}</span><p className="text-muted-foreground">{order.reason ?? t(`unassigned.${order.reasonCode ?? 'CONSTRAINED'}`)}</p></li>)}
              </ul>
            </>}
          </section>
          <section aria-label={t('readiness.constraints')} className="min-w-0 space-y-2">
            <h3 className="font-semibold">{t('readiness.constraints')}</h3>
            <dl className="space-y-2">{review.checks.map(check => <div key={check.key} className="flex justify-between gap-3"><dt>{t(`readiness.${check.key}`)}</dt><dd className={check.state === 'passed' ? 'text-primary' : check.state === 'notApplicable' ? 'text-muted-foreground' : 'text-warning'}>{t(`readiness.check.${check.state}`)}{check.failures > 0 ? ` · ${check.failures}` : ''}</dd></div>)}</dl>
            <p className="text-muted-foreground">{t('readiness.hardCount', { n: review.hardViolations })}</p>
            {plan.provenance?.validation?.valid !== true && <p className="text-warning">{t('readiness.validationUnconfirmed')}</p>}
            {!!plan.provenance?.validation?.violations?.some(v => v.soft) && <p className="text-warning">{t('readiness.advisories')}</p>}
            <p className="text-muted-foreground">{t('readiness.checkScope')}</p>
          </section>
          <section aria-label={t('issues.approvedExceptions')} className="min-w-0 space-y-2">
            <h3 className="font-semibold">{t('issues.approvedExceptions')} · {review.exceptions.length}</h3>
            <ul className="max-h-40 space-y-2 overflow-y-auto">{review.exceptions.map((exception, i) => <li key={`${exception.orderNo}-${i}`} className="break-words"><span className="font-medium">{exception.orderNo}</span>{exception.maxTonnage != null && <span> · GVW ≤ {exception.maxTonnage} t</span>}{exception.requiresTailLift === false && <span> · {t('issues.tailLiftWaived')}</span>}<p className="text-muted-foreground">{exception.reason}</p></li>)}</ul>
            {review.exceptions.length === 0 && <p className="text-muted-foreground">{t('readiness.noExceptions')}</p>}
          </section>
          <section aria-label={t('readiness.freshness')} className="min-w-0 space-y-2">
            <h3 className="font-semibold">{t('readiness.freshness')}</h3>
            <p className={review.fresh ? 'text-primary' : 'text-warning'}>{t(review.fresh ? 'readiness.current' : 'readiness.stale')}</p>
            <p className="break-all text-muted-foreground">{t('readiness.revisions', { plan: plan.scenarioRevision, scenario: scenario.revision })}</p>
            <p className="break-all text-muted-foreground">{t('readiness.planId', { id: plan.id })}</p>
          </section>
          <section aria-label={t('readiness.comparison')} className="min-w-0 space-y-2 md:col-span-2">
            <h3 className="font-semibold">{t('readiness.comparison')}</h3>
            <p className="break-all text-muted-foreground">{t('readiness.baseline', { id: baseline.id })}</p>
            {comparison.lostService && <p className="font-medium text-warning">{t('readiness.lostService')}</p>}
            {!comparison.sameScope && <p className="text-warning">{t('readiness.differentScope')}</p>}
            <div className="overflow-x-auto"><table className="w-full text-right tabular-nums"><thead><tr className="text-muted-foreground"><th className="text-left">{t('compare.metric')}</th><th>{t('compare.baseline')}</th><th>{t('compare.revised')}</th><th>Δ</th></tr></thead><tbody>
              {[
                [t('compare.servedOrders'), String(baseline.stats.servedOrders), String(plan.stats.servedOrders), plan.stats.servedOrders - baseline.stats.servedOrders],
                [t('compare.totalDistance'), km(baseline.stats.totalDistanceKm), km(plan.stats.totalDistanceKm), km(plan.stats.totalDistanceKm - baseline.stats.totalDistanceKm)],
                [t('compare.vehiclesUsed'), String(baseline.stats.vehiclesUsed), String(plan.stats.vehiclesUsed), plan.stats.vehiclesUsed - baseline.stats.vehiclesUsed],
                [t('compare.trips'), String(baseline.stats.trips), String(plan.stats.trips), plan.stats.trips - baseline.stats.trips],
                [t('compare.cost'), baseline.cost ? money(baseline.cost.total, baseline.cost.currency) : '—', plan.cost ? money(plan.cost.total, plan.cost.currency) : '—', comparison.comparableCost ? money(plan.cost!.total - baseline.cost!.total, plan.cost!.currency) : t('compare.notComparable')],
              ].map(([label, before, after, delta]) => <tr key={label} className="border-t border-divider"><th className="py-1.5 text-left font-normal">{label}</th><td className="pl-2">{before}</td><td className="pl-2">{after}</td><td className="pl-2">{comparison.sameScope ? delta : '—'}</td></tr>)}
            </tbody></table></div>
          </section>
        </div>
      </div>
    </details>
  );
}
