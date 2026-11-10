import {useCallback} from 'react';
import {useLibraryList} from '@/hooks/useLibraryList';
import {LibraryStatus} from '@/components/LibraryStatus';
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
  const fetchList=useCallback((signal:AbortSignal)=>api.plans(dayId,signal),[dayId]);
  const library=useLibraryList<PlanSummary>(open,dayId,fetchList);
  const plans=library.items;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader><DialogTitle>{t('history.title')}</DialogTitle></DialogHeader>
        <LibraryStatus phase={library.phase} error={library.error} hasSnapshot={plans!==null} onRefresh={library.refresh}/>
        {plans===null ? null
          : plans.length === 0 && library.verified ? <p className="py-6 text-center text-sm text-muted-foreground">{t('history.none')}</p>
          : (
            <ScrollArea aria-busy={library.pending} data-testid="plans-library" className="max-h-[60vh]">
              <div className="space-y-1.5 pr-3">
                {plans.map((p) => {
                  const current = p.id === currentPlanId;
                  return (
                    <div key={p.id} data-plan-id={p.id} className={`flex items-center gap-3 rounded-md border p-2.5 ${current ? 'border-ring ring-1 ring-ring' : 'border-divider'}`}>
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
