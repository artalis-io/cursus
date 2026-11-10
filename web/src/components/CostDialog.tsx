import {useEffect,useRef,useState} from 'react';
import {Dialog,DialogContent,DialogHeader,DialogTitle} from '@/components/ui/dialog';
import {ScrollArea} from '@/components/ui/scroll-area';
import {Button} from '@/components/ui/button';
import {useI18n,useT} from '@/i18n';
import {api} from '@/lib/api';
import {validCostReview} from '@/lib/cost-review';
import {reviewComparison} from '@/lib/readiness';
import type {Plan,Scenario} from '@/types';
import type {CostReview,CostVehicleReview} from '../../../server/src/cost-review-contract';

export function CostDialog({open,onOpenChange,plan,scenario,reference}:{open:boolean;onOpenChange:(v:boolean)=>void;plan:Plan;scenario:Scenario;reference?:Plan}){
 const t=useT(),{lang}=useI18n(),[result,setResult]=useState<CostReview|null>(null),[error,setError]=useState(false),[loading,setLoading]=useState(false),[reload,setReload]=useState(0),generation=useRef(0);
 useEffect(()=>{
  const current=++generation.current,abort=new AbortController();setResult(null);setError(false);
  if(!open){setLoading(false);return()=>abort.abort();}setLoading(true);
  void api.costReview(plan.id,abort.signal).then(value=>{
   if(abort.signal.aborted||generation.current!==current)return;
   if(!validCostReview(value,plan))throw Error('Cost evidence does not match the saved plan');setResult(value);
  }).catch(()=>{if(!abort.signal.aborted&&generation.current===current)setError(true);}).finally(()=>{if(!abort.signal.aborted&&generation.current===current)setLoading(false);});
  return()=>abort.abort();
  // Immutable identity; geometry updates must not restart pricing requests.
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[open,plan.id,plan.scenarioId,plan.scenarioRevision,plan.provenance.inputSha256,scenario.revision,reload]);
 const num=(n:number)=>new Intl.NumberFormat(lang==='hu'?'hu-HU':'en-US',{maximumFractionDigits:20}).format(n);
 const money=(n:number|null|undefined,currency=plan.cost?.currency)=>n==null||!Number.isFinite(n)?t('costReview.unknown'):`${num(n)} ${currency==='HUF'?'Ft':currency??''}`;
 const comparison=reference&&reference.id!==plan.id&&reference.cost&&plan.cost?reviewComparison(reference,plan):null;
 const fleetProfile=plan.provenance.planningProfiles?.find(p=>p.kind==='fleet');
 const formula=(v:CostVehicleReview)=>{
  const r=v.rates!;
  if(result?.model==='per_vehicle')return <>
   <p>{t('costReview.fixed')}: {t('costReview.round')}({num(r.fixedBase)} × {num(r.multiplier)}) = {money(v.fixed)}</p>
   <p>{t('costReview.variable')}: {t('costReview.round')}({num(v.pricedDistanceKm)} km × {num(r.perKm)} × {num(r.multiplier)}) = {money(v.variable)}</p>
  </>;
  return <>
   <p>{t('costReview.tripBases')}: {t('costReview.round')}(Σ ({num(r.fixedBase)} {t('costReview.eachTrip')}) × {num(r.multiplier)}) = {money(v.fixed)}</p>
   <p>{t('costReview.variable')}: {t('costReview.round')}((Σ ({t('costReview.tripKm')} × {num(r.perKm)} + {t('costReview.extraStops')} × {num(r.perDrop)})) × {num(r.multiplier)}) = {money(v.variable)}</p>
   <p>{t('costReview.includedDrops',{n:r.includedDrops})}</p>
  </>;
 };
 return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-w-2xl">
  <DialogHeader><DialogTitle>{t('costReview.title')}</DialogTitle></DialogHeader>
  <ScrollArea className="max-h-[65vh]"><div className="space-y-4 pr-3 text-sm">
   <p className="text-xs text-muted-foreground break-all">{plan.id} · {t('costReview.revision',{n:plan.scenarioRevision})} · {plan.day}</p>
   <dl className="grid grid-cols-3 gap-2 rounded border border-divider p-3">
    {([['costReview.fixed',plan.cost?.fixed],['costReview.variable',plan.cost?.variable],['costReview.total',plan.cost?.total]] as const).map(([key,value])=><div key={key}><dt className="text-xs text-muted-foreground">{t(key)}</dt><dd className="tnum font-semibold break-words" data-cost-summary={key.split('.').slice(-1)[0]}>{money(value)}</dd></div>)}
   </dl>
   <p className="text-xs text-muted-foreground">{t('costReview.savedOnly')}</p>
   {(scenario.id!==plan.scenarioId||scenario.revision!==plan.scenarioRevision||result?.currentScenarioRevision!=null&&result.currentScenarioRevision!==plan.scenarioRevision)&&<p role="status" className="rounded border border-warning/40 bg-warning/10 p-2">{t('costReview.scenarioChanged')}</p>}
   {loading&&<p role="status">{t('costReview.loading')}</p>}
   {error&&<p role="alert" className="rounded border border-destructive/30 p-2">{t('costReview.error')}</p>}
   {result&&<>
    <section aria-label={t('costReview.evidence')} className="space-y-1 rounded border border-divider p-3 text-xs">
     <h3 className="font-semibold">{t('costReview.evidence')}</h3>
     <p>{t(`costReview.status.${result.status}`)} · {t(`costReview.source.${result.source??'unknown'}`)}</p>
     <p>{t(`costReview.evidence.${result.evidence}`)}</p>
     <p>{t('costReview.tariffId')}: <span className="break-all">{result.tariffSha256??t('costReview.unknown')}</span></p>
     {fleetProfile&&<p className="break-all">{t('costReview.profile')}: {fleetProfile.id} · {t('costReview.revision',{n:fleetProfile.revision})}</p>}
     <p data-tariff-freshness={result.tariffFreshness}>{t(`costReview.freshness.${result.tariffFreshness}`)}</p>
     {result.issues.map(i=><p key={i} className="text-warning">{t(`costReview.issue.${i}`)}</p>)}
    </section>
    {result.status==='verified'&&<p className="text-xs text-muted-foreground">{t(`costReview.model.${result.model!}`)} {t('costReview.rounding')}</p>}
    {result.vehicles.map(v=><details key={v.vehicleId} data-cost-vehicle={v.vehicleId} className="rounded border border-divider p-3">
     <summary className="cursor-pointer break-words font-semibold">{v.ref} · {money(v.total)}</summary>
     <div className="mt-2 space-y-2 text-xs">
      <p className="tnum">{t('costReview.fixed')}: {money(v.fixed)} + {t('costReview.variable')}: {money(v.variable)} = {money(v.total)}</p>
      {v.rates&&<div className="space-y-1 break-words rounded bg-muted p-2" data-cost-formula><p>{t('costReview.rateClass')}: {v.rates.vehicleClass??t('costReview.unknown')} · {t(v.rates.isSubcontractor?'costReview.subcontractor':'costReview.ownFleet')}</p><p>{t('costReview.distanceRate')}: {money(v.rates.perKm)} / km</p>{formula(v)}</div>}
      <p className="text-muted-foreground">{t('costReview.allocation')}</p>
      {v.trips.map(trip=><div key={trip.index} data-cost-trip={trip.index} className="rounded border border-divider p-2">
       <p className="font-medium">{t('fleet.tripLabel',{n:trip.index+1})} · {money(trip.allocatedTotal)}</p>
       <p>{num(trip.pricedDistanceKm)} km · {t('costReview.stops',{n:trip.drops})}{trip.extraDrops!=null&&` · ${t('costReview.extraStops')}: ${num(trip.extraDrops)}`}</p>
       {trip.referenceEstimate!=null&&<p className="tnum">{t('costReview.referenceEstimate')}: {money(trip.referenceEstimate)} · {t('costReview.adjustment')}: {money(trip.allocationAdjustment)}</p>}
      </div>)}
     </div>
    </details>)}
   </>}
   {comparison&&reference&&<section aria-label={t('costReview.comparison')} className="space-y-1 rounded border border-divider p-3 text-xs">
    <h3 className="font-semibold">{t('costReview.comparison')}</h3><p className="break-all">{reference.id} → {plan.id}</p>
    <p>{money(reference.cost!.total,reference.cost!.currency)} → {money(plan.cost!.total)} · Δ {reference.cost!.currency===plan.cost!.currency?money(plan.cost!.total-reference.cost!.total):t('costReview.unknown')}</p>
    <p>{t('costReview.factors',{vehicles:plan.stats.vehiclesUsed-reference.stats.vehiclesUsed,trips:plan.stats.trips-reference.stats.trips,km:num(plan.stats.totalDistanceKm-reference.stats.totalDistanceKm),served:plan.stats.servedOrders-reference.stats.servedOrders})}</p>
    {!comparison.improvementEligible&&<p className="text-warning">{t('costReview.notComparable')}</p>}
   </section>}
  </div></ScrollArea>
  <div className="flex justify-end gap-2"><Button variant="outline" size="sm" onClick={()=>setReload(x=>x+1)} disabled={loading}>{t(error?'costReview.retry':'costReview.refresh')}</Button><Button size="sm" onClick={()=>onOpenChange(false)}>{t('costReview.close')}</Button></div>
 </DialogContent></Dialog>;
}
