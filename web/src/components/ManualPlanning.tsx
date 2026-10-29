import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useT, describeApiError } from '@/i18n';
import { usePermission } from '@/permissions';
import { api } from '@/lib/api';
import { km, money } from '@/lib/format';
import { violationDetail } from '@/lib/violations';
import { manualAssignmentCommands } from '@/lib/manual-assignment';
import type { ManualIntent, ManualPreview, Plan, Scenario, Vehicle } from '@/types';

export type ManualAction = 'assign'|'deassign'|'release';
export interface ManualRequest {requestIds:number[];action:ManualAction;targetVehicleId?:number;vehicle?:{id:number;excluded:boolean};undo?:true}
export function ManualOrderActions({plan,requestId,assigned,disabled,onAction,actors}:{plan:Plan;requestId:number;assigned:boolean;disabled:boolean;onAction:(action:ManualAction)=>void;actors?:Record<string,string>}){
  const t=useT(),canEdit=usePermission('scenario.edit');
  const layout=(plan.manual??plan.assignments)?.layout,decision=layout?.decisions[String(requestId)];
  const history=layout?.history.filter(event=>event.requestId===requestId)??[];
  const ref=(id:number)=>plan.vehicles.find(v=>v.id===id)?.ref??`#${id}`;
  return <section aria-label={t('manual.assignment')} className="space-y-2 rounded-md border border-divider bg-muted/30 p-2.5">
    <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t('manual.assignment')}</div>
    <Badge variant="outline">{t(decision?'manual.retained':'manual.automatic')}</Badge>
    <p className="text-[10px] text-muted-foreground">{t('manual.origin')}: {t(`manual.origin.${layout?.origins[String(requestId)]??(plan.source==='live'?'optimizer':'historical')}`)}</p>
    {canEdit&&<div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={disabled} onClick={()=>onAction('assign')}>{t(assigned?'manual.move':'manual.assign')}</Button>
      {assigned&&<Button size="sm" variant="outline" disabled={disabled} onClick={()=>onAction('deassign')}>{t('manual.deassign')}</Button>}
      {decision&&<Button size="sm" variant="outline" disabled={disabled} onClick={()=>onAction('release')}>{t('manual.release')}</Button>}
    </div>}
    <p className="text-[10px] text-muted-foreground">{t('manual.retentionHint')}</p>
    {!!history.length&&<details className="text-xs"><summary className="cursor-pointer">{t('manual.history')} ({history.length})</summary>
      <ol className="mt-2 space-y-2 break-words">{history.map((event,i)=><li key={`${event.operationId}-${i}`}>
        {t(`manual.${event.action}`)} · {event.from?ref(event.from.vehicleId):t('fleet.unassigned')} → {event.to?ref(event.to.vehicleId):t('fleet.unassigned')}
        <div className="text-[10px] text-muted-foreground">{actors?.[event.actorId]??event.actorId} · {new Date(event.at).toLocaleString()}</div>
      </li>)}</ol></details>}
  </section>;
}

export function ManualPlanningDialog({plan,scenario,fleet,request,onClose,onApply,datasetSha256}:{plan:Plan;scenario:Scenario;fleet:Vehicle[];request:ManualRequest;onClose:()=>void;onApply:(intent:ManualIntent)=>Promise<void>;datasetSha256:string}){
  const t=useT(),canEdit=usePermission('scenario.edit'),canEvaluate=usePermission('plan.evaluate');
  const [vehicleId,setVehicleId]=useState(String(request.targetVehicleId??fleet.find(v=>!v.unavailable&&!scenario.removedVehicleIds.includes(v.id))?.id??''));
  const [tripId,setTripId]=useState(()=>{const v=fleet.find(v=>v.id===Number(request.targetVehicleId??fleet.find(v=>!v.unavailable&&!scenario.removedVehicleIds.includes(v.id))?.id));const tr=v?.trips.at(-1);return tr?(tr.manualTripId??`trip-${tr.index}`):'';}),[position,setPosition]=useState<string>('');
  const [operationId]=useState(()=>crypto.randomUUID()),[newTripId]=useState(()=>`manual-${crypto.randomUUID()}`);
  const [preview,setPreview]=useState<ManualPreview|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[attempted,setAttempted]=useState(false);
  const generation=useRef(0),alive=useRef(true),inFlight=useRef(false);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const vehicle=fleet.find(v=>v.id===Number(vehicleId)),trip=vehicle?.trips.find(tr=>(tr.manualTripId??`trip-${tr.index}`)===tripId);
  const remaining=trip?.stops.filter(stop=>!request.requestIds.includes(stop.requestId??-1))??[];
  const intent=useMemo<ManualIntent>(()=>({parentPlanId:plan.id, ...(request.vehicle?{vehicle:request.vehicle}:{}),...(request.undo?{undo:true as const}:{}),
    batch:{operationId,datasetSha256,
      commands:request.vehicle||request.undo?[]:request.action==='assign'
        ?manualAssignmentCommands(request.requestIds,Number(vehicleId),tripId||newTripId,
          trip?.stops.map(stop=>stop.requestId!)??[],position===''?remaining.length:Number(position))
        :request.requestIds.map(requestId=>({op:request.action==='deassign'?'deassign':'release',requestId}))}}),[plan,request,operationId,vehicleId,tripId,newTripId,position,trip,remaining.length,datasetSha256]);
  const intentKey=JSON.stringify(intent);
  useEffect(()=>{generation.current++;setPreview(null);setError(null);},[intentKey]);
  const valid=!!request.vehicle||!!request.undo||request.action!=='assign'||!!vehicle&&!vehicle.unavailable&&!scenario.removedVehicleIds.includes(vehicle.id);
  async function calculate(){
    if(inFlight.current||!canEvaluate||!valid)return;
    inFlight.current=true;setBusy(true);setError(null);const token=++generation.current;
    try{const result=await api.manualPreview(scenario.id,scenario.revision,intent);if(alive.current&&token===generation.current)setPreview(result);}
    catch(e){if(alive.current&&token===generation.current)setError(describeApiError(e,t));}
    finally{inFlight.current=false;if(alive.current)setBusy(false);}
  }
  async function apply(){
    if(inFlight.current||!preview||!canEdit)return;
    inFlight.current=true;setBusy(true);setAttempted(true);setError(null);
    try{await onApply(intent);}catch(e){if(alive.current)setError(describeApiError(e,t));}
    finally{inFlight.current=false;if(alive.current)setBusy(false);}
  }
  return <Dialog open onOpenChange={open=>{if(!open&&!busy)onClose();}}><DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
    <DialogHeader><DialogTitle>{t('manual.title')}</DialogTitle><DialogDescription>{t('manual.description')}</DialogDescription></DialogHeader>
    {request.undo?<p>{t('manual.undoConfirm')}</p>:request.vehicle?<p>{t(request.vehicle.excluded?'manual.excludeConfirm':'manual.restoreConfirm',{n:request.requestIds.length})}</p>
      :<p className="text-sm">{t(`manual.${request.action}`)} · {request.requestIds.length}</p>}
    {!request.vehicle&&!request.undo&&request.action==='assign'&&<fieldset disabled={busy||attempted||!canEdit} className="grid grid-cols-2 gap-3 text-sm">
      <label className="col-span-2">{t('manual.vehicle')}<select aria-label={t('manual.vehicle')} value={vehicleId} onChange={e=>{setVehicleId(e.target.value);setTripId('');setPosition('');}} className="mt-1 h-9 w-full rounded border bg-card px-2">
        {fleet.map(v=><option key={v.id} value={v.id} disabled={v.unavailable||scenario.removedVehicleIds.includes(v.id)}>{v.ref}{v.unavailable?` · ${t('manual.unavailable')}`:scenario.removedVehicleIds.includes(v.id)?` · ${t('manual.excluded')}`:''}</option>)}
      </select></label>
      <label>{t('manual.trip')}<select aria-label={t('manual.trip')} value={tripId} onChange={e=>{setTripId(e.target.value);setPosition('');}} className="mt-1 h-9 w-full rounded border bg-card px-2">
        {vehicle?.trips.map(tr=><option key={tr.index} value={tr.manualTripId??`trip-${tr.index}`}>{t('fleet.tripLabel',{n:tr.index+1})}</option>)}
        <option value="">{t('manual.newTrip')}</option>
      </select></label>
      <label>{t('manual.position')}<select aria-label={t('manual.position')} value={position} onChange={e=>setPosition(e.target.value)} className="mt-1 h-9 w-full rounded border bg-card px-2">
        <option value="">{t('manual.append')}</option>{remaining.map((stop,i)=><option key={stop.requestId??i} value={i}>{t('manual.before',{order:stop.orderNo})}</option>)}
      </select></label>
    </fieldset>}
    <p className="text-xs text-muted-foreground">{t('manual.retentionHint')}</p>
    {preview&&<section aria-label={t('manual.preview')} className="space-y-2 rounded border p-3 text-sm" data-testid="manual-preview">
      <div className="font-semibold">{t('manual.preview')}</div>
      <dl className="grid grid-cols-2 gap-2"><dt>{t('manual.coverage')}</dt><dd>{plan.stats.servedOrders}/{plan.stats.totalOrders} → {preview.stats.servedOrders}/{preview.stats.totalOrders}</dd>
        <dt>{t('inspector.distance')}</dt><dd>{km(plan.stats.totalDistanceKm)} → {km(preview.stats.totalDistanceKm)}</dd>
        <dt>{t('inspector.cost')}</dt><dd>{plan.cost?money(plan.cost.total,plan.cost.currency):'—'} → {preview.cost?money(preview.cost.total,preview.cost.currency):'—'}</dd>
        <dt>{t('manual.vehiclesTrips')}</dt><dd>{preview.stats.vehiclesUsed} / {preview.stats.trips}</dd></dl>
      {!preview.validation.valid&&<div role="status" className="rounded bg-warning/10 p-2 text-warning">{t('manual.invalid')}
        <ul className="mt-1 list-inside list-disc">{preview.validation.violations.map((v,i)=><li key={i}>{violationDetail(v,t)}</li>)}</ul></div>}
    </section>}
    {error&&<p role="alert" className="text-sm text-destructive">{error}{attempted&&` ${t('manual.retry')}`}</p>}
    <div className="flex flex-wrap justify-end gap-2"><Button variant="outline" disabled={busy} onClick={onClose}>{t('manual.cancel')}</Button>
      <Button variant="outline" disabled={busy||attempted||!canEvaluate||!valid} onClick={()=>void calculate()}>{t('manual.calculate')}</Button>
      <Button disabled={busy||!preview||!canEdit} onClick={()=>void apply()}>{t(preview&&!preview.validation.valid?'manual.saveInvalid':'manual.apply')}</Button></div>
  </DialogContent></Dialog>;
}
