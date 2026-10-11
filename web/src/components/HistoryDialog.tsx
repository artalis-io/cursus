import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { km } from '@/lib/format';
import { api, type PlanSummary } from '@/lib/api';
import { useT } from '@/i18n';

/* Saved plans for the day (baseline + persisted live solves), reopenable. Plans
 * persist on the backend; this is the reopen affordance. */
export function HistoryDialog({ open, onOpenChange, dayId, currentPlanId, onReopen }: {
  open: boolean; onOpenChange: (o: boolean) => void; dayId: string; currentPlanId: string; onReopen: (planId: string) => void;
}) {
  const t = useT();
  const [plans, setPlans] = useState<PlanSummary[] | null>(null);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setPlans(null);
    api.plans(dayId).then((p) => { if (alive) setPlans(p); }).catch(() => { if (alive) setPlans([]); });
    return () => { alive = false; };
  }, [open, dayId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader><DialogTitle>{t('history.title')}</DialogTitle></DialogHeader>
        {!plans ? <p className="py-6 text-center text-sm text-muted-foreground">{t('history.loading')}</p>
          : plans.length === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">{t('history.none')}</p>
          : (
            <ScrollArea className="max-h-[60vh]">
              <div className="space-y-1.5 pr-3">
                {plans.map((p) => {
                  const current = p.id === currentPlanId;
                  return (
                    <div key={p.id} className={`flex items-center gap-3 rounded-md border p-2.5 ${current ? 'border-ring ring-1 ring-ring' : 'border-divider'}`}>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <Badge variant={p.source === 'saved' ? 'outline' : 'default'}>{p.source === 'saved' ? t('topbar.baseline') : t('topbar.live')}</Badge>
                          <span className="truncate text-sm font-medium">{p.label}</span>
                          <span className="tnum text-[11px] text-muted-foreground">{p.termination}</span>
                        </div>
                        <div className="tnum mt-0.5 text-[11px] text-muted-foreground">
                          {t('history.summary', { served: p.servedOrders, total: p.totalOrders, veh: p.vehiclesUsed, km: km(p.totalDistanceKm) })}
                          {p.createdAt && new Date(p.createdAt).getTime() > 0 ? ` · ${new Date(p.createdAt).toLocaleTimeString()}` : ''}
                        </div>
                      </div>
                      <Button size="sm" variant={current ? 'outline' : 'default'} disabled={current}
                        onClick={() => { onReopen(p.id); onOpenChange(false); }}>
                        {current ? t('history.open') : t('history.reopen')}
                      </Button>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          )}
      </DialogContent>
    </Dialog>
  );
}
