import { X, Repeat, SlidersHorizontal, RotateCcw } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { hhmm } from '@/lib/format';
import { useT } from '@/i18n';
import { usePermission } from '@/permissions';
import {instructions,instructionKey,type Instruction} from '../../../server/src/change-review-contract';
import type { Plan, Scenario, VehicleOverride } from '@/types';

/** Undo removes one Replan instruction; it never rewrites the saved result. */
export function ChangesDialog({open,onOpenChange,plan,scenario,dirty,solving,onUndo,onDiscardAll,onReplan,onReload,reloadDisabled,notice}: {
  open:boolean;onOpenChange:(o:boolean)=>void;plan:Plan;scenario:Scenario;dirty:boolean;solving:boolean;
  notice?:string|null;onReload:()=>void;reloadDisabled:boolean;onUndo:(instruction:Instruction)=>void;onDiscardAll:()=>void;onReplan:()=>void;
}) {
  const t=useT(),canEdit=usePermission('scenario.edit'),canSolve=usePermission('optimization.submit');
  const rows=instructions(scenario);
  const title=(i:Instruction)=>t(({removeVehicle:'changes.removed',pin:'changes.pinned',forbid:'changes.forbidden',setVehicleConstraint:'changes.constraints',setSequence:'changes.sequences'} as const)[i.op]);
  const refOf=(id:number)=>plan.vehicles.find(v=>v.id===id)?.ref??`#${id}`;
  const deliveries=[...plan.vehicles.flatMap(v=>v.trips.flatMap(tr=>tr.stops)),...plan.unassigned];
  const delivery=(orderNo:string,requestId?:number)=>{
    const matching=deliveries.filter(s=>s.orderNo===orderNo&&(requestId===undefined||s.requestId===requestId));
    const sameDataset=!!scenario.deliveryDatasetSha256&&scenario.deliveryDatasetSha256===plan.provenance.datasetSha256;
    const customer=matching.length===1&&(requestId===undefined||sameDataset)?matching[0].customer:undefined;
    return `${customer?`${customer} · `:''}${orderNo}${requestId===undefined?'':` · #${requestId}`}`;
  };
  const label=(i:Instruction)=>i.op==='pin'||i.op==='forbid'?delivery(i.orderNo,i.requestId):refOf(i.vehicleId);
  const detail=(i:Instruction):string=>{
    switch(i.op){
      case 'removeVehicle':return `${t('changes.savedVehicle', {state:plan.vehicles.some(v=>v.id===i.vehicleId)?t('changes.used'):t('changes.notUsed')})} → ${t('changes.excluded')}`;
      case 'pin':case 'forbid':{
        const before=plan.vehicles.filter(v=>v.trips.some(tr=>tr.stops.some(s=>s.orderNo===i.orderNo&&(i.requestId===undefined||s.requestId===i.requestId))));
        const safe=i.requestId===undefined?deliveries.filter(s=>s.orderNo===i.orderNo).length===1:!!scenario.deliveryDatasetSha256&&scenario.deliveryDatasetSha256===plan.provenance.datasetSha256;
        return `${safe&&before.length===1?before[0].ref:t('changes.unknown')} → ${i.op==='pin'?'':'✗ '}${refOf(i.vehicleId)}`;
      }
      case 'setVehicleConstraint':{
        const v=plan.vehicles.find(v=>v.id===i.vehicleId);
        return Object.entries(i.patch).map(([key,value])=>`${field(key,t)}: ${key==='capacityKg'?v?.capacityKg??t('changes.unknown'):key==='capacityPallets'?v?.capacityPallets??t('changes.unknown'):t('changes.unknown')} → ${key==='shiftEarlySec'||key==='shiftLateSec'?hhmm(value!):value}`).join(' · ');
      }
      case 'setSequence':{
        const v=plan.vehicles.find(v=>v.id===i.vehicleId);
        const before=v?.trips.flatMap(tr=>tr.stops.map(s=>delivery(s.orderNo,s.requestId))).join(' → ')??t('changes.unknown');
        return `${before} → ${i.orderNos.map((no,n)=>delivery(no,i.requestIds?.[n])).join(' → ')} · ${t(i.locked?'changes.routeLocked':'changes.sequenceN',{n:i.orderNos.length})}`;
      }
    }
  };
  const savedManual=plan.manual?.layout??plan.assignments?.layout;
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-xl">
      <DialogHeader><DialogTitle className="flex items-center gap-2"><SlidersHorizontal className="h-4 w-4"/>{t('changes.title')} · {rows.length}</DialogTitle></DialogHeader>
      <ScrollArea className="max-h-[52vh]">
        <div className="space-y-3 pr-3 text-xs">
          {notice&&<p role="alert" className="rounded border border-warning/40 bg-warning/10 p-2">{notice}</p>}
          {savedManual&&<section className="rounded border border-divider p-3" aria-label={t('changes.savedManual')}>
            <h3 className="font-semibold">{t('changes.savedManual')}</h3>
            <p className="mt-1 text-muted-foreground">{t('changes.savedManualHint',{n:Object.keys(savedManual.decisions).length})}</p>
            <p className="mt-1 break-all text-muted-foreground">{plan.id} · {t('changes.revision',{n:plan.scenarioRevision})}</p>
          </section>}
          <p className="text-muted-foreground">{t(dirty?'changes.pendingHint':'changes.savedHint')}</p>
          <p className="text-muted-foreground">{t('changes.undoHint')}</p>
          <p className="font-medium">{t('changes.columns')}</p>
          {rows.length===0&&<p className="py-5 text-center text-muted-foreground">{t('changes.none')}</p>}
          {rows.map(i=><div key={instructionKey(i)} data-instruction={i.op} data-request-id={'requestId' in i?i.requestId:undefined} className="flex items-start gap-2 rounded border border-divider px-2 py-2">
            <div className="min-w-0 flex-1"><div className="mb-1 text-[11px] text-muted-foreground">{title(i)}</div><div className="font-semibold break-words">{label(i)}</div><div className="mt-1 break-words text-muted-foreground">{detail(i)}</div>{i.op==='removeVehicle'&&<p className="mt-1 text-muted-foreground">{t('changes.restoreHint')}</p>}</div>
            {canEdit&&<button type="button" disabled={solving} onClick={()=>onUndo(i)} aria-label={`${t('changes.undo')} ${label(i)}`} className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent disabled:opacity-40"><X className="h-3.5 w-3.5"/></button>}
          </div>)}
        </div>
      </ScrollArea>
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2 border-t border-divider pt-3">
        <Button variant="outline" size="sm" onClick={onReload} disabled={reloadDisabled}>{t('changes.reload')}</Button>
        {canEdit&&rows.length>0&&<Button variant="outline" size="sm" onClick={onDiscardAll} disabled={solving} title={t('changes.leaveHint')}><RotateCcw className="h-4 w-4"/>{t('changes.discard')}</Button>}
        {canEdit&&canSolve&&<Button size="sm" onClick={onReplan} disabled={solving||rows.length===0} className={dirty?'ring-2 ring-warning/50':''}><Repeat className="h-4 w-4"/>{t('topbar.replan')}</Button>}
      </div>
    </DialogContent>
  </Dialog>;
}
function field(key:string,t:ReturnType<typeof useT>):string {
  const keys:Record<keyof Omit<VehicleOverride,'vehicleId'>,Parameters<typeof t>[0]>={capacityKg:'changes.kg',capacityPallets:'changes.pallets',shiftEarlySec:'changes.shiftStart',shiftLateSec:'changes.shiftEnd',maxTrips:'changes.trips',maxDistanceKm:'changes.distance',maxDurationMin:'changes.duration'};
  return t(keys[key as keyof typeof keys]);
}
