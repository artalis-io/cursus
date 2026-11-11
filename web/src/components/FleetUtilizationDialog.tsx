import {violationDetail} from '@/lib/violations';
import {useMemo} from 'react';
import {hhmm} from '@/lib/format';
import {Dialog,DialogContent,DialogHeader,DialogTitle} from '@/components/ui/dialog';
import {ScrollArea} from '@/components/ui/scroll-area';
import {Button} from '@/components/ui/button';
import {useI18n,useT} from '@/i18n';
import {fleetUtilization,type LoadUse,type TimeUse} from '../../../server/src/fleet-utilization';
import type {Plan,Scenario,Selection} from '@/types';

export function FleetUtilizationDialog({open,onOpenChange,plan,scenario,onSelect}:{open:boolean;onOpenChange:(v:boolean)=>void;plan:Plan;scenario:Scenario;onSelect:(s:Selection)=>void}){
 const t=useT(),{lang}=useI18n();
 // Road geometry can arrive after the saved plan; it is not utilization evidence.
 const report=useMemo(()=>fleetUtilization(plan),[plan]);
 const num=(n:number|null|undefined,decimals=1)=>n==null||!Number.isFinite(n)?t('fleetUse.unknown'):new Intl.NumberFormat(lang==='hu'?'hu-HU':'en-US',{maximumFractionDigits:decimals}).format(n);
 const duration=(n:number|null|undefined)=>n==null?t('fleetUse.unknown'):`${num(n/60,1)} ${t('fleetUse.minutes')}`;
 const percent=(n:number|null|undefined)=>n==null?t('fleetUse.unknown'):`${num(n)}%`;
 const clock=(n:number|null|undefined)=>n==null?t('fleetUse.unknown'):hhmm(n);
 const occupancy=(v:LoadUse|null,unit:string)=>v?`${num(v.peak)} / ${num(v.capacity)} ${unit} · ${percent(v.percent)}`:t('fleetUse.unknown');
 const time=(v:TimeUse)=> <dl className="grid grid-cols-2 gap-x-3 gap-y-1 tnum">
  <dt>{t('fleetUse.driving')}</dt><dd>{duration(v.driving)}</dd><dt>{t('fleetUse.service')}</dt><dd>{duration(v.service)}</dd>
  <dt>{t('fleetUse.waiting')}</dt><dd>{duration(v.waiting)}</dd><dt>{t('fleetUse.elapsed')}</dt><dd>{duration(v.elapsed)}</dd>
 </dl>;
 const inspect=(selection:Selection)=>{onOpenChange(false);onSelect(selection);};
 const unused=report.vehicles.filter(v=>!v.used);
 return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-w-2xl">
  <DialogHeader><DialogTitle>{t('fleetUse.title')}</DialogTitle></DialogHeader>
  <ScrollArea className="max-h-[65vh]"><div className="space-y-4 pr-3 text-sm" data-fleet-utilization>
   <p className="break-all text-xs text-muted-foreground">{plan.id} · {t('costReview.revision',{n:plan.scenarioRevision})} · {plan.day}</p>
   <p className="text-xs text-muted-foreground">{t('fleetUse.savedOnly')}</p>
   <dl className="grid grid-cols-2 gap-2 rounded border border-divider p-3 sm:grid-cols-4">
    {([['used',plan.stats.vehiclesUsed],['unused',report.unusedAvailable],['excluded',report.excluded],['unavailable',report.unavailable]] as const).map(([key,n])=><div key={key}>
     <dt className="text-xs text-muted-foreground">{t(`fleetUse.${key}`)}</dt><dd className="tnum break-words font-semibold" data-fleet-count={key}>{num(n,0)}</dd>
    </div>)}
   </dl>
   {report.inventory!=='complete'&&<p role="status" data-fleet-inventory={report.inventory} className="rounded border border-warning/40 bg-warning/10 p-2 text-xs">{t(report.inventory==='invalid'?'fleetUse.invalidInventory':'fleetUse.missingInventory')}</p>}
   {!report.kpisMatch&&<p role="alert" className="rounded border border-warning/40 p-2 text-xs">{t('fleetUse.kpiMismatch')}</p>}
   {(scenario.id!==plan.scenarioId||scenario.revision!==plan.scenarioRevision)&&<p role="status" className="rounded border border-warning/40 bg-warning/10 p-2 text-xs">{t('fleetUse.stale')}</p>}
   <p className="text-xs text-muted-foreground">{t('fleetUse.limitNote')}</p>
   {report.vehicles.filter(v=>v.used).map((v,i)=><details key={`${v.id}/${i}`} data-fleet-use-vehicle={v.id} className="rounded border border-divider p-3">
    <summary className="cursor-pointer break-words font-semibold">{v.ref} · {t('fleetUse.tripCount',{n:v.trips.length})} · {t('fleetUse.payload')}: {percent(v.kg?.percent)}</summary>
    <div className="mt-3 space-y-3 text-xs">
     <p className="tnum" data-fleet-peak="kg">{t('fleetUse.peakPayload')}: {occupancy(v.kg,'kg')}</p>
     <p className="tnum" data-fleet-peak="pallets">{t('fleetUse.peakPallets')}: {occupancy(v.pallets,t('fleetUse.palletUnit'))}</p>
     <p className="tnum">{t('fleetUse.remainingPayload')}: {v.kg?.remaining==null?t('fleetUse.unknown'):`${num(v.kg.remaining)} kg`} · {t('fleetUse.remainingPallets')}: {num(v.pallets?.remaining)}</p>
     <p>{t('fleetUse.peakNote')}</p>
     {v.issues.map(issue=><p key={issue} role="status" className="text-warning">{t(`fleetUse.issue.${issue}`)}</p>)}
     <section aria-label={t('fleetUse.time')} className="space-y-1 rounded bg-muted p-2">
      <h3 className="font-semibold">{t('fleetUse.time')}</h3>
      {v.time?<>{time(v.time)}<p className="tnum">{t('fleetUse.between')}: {duration(v.time.betweenTrips)}</p></>:<p>{t('fleetUse.unknown')}</p>}
      <p className="text-muted-foreground">{t('fleetUse.timeNote')}</p>
     </section>
     <section aria-label={t('fleetUse.headroom')} className="space-y-1 rounded border border-divider p-2">
      <h3 className="font-semibold">{t('fleetUse.headroom')}</h3>
      <p>{t('fleetUse.shiftBounds')}: {clock(v.limits?.shiftStartSec)} — {clock(v.limits?.shiftEndSec)}</p>
      <dl className="grid grid-cols-2 gap-1 tnum">
       <dt>{t('fleetUse.remainingShift')}</dt><dd data-fleet-headroom="shift">{duration(v.remainingShiftSec)}</dd>
       <dt>{t('fleetUse.remainingDuration')}</dt><dd>{duration(v.remainingDurationSec)}</dd>
       <dt>{t('fleetUse.remainingDistance')}</dt><dd>{v.remainingDistanceKm==null?t('fleetUse.unknown'):`${num(v.remainingDistanceKm)} km`}</dd>
       <dt>{t('fleetUse.remainingTrips')}</dt><dd>{num(v.remainingTrips,0)}</dd>
       <dt>{t('fleetUse.requiredReload')}</dt><dd>{duration(v.limits?.reloadSec)}</dd>
      </dl>
     </section>
     {v.violations.length>0&&<div className="rounded border border-warning/40 p-2"><p className="font-semibold">{t('fleetUse.recordedBlockers')}</p>{plan.provenance.validation.violations.filter(flag=>flag.vehicle_id===v.id).map((flag,index)=><p className="break-words" key={index}>{t(flag.soft?'issues.advisories':'issues.hard')}: {violationDetail(flag,t)}</p>)}</div>}
     <Button size="sm" variant="outline" onClick={()=>inspect({kind:'vehicle',vehicleId:v.id})} aria-label={t('fleetUse.inspectVehicleNamed',{ref:v.ref})}>{t('fleetUse.inspectVehicle')}</Button>
     {v.trips.map(trip=><section key={trip.index} data-fleet-use-trip={trip.index} className="space-y-1 rounded border border-divider p-2">
      <h4 className="font-semibold">{t('fleet.tripLabel',{n:trip.index+1})}</h4>
      <p className="tnum">{t('fleetUse.payload')}: {occupancy(trip.kg,'kg')}</p><p className="tnum">{t('fleetUse.pallets')}: {occupancy(trip.pallets,t('fleetUse.palletUnit'))}</p>
      {trip.time?time(trip.time):<p>{t('fleetUse.issue.schedule')}</p>}
      <Button size="sm" variant="ghost" onClick={()=>inspect({kind:'trip',vehicleId:v.id,tripIndex:trip.index})} aria-label={t('fleetUse.inspectTripNamed',{ref:v.ref,n:trip.index+1})}>{t('fleetUse.inspectTrip')}</Button>
     </section>)}
    </div>
   </details>)}
   {unused.length>0&&<details className="rounded border border-divider p-3" data-fleet-unused><summary className="cursor-pointer font-semibold">{t('fleetUse.unusedList',{n:unused.length})}</summary>
    <p className="mt-2 text-xs text-muted-foreground">{t('fleetUse.unusedNote')}</p>
    <ul className="mt-2 space-y-1 text-xs">{unused.map(v=><li key={v.id} className="break-words" data-fleet-unused-vehicle={v.id}>{v.ref} · {t(`fleetUse.availability.${v.availability}`)}</li>)}</ul>
   </details>}
  </div></ScrollArea>
  <div className="flex justify-end"><Button variant="outline" onClick={()=>onOpenChange(false)}>{t('costReview.close')}</Button></div>
 </DialogContent></Dialog>;
}
