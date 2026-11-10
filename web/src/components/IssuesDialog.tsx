import {unassignedReviewSelection,violationSelection} from '@/lib/review-targets';
import {selectionContext} from '@/lib/selection-context';
import { AlertTriangle, PackageX, Clock, Weight, CheckCircle2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useT } from '@/i18n';
import { violationDetail } from '@/lib/violations';
import type { Plan, Selection, ValidationViolation } from '@/types';

/* A review of everything wrong with the current plan: unassigned orders (each
 * with an inferred reason), hard constraint violations, and soft advisories.
 * Every row is click-to-locate. Not a persistent worklist -- it reflects only
 * the plan on screen, to be checked before handing it off. */
export function IssuesDialog({ open, onOpenChange, plan, onSelect }: {
  open: boolean; onOpenChange: (o: boolean) => void; plan: Plan; onSelect: (s: Selection) => void;
}) {
  const t = useT();
  const refOf = (id?: number): string => plan.vehicles.find((v) => v.id === id)?.ref ?? `#${id}`;
  const locate=(v:ValidationViolation)=>violationSelection(plan,v);
  const go = (sel: Selection): void => { onSelect(sel); onOpenChange(false); };

  const violations = (Array.isArray(plan.provenance?.validation?.violations)?plan.provenance.validation.violations:[]).filter(v=>v&&typeof v==='object');
  const hard = violations.filter((v) => !v.soft);
  const soft = violations.filter((v) => v.soft);
  const actionable = plan.unassigned.length + hard.length;

  const violationLabel=(v:ValidationViolation):string=>{const context=selectionContext(plan,locate(v));
    if(context?.kind==='stop')return `${context.order.customer??context.order.orderNo} · ${context.order.orderNo}${context.order.requestId!==undefined?` · ${t('review.delivery',{id:context.order.requestId})}`:''}`;
    return context?.kind==='vehicle'?context.vehicle.ref:v.orderNo??refOf(v.vehicle_id);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> {t('issues.title')}{actionable > 0 ? ` · ${actionable}` : ''}</DialogTitle></DialogHeader>

        {!!plan.provenance.planningPolicy?.exceptions.length && (
          <section aria-label={t('issues.approvedExceptions')} className="rounded-md border bg-muted/40 p-3 text-sm">
            <h3 className="font-medium">{t('issues.approvedExceptions')}</h3>
            <ul className="mt-2 space-y-2">
              {plan.provenance.planningPolicy.exceptions.map(e => (
                <li key={e.orderNo}>
                  <span className="font-medium">{e.orderNo}</span>
                  {e.maxTonnage != null && <span> · GVW ≤ {e.maxTonnage} t</span>}
                  {e.requiresTailLift === false && <span> · {t('issues.tailLiftWaived')}</span>}
                  <p className="text-xs text-muted-foreground">{e.reason}</p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {plan.provenance?.validation?.valid!==true&&<p role="status" className="text-warning">{t('review.validation_failed')}</p>}
        {actionable === 0 && soft.length === 0 && plan.provenance?.validation?.valid===true ? (
          <p className="flex items-center justify-center gap-2 py-8 text-center text-sm text-muted-foreground"><CheckCircle2 className="h-4 w-4 text-primary" /> {t('issues.none')}</p>
        ) : (
          <ScrollArea className="max-h-[56vh]">
            <div className="space-y-3 pr-3">
              {plan.unassigned.length > 0 && (
                <Group title={t('issues.unassigned')} count={plan.unassigned.length} icon={<PackageX className="h-3.5 w-3.5" />} warn>
                  {plan.unassigned.map((u,index) => (
                    <Row key={u.requestId??`${u.orderNo}:${index}`} onClick={unassignedReviewSelection(plan,u)?() => go(unassignedReviewSelection(plan,u)):undefined}
                      label={`${u.customer??u.orderNo} · ${u.orderNo}${u.requestId!==undefined?` · ${t('review.delivery',{id:u.requestId})}`:''}`} detail={t(`unassigned.${u.reasonCode ?? 'CONSTRAINED'}`)} />
                  ))}
                </Group>
              )}
              {hard.length > 0 && (
                <Group title={t('issues.hard')} count={hard.length} icon={<Clock className="h-3.5 w-3.5" />} warn>
                  {hard.map((v, i) => (
                    <Row key={i} onClick={locate(v)?() => go(locate(v)):undefined} label={violationLabel(v)} detail={violationDetail(v, t)} />
                  ))}
                </Group>
              )}
              {soft.length > 0 && (
                <Group title={t('issues.advisories')} count={soft.length} icon={<Weight className="h-3.5 w-3.5" />}>
                  {soft.map((v, i) => (
                    <Row key={i} onClick={locate(v)?() => go(locate(v)):undefined} label={violationLabel(v)} detail={violationDetail(v, t)} />
                  ))}
                </Group>
              )}
            </div>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Group({ title, count, icon, warn, children }: { title: string; count: number; icon: React.ReactNode; warn?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <div className={`mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide ${warn ? 'text-warning' : 'text-muted-foreground'}`}>{icon} {title} · {count}</div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Row({ label, detail, onClick }: { label: string; detail: string; onClick?: () => void }) {
  const t=useT();
  if(!onClick)return <div className="rounded border border-divider px-2 py-1.5 text-xs"><p>{label} · {detail}</p><p className="text-muted-foreground">{t('review.targetUnavailable')}</p></div>;
  return (
    <button type="button" onClick={onClick}
      className="flex w-full items-center gap-2 rounded border border-divider px-2 py-1.5 text-left text-xs hover:bg-accent">
      <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
      <span className="shrink-0 text-muted-foreground">{detail}</span>
    </button>
  );
}
