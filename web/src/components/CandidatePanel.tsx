import {useState} from 'react';
import {useI18n} from '@/i18n';
import type {Plan} from '@/types';
import {deliveryComparison} from '../../../server/src/plan/identity';
export function CandidatePanel({plan,reference,busy,canAdopt,onAdopt,onKeep,onCompare}:{plan:Plan;reference:Plan;busy:boolean;canAdopt:boolean;onAdopt:(ack:boolean)=>void;onKeep:()=>void;onCompare:()=>void}){
 const {lang}=useI18n(),hu=lang==='hu',[ack,setAck]=useState(false);
 const incomplete=plan.unassigned.length>0,loss=deliveryComparison(reference,plan).lostService;
 return <section aria-label={hu?'Tervjelölt':'Plan candidate'} className="shrink-0 border-b border-warning/40 bg-warning/10 px-4 py-2 text-sm">
  <strong>{hu?'Új tervjelölt — a korábbi terv maradt megnyitva.':'New candidate — the previous plan is still displayed.'}</strong>
  <p className="text-xs">{reference.stats.servedOrders}/{reference.stats.totalOrders} → {plan.stats.servedOrders}/{plan.stats.totalOrders} · {hu?'A kiválasztás nem jelent jóváhagyást.':'Choosing a result does not approve it.'}</p>
  {loss&&<p className="text-xs font-medium text-warning">{hu?'A jelölt kevesebb rendelést szolgál ki.':'The candidate serves fewer orders.'}</p>}
  <div className="mt-2 flex flex-wrap items-center gap-3">
   <button type="button" onClick={onCompare} className="underline">{hu?'Összehasonlítás':'Compare candidate'}</button>
   <button type="button" disabled={busy} onClick={onKeep} className="rounded border px-2 py-1">{hu?'Korábbi terv megtartása':'Keep previous'}</button>
   {canAdopt&&<>
    {incomplete&&<label className="text-xs"><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/> {hu?'Tudomásul veszem a ki nem szolgált rendeléseket.':'I acknowledge the unassigned orders.'}</label>}
    <button type="button" disabled={busy||incomplete&&!ack} onClick={()=>onAdopt(ack)} className="rounded border border-primary px-2 py-1 disabled:opacity-40">{hu?'Jelölt használata':'Use candidate'}</button>
   </>}
  </div>
 </section>;
}
