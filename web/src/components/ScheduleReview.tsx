import {useMemo,useState} from 'react';
import {useT,useI18n} from '@/i18n';
import {hhmm} from '@/lib/format';
import {blockerSelection} from '@/lib/review-targets';
import {scheduleReview,departureDelay,type ScheduleTarget} from '../../../server/src/schedule-review';
import type {Plan,Scenario,Selection} from '@/types';

/** Local, bounded, saved-plan analysis only. No network, writes or solver jobs. */
export function ScheduleReview({plan,scenario,pending,onSelect}:{plan:Plan;scenario:Scenario;pending:boolean;onSelect?:(s:Selection)=>void}){
 const t=useT(),{lang}=useI18n(),[delay,setDelay]=useState<0|900|1800>(0),[all,setAll]=useState(false),[count,setCount]=useState(25);
 const review=useMemo(()=>scheduleReview(plan),[plan]);
 const result=useMemo(()=>delay?departureDelay(plan,delay):null,[plan,delay]);
 const number=(n:number)=>new Intl.NumberFormat(lang==='hu'?'hu-HU':'en-US',{maximumFractionDigits:1}).format(n);
 const minutes=(n:number|null)=>n===null?t('schedule.unknown'):`${number(n/60)} ${t('fleetUse.minutes')}`;
 const slack=(n:number|null)=>n===null?t('schedule.unknown'):Math.abs(n)>0&&Math.abs(n)<1?t('schedule.lessSecond',{sign:n<0?'−':'+'}):Math.abs(n)<60?`${number(n)} ${t('schedule.seconds')}`:minutes(n);
 const clock=(n:number)=>Number.isFinite(n)&&n>=0?hhmm(n):t('schedule.unknown');
 const target=(row:ScheduleTarget)=>blockerSelection(plan,{kind:'stop',...row});
 const link=(row:ScheduleTarget,label:string)=>{
  const selection=target(row);return onSelect&&selection?<button type="button" className="text-left underline underline-offset-2" onClick={()=>onSelect(selection)}>{label}</button>:<span>{label}</span>;
 };
 const rows=(all?review.rows:review.rows.filter(r=>r.state!=='over30')).slice(0,count),total=all?review.rows.length:review.rows.filter(r=>r.state!=='over30').length;
 return <details className="min-w-0 rounded border border-divider p-3 md:col-span-2 xl:col-span-3" data-schedule-review>
  <summary className="cursor-pointer font-semibold">{t('schedule.title')} · {t('schedule.tightSummary',{n:review.within30})} · {t('schedule.lateSummary',{n:review.late})}{review.unknown>0&&` · ${t('schedule.unknownSummary',{n:review.unknown})}`}</summary>
  <div className="mt-3 space-y-3">
   <p className="break-all text-muted-foreground">{plan.id} · {t('costReview.revision',{n:plan.scenarioRevision})}</p>
   <p>{t('schedule.rule')}</p><p className="text-muted-foreground">{t('schedule.scope')}</p>
   {(pending||scenario.id!==plan.scenarioId||scenario.revision!==plan.scenarioRevision)&&<p role="status" className="text-warning">{t('schedule.stale')}</p>}
   <p>{t('schedule.counts',{n:review.rows.length,waiting:review.waiting,unknown:review.unknown})}</p>
   <button type="button" className="underline" onClick={()=>{setAll(!all);setCount(25);}}>{t(all?'schedule.showTight':'schedule.showAll')}</button>
   {rows.length===0&&<p>{t(review.rows.length?'schedule.noTight':'schedule.noStops')}</p>}
   <ol className="max-h-64 space-y-2 overflow-y-auto" aria-label={t('schedule.ranked')}>
    {rows.map((row,i)=><li key={`${row.vehicleId}/${row.tripIndex}/${row.seq}/${i}`} data-schedule-stop={`${row.vehicleId}/${row.tripIndex}/${row.seq}`} className="space-y-1 break-words rounded border border-divider p-2">
     <p className="font-medium">{link(row,`${row.orderNo}${row.customer?` · ${row.customer}`:''}${row.requestId!==undefined?` · ${t('review.delivery',{id:row.requestId})}`:''}`)}</p>
     <p>{row.vehicleRef} · {t('fleet.tripLabel',{n:row.tripIndex+1})} · {t(`schedule.state.${row.state}`)}</p>
     <p className="tnum">{t('schedule.arrival')}: {clock(row.arrivalSec)} · {t('schedule.serviceStart')}: {clock(row.serviceStartSec)} · {t('schedule.deadline')}: {row.state==='unknown'?t('schedule.unknown'):clock(row.deadlineSec)}</p>
     <p className="tnum" data-schedule-slack>{t('schedule.slack')}: {slack(row.seconds)} · {t('schedule.waiting')}: {minutes(row.waitingSec)}</p>
    </li>)}
   </ol>
   {rows.length<total&&<button type="button" className="underline" onClick={()=>setCount(count+25)}>{t('schedule.more',{n:total-rows.length})}</button>}
   <section className="space-y-2 border-t border-divider pt-3" aria-label={t('schedule.delayTitle')}>
    <h4 className="font-semibold">{t('schedule.delayTitle')}</h4><p className="text-muted-foreground">{t('schedule.delayScope')}</p>
    <div className="flex flex-wrap gap-2">{([900,1800] as const).map(seconds=><button key={seconds} type="button" aria-pressed={delay===seconds} className="rounded border border-divider px-2 py-1 hover:bg-accent" onClick={()=>setDelay(seconds)}>{t('schedule.checkDelay',{n:seconds/60})}</button>)}
     {!!delay&&<button type="button" className="underline" onClick={()=>setDelay(0)}>{t('schedule.clear')}</button>}
    </div>
    {result&&<div role="status" data-delay-review={result.seconds} className="space-y-2">
     <p className="font-medium">{t('schedule.delayCounts',{new:result.newlyLate,total:result.late,unknown:result.unknownVehicles})}</p>
     <p>{t('schedule.limitCounts',{shift:result.shiftBreaches,duration:result.durationBreaches})}</p>
     <p className="text-muted-foreground">{t('schedule.limitScope')}</p>
     {result.vehicles.length===0&&<p>{t('schedule.noStops')}</p>}
     <div className="max-h-64 space-y-2 overflow-y-auto">{result.vehicles.map((v,i)=><details key={`${v.vehicleId}/${i}`} data-delay-vehicle={v.vehicleId} className="rounded border border-divider p-2">
      <summary className="cursor-pointer break-words font-medium">{v.ref} · {v.reason?t('schedule.unknown'):t('schedule.vehicleLate',{n:v.stops.filter(s=>s.slackSec<0).length})}</summary>
      <div className="mt-2 space-y-1">
       {v.reason?<p>{t(`schedule.reason.${v.reason}`)}</p>:<>
        <p>{t('schedule.finalReturn')}: {clock(v.finishSec!)}</p>
        {(['shift','duration'] as const).map(key=><p key={key}>{t(`schedule.limit.${key}`)}: {v[key]?key==='shift'?`${clock(v[key]!.baseline)} → ${clock(v[key]!.delayed)} / ${clock(v[key]!.limit)}`:`${minutes(v[key]!.baseline)} → ${minutes(v[key]!.delayed)} / ${minutes(v[key]!.limit)}`:t('schedule.unknown')}</p>)}
        <p className="text-muted-foreground">{t('schedule.minutesNote')}</p>
        {v.stops.map((s,index)=><p key={`${s.tripIndex}/${s.seq}/${index}`} data-delay-stop={`${v.vehicleId}/${s.tripIndex}/${s.seq}`} className="break-words">{link(s,`${s.orderNo}${s.requestId!==undefined?` · ${t('review.delivery',{id:s.requestId})}`:''}`)} · {t(s.slackSec>=0?'schedule.notPastClosing':s.newlyLate?'schedule.newlyLate':'schedule.alreadyLate')}<br/>{t('schedule.serviceChange')}: {clock(s.baselineServiceStartSec)} → {clock(s.serviceStartSec)} · {t('schedule.slack')}: {slack(s.baselineSlackSec)} → {slack(s.slackSec)}</p>)}
       </>}
      </div>
     </details>)}</div>
    </div>}
   </section>
  </div>
 </details>;
}
