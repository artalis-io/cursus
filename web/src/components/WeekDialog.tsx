import { useEffect, useState } from 'react';
import { CalendarRange } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { km, money } from '@/lib/format';
import { api, type WeekSummary } from '@/lib/api';
import { useT, describeApiError } from '@/i18n';

/* Cross-day week roll-up: combined totals, per-day breakdown, and per-vehicle
 * two-day utilization (vehicles matched by ref). Read-only over both baselines. */
export function WeekDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const t = useT();
  const [w, setW] = useState<WeekSummary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setW(null); setErr(null);
    api.week().then((x) => { if (alive) setW(x); }).catch((e) => { if (alive) setErr(describeApiError(e, t)); });
    return () => { alive = false; };
  }, [open, t]);

  const cur = w?.currency ?? 'HUF';
  const short = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><CalendarRange className="h-4 w-4" /> {t('week.title')}</DialogTitle></DialogHeader>
        {err && <p className="text-sm text-destructive">{err}</p>}
        {!w ? <p className="py-8 text-center text-sm text-muted-foreground">{t('week.loading')}</p> : (
          <div className="space-y-4">
            {/* Combined totals */}
            <div className="grid grid-cols-5 gap-2">
              <Stat label={t('week.orders')} value={`${w.totals.servedOrders}/${w.totals.totalOrders}`} />
              <Stat label={t('week.vehicles')} value={`${w.totals.vehiclesUsed}`} />
              <Stat label={t('week.trips')} value={`${w.totals.trips}`} />
              <Stat label={t('week.distance')} value={km(w.totals.totalDistanceKm)} />
              <Stat label={t('week.cost')} value={w.totals.costTotal != null ? money(w.totals.costTotal, cur, true) : '—'} />
            </div>

            {/* Per-day breakdown */}
            <div className="grid grid-cols-2 gap-2">
              {w.days.map((d) => (
                <div key={d.dayId} className="rounded-md border border-divider bg-card p-2.5">
                  <div className="text-xs font-semibold">{short(d.isoDate)}</div>
                  <div className="tnum mt-0.5 text-[11px] text-muted-foreground">
                    {d.servedOrders}/{d.totalOrders} · {d.vehiclesUsed} veh · {d.trips} trips · {km(d.totalDistanceKm)}{d.costTotal != null ? ` · ${money(d.costTotal, cur, true)}` : ''}
                  </div>
                </div>
              ))}
            </div>

            {/* Per-vehicle utilization */}
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('week.perVehicle')}</div>
              <div className="max-h-[42vh] overflow-y-auto rounded border border-divider">
                <table className="w-full border-collapse text-[11px]">
                  <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                    <tr className="text-left text-muted-foreground">
                      <th className="px-2 py-1 font-medium">{t('week.vehicle')}</th>
                      {w.days.map((d) => <th key={d.dayId} className="px-2 py-1 text-right font-medium">{short(d.isoDate)}</th>)}
                      <th className="px-2 py-1 text-right font-medium">{t('week.total')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {w.vehicles.map((v) => (
                      <tr key={v.ref} className="border-t border-divider">
                        <td className="px-2 py-1">
                          <span className="font-medium">{v.ref}</span>
                          {v.daysWorked === w.days.length && <Badge variant="outline" className="ml-1.5 px-1 py-0 text-[9px]">{t('week.bothDays')}</Badge>}
                          {v.isSubcontractor && <Badge variant="warning" className="ml-1 px-1 py-0 text-[9px]">{t('inspector.subcontractor')}</Badge>}
                        </td>
                        {w.days.map((d) => {
                          const pd = v.perDay[d.dayId];
                          return <td key={d.dayId} className="tnum px-2 py-1 text-right text-muted-foreground">{pd ? `${pd.km.toFixed(0)} km · ${pd.trips}t` : '—'}</td>;
                        })}
                        <td className="tnum px-2 py-1 text-right font-medium">{v.totalKm.toFixed(0)} km{v.totalCost != null ? ` · ${money(v.totalCost, cur, true)}` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-divider bg-card px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="tnum text-sm font-semibold">{value}</div>
    </div>
  );
}
