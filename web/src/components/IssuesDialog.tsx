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
  const custOf = (orderNo?: string): string => {
    for (const v of plan.vehicles) for (const tr of v.trips) for (const s of tr.stops) if (s.orderNo === orderNo) return s.customer ?? orderNo!;
    const u = plan.unassigned.find((x) => x.orderNo === orderNo);
    return u?.customer ?? orderNo ?? '—';
  };
  const locate = (v: ValidationViolation): Selection => {
    if (v.orderNo) {
      for (const veh of plan.vehicles) for (const tr of veh.trips) for (const s of tr.stops) {
        if (s.orderNo === v.orderNo) return { kind: 'stop', vehicleId: veh.id, tripIndex: tr.index, seq: s.seq };
      }
    }
    return v.vehicle_id != null ? { kind: 'vehicle', vehicleId: v.vehicle_id } : null;
  };
  const go = (sel: Selection): void => { onSelect(sel); onOpenChange(false); };

  const violations = plan.provenance.validation.violations;
  const hard = violations.filter((v) => !v.soft);
  const soft = violations.filter((v) => v.soft);
  const actionable = plan.unassigned.length + hard.length;

  const violationLabel = (v: ValidationViolation): string => (v.orderNo ? custOf(v.orderNo) : refOf(v.vehicle_id));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> {t('issues.title')}{actionable > 0 ? ` · ${actionable}` : ''}</DialogTitle></DialogHeader>

        {actionable === 0 && soft.length === 0 ? (
          <p className="flex items-center justify-center gap-2 py-8 text-center text-sm text-muted-foreground"><CheckCircle2 className="h-4 w-4 text-primary" /> {t('issues.none')}</p>
        ) : (
          <ScrollArea className="max-h-[56vh]">
            <div className="space-y-3 pr-3">
              {plan.unassigned.length > 0 && (
                <Group title={t('issues.unassigned')} count={plan.unassigned.length} icon={<PackageX className="h-3.5 w-3.5" />} warn>
                  {plan.unassigned.map((u) => (
                    <Row key={u.orderNo} onClick={() => go({ kind: 'unassigned', orderNo: u.orderNo })}
                      label={u.customer ?? u.orderNo} detail={t(`unassigned.${u.reasonCode ?? 'CONSTRAINED'}`)} />
                  ))}
                </Group>
              )}
              {hard.length > 0 && (
                <Group title={t('issues.hard')} count={hard.length} icon={<Clock className="h-3.5 w-3.5" />} warn>
                  {hard.map((v, i) => (
                    <Row key={i} onClick={() => go(locate(v))} label={violationLabel(v)} detail={violationDetail(v, t)} />
                  ))}
                </Group>
              )}
              {soft.length > 0 && (
                <Group title={t('issues.advisories')} count={soft.length} icon={<Weight className="h-3.5 w-3.5" />}>
                  {soft.map((v, i) => (
                    <Row key={i} onClick={() => go(locate(v))} label={violationLabel(v)} detail={violationDetail(v, t)} />
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

function Row({ label, detail, onClick }: { label: string; detail: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className="flex w-full items-center gap-2 rounded border border-divider px-2 py-1.5 text-left text-xs hover:bg-accent">
      <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
      <span className="shrink-0 text-muted-foreground">{detail}</span>
    </button>
  );
}
