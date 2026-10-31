import {ChevronRight} from 'lucide-react';
import type {Plan,Selection,Vehicle} from '@/types';
import {selectionContext} from '@/lib/selection-context';
import {useT} from '@/i18n';

/** Same resolved identity in fleet, map and inspector; navigation never edits. */
export function SelectionTrail({plan,selection,fleet,onSelect}:{plan:Plan;selection:Selection;fleet?:Vehicle[];onSelect?:(selection:Selection)=>void}){
 const t=useT(),context=selectionContext(plan,selection,fleet);if(!context)return null;
 const vehicle=context.kind!=='unassigned'?context.vehicle:null;
 const trip=context.kind==='trip'||context.kind==='stop'?context.trip:null;
 const order=context.kind==='stop'||context.kind==='unassigned'?context.order:null;
 const duplicate=!!order&&[...plan.vehicles.flatMap(v=>v.trips.flatMap(tr=>tr.stops)),...plan.unassigned].filter(o=>o.orderNo===order.orderNo).length>1;
 const parts=[
  ...(vehicle?[{text:vehicle.ref,selection:{kind:'vehicle' as const,vehicleId:vehicle.id}}]:[{text:t('fleet.unassigned'),selection:null}]),
  ...(trip&&vehicle?[{text:t('fleet.tripLabel',{n:trip.index+1}),selection:{kind:'trip' as const,vehicleId:vehicle.id,tripIndex:trip.index}}]:[]),
  ...(order?[{text:`#${order.orderNo}${duplicate&&order.requestId!==undefined?` · ${t('interaction.deliveryId',{id:order.requestId})}`:''}`,selection:null}]:[]),
 ];
 return <nav aria-label={t('interaction.selection')} data-selection-kind={context.kind} data-selection-request-id={order?.requestId} data-selection-vehicle-id={vehicle?.id} data-selection-trip-index={trip?.index} className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-xs">
  {parts.map((part,i)=><span key={i} className="flex min-w-0 items-center gap-1">
   {i>0&&<ChevronRight aria-hidden className="h-3 w-3 shrink-0 text-muted-foreground"/>}
   {onSelect&&part.selection&&i<parts.length-1?<button type="button" onClick={()=>onSelect(part.selection)} className="max-w-full break-words rounded text-left font-medium hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">{part.text}</button>
    :<span aria-current={i===parts.length-1?'true':undefined} className="break-words font-medium">{part.text}</span>}
  </span>)}
 </nav>;
}
