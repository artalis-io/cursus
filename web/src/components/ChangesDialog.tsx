import { X, Ban, Pin, SlidersHorizontal, Repeat, RotateCcw, ListOrdered } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { hhmm } from '@/lib/format';
import { useT } from '@/i18n';
import type { Plan, Scenario, ScenarioEdit, VehicleOverride } from '@/types';

/* The staged-edit stack: every manual change (remove vehicle, pin/forbid an
 * order, edit vehicle constraints) accumulates here and is applied together on
 * Replan. Each row can be undone individually; Discard all reverts to baseline. */
export function ChangesDialog({ open, onOpenChange, plan, scenario, dirty, solving, onUndo, onDiscardAll, onReplan }: {
  open: boolean; onOpenChange: (o: boolean) => void;
  plan: Plan; scenario: Scenario; dirty: boolean; solving: boolean;
  onUndo: (edit: ScenarioEdit) => void; onDiscardAll: () => void; onReplan: () => void;
}) {
  const t = useT();
  const refOf = (id: number): string => plan.vehicles.find((v) => v.id === id)?.ref ?? `#${id}`;
  const custOf = (orderNo: string): string => {
    for (const v of plan.vehicles) for (const tr of v.trips) for (const s of tr.stops) if (s.orderNo === orderNo) return s.customer ?? orderNo;
    const u = plan.unassigned.find((x) => x.orderNo === orderNo);
    return u?.customer ?? orderNo;
  };
  const total = scenario.removedVehicleIds.length + scenario.pins.length + scenario.forbids.length + scenario.vehicleOverrides.length + scenario.sequences.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><SlidersHorizontal className="h-4 w-4" /> {t('changes.title')} · {total}</DialogTitle></DialogHeader>

        {total === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">{t('changes.none')}</p> : (
          <ScrollArea className="max-h-[52vh]">
            <div className="space-y-3 pr-3">
              {scenario.removedVehicleIds.length > 0 && (
                <Group title={t('changes.removed')} icon={<Ban className="h-3.5 w-3.5" />}>
                  {scenario.removedVehicleIds.map((id) => (
                    <Row key={id} label={refOf(id)} onUndo={() => onUndo({ op: 'restoreVehicle', vehicleId: id })} />
                  ))}
                </Group>
              )}
              {scenario.pins.length > 0 && (
                <Group title={t('changes.pinned')} icon={<Pin className="h-3.5 w-3.5" />}>
                  {scenario.pins.map((p) => (
                    <Row key={p.orderNo} label={custOf(p.orderNo)} detail={`→ ${refOf(p.vehicleId)}`} onUndo={() => onUndo({ op: 'unpin', orderNo: p.orderNo })} />
                  ))}
                </Group>
              )}
              {scenario.forbids.length > 0 && (
                <Group title={t('changes.forbidden')} icon={<Ban className="h-3.5 w-3.5" />}>
                  {scenario.forbids.map((f) => (
                    <Row key={`${f.orderNo}-${f.vehicleId}`} label={custOf(f.orderNo)} detail={`✗ ${refOf(f.vehicleId)}`} onUndo={() => onUndo({ op: 'unforbid', orderNo: f.orderNo, vehicleId: f.vehicleId })} />
                  ))}
                </Group>
              )}
              {scenario.vehicleOverrides.length > 0 && (
                <Group title={t('changes.constraints')} icon={<SlidersHorizontal className="h-3.5 w-3.5" />}>
                  {scenario.vehicleOverrides.map((o) => (
                    <Row key={o.vehicleId} label={refOf(o.vehicleId)} detail={summarize(o, t)} onUndo={() => onUndo({ op: 'clearVehicleConstraint', vehicleId: o.vehicleId })} />
                  ))}
                </Group>
              )}
              {scenario.sequences.length > 0 && (
                <Group title={t('changes.sequences')} icon={<ListOrdered className="h-3.5 w-3.5" />}>
                  {scenario.sequences.map((q) => (
                    <Row key={q.vehicleId} label={refOf(q.vehicleId)}
                      detail={t(q.locked ? 'changes.routeLocked' : 'changes.sequenceN', { n: q.orderNos.length })}
                      onUndo={() => onUndo({ op: 'clearSequence', vehicleId: q.vehicleId })} />
                  ))}
                </Group>
              )}
            </div>
          </ScrollArea>
        )}

        <div className="mt-2 flex items-center gap-2 border-t border-divider pt-3">
          {!dirty && total > 0 && <span className="text-[11px] text-muted-foreground">{t('changes.applied')}</span>}
          <div className="ml-auto flex gap-2">
            {total > 0 && (
              <Button variant="outline" size="sm" onClick={onDiscardAll} disabled={solving}>
                <RotateCcw className="h-4 w-4" /> {t('changes.discard')}
              </Button>
            )}
            <Button size="sm" onClick={onReplan} disabled={solving || total === 0} className={dirty ? 'ring-2 ring-warning/50' : ''}>
              <Repeat className="h-4 w-4" /> {t('topbar.replan')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function summarize(o: VehicleOverride, t: ReturnType<typeof useT>): string {
  const parts: string[] = [];
  if (o.capacityKg != null || o.capacityPallets != null) parts.push(t('changes.capacity', { kg: o.capacityKg ?? '—', plt: o.capacityPallets ?? '—' }));
  if (o.shiftEarlySec != null || o.shiftLateSec != null) parts.push(t('changes.shift', { a: o.shiftEarlySec != null ? hhmm(o.shiftEarlySec) : '—', b: o.shiftLateSec != null ? hhmm(o.shiftLateSec) : '—' }));
  if (o.maxTrips != null) parts.push(t('changes.maxTrips', { n: o.maxTrips }));
  if (o.maxDistanceKm != null) parts.push(t('changes.maxDistance', { n: o.maxDistanceKm }));
  if (o.maxDurationMin != null) parts.push(t('changes.maxDuration', { n: o.maxDurationMin }));
  return parts.join(' · ');
}

function Group({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{icon} {title}</div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Row({ label, detail, onUndo }: { label: string; detail?: string; onUndo: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded border border-divider px-2 py-1.5 text-xs">
      <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
      {detail && <span className="tnum shrink-0 text-muted-foreground">{detail}</span>}
      <button type="button" onClick={onUndo} aria-label="Undo" className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
