import {useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {useI18n,describeApiError} from '@/i18n';
import {api,ApiError} from '@/lib/api';
import {km,money} from '@/lib/format';
import {operatingSummary} from '@/lib/operating-limits';
import type {Plan,Scenario} from '@/types';
import type {OperatingLimits,ProfileRef} from '../../../server/src/planning-profile-contract';
import type {ProfileChangeIntent,ProfileChangePreview} from '../../../server/src/profile-change-contract';

export function ReviewedProfileChange({plan,scenario,profiles,blocked,onCreated,onBusyChange}:{plan:Plan;scenario:Scenario;profiles:ProfileRef[];blocked:boolean;onCreated:(plan:Plan)=>void;onBusyChange:(busy:boolean)=>void}){
 const {lang,t}=useI18n(),hu=lang==='hu';
 const [intent,setIntent]=useState<ProfileChangeIntent>(()=>({operationId:crypto.randomUUID(),parentPlanId:plan.id,profiles,reason:'',releaseRequestIds:[],unlockVehicleIds:[],clearVehicleOverrideIds:[],acknowledgeInvalid:false}));
 const [preview,setPreview]=useState<ProfileChangePreview|null>(null),[options,setOptions]=useState<ProfileChangePreview['options']|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[confirmed,setConfirmed]=useState(false);
 const alive=useRef(true),permission=useRef(!blocked);permission.current=!blocked;
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;onBusyChange(false);};},[onBusyChange]);
 function change(patch:Partial<ProfileChangeIntent>){setIntent(i=>({...i,...patch}));setPreview(null);setConfirmed(false);setError(null);}
 const toggle=(key:'releaseRequestIds'|'unlockVehicleIds'|'clearVehicleOverrideIds',id:number,checked:boolean)=>change({[key]:checked?[...intent[key],id]:intent[key].filter(v=>v!==id)});
 async function run(apply=false){
  if(busy||blocked||!alive.current)return;setBusy(true);onBusyChange(true);setError(null);
  try{
   if(apply){if(!preview||!confirmed||preview.conflicts.length||!preview.validation||!preview.validation.valid&&!intent.acknowledgeInvalid)return;
    const value=await api.profileChangeApply(scenario,intent,preview.previewSha256);if(alive.current&&permission.current)onCreated(value.plan);
   }else{const value=await api.profileChangePreview(scenario,intent);if(alive.current&&permission.current){setPreview(value);setOptions(value.options);}}
  }catch(e){if(alive.current){setError(describeApiError(e,t));if(e instanceof ApiError&&e.status===409){setPreview(null);setConfirmed(false);}}}finally{if(alive.current){setBusy(false);onBusyChange(false);}}
 }
 const label=(field:string)=>({capacityKg:hu?'Teherbírás (kg)':'Payload (kg)',capacityPallets:hu?'Raklapkapacitás':'Pallet capacity',grossWeightTonnes:hu?'Össztömeg (t)':'GVW (t)',tailLift:hu?'Emelőhátfal':'Tail-lift',available:hu?'Elérhető':'Available',reloadSeconds:hu?'Újrarakodás (s)':'Reload (s)',vehicleClass:hu?'Kategória':'Class',subcontractor:hu?'Alvállalkozó':'Subcontractor',operatingLimits:hu?'Üzemeltetési korlátok':'Operating limits',shiftStartSeconds:hu?'Műszakkezdés (s)':'Shift start (s)',shiftEndSeconds:hu?'Műszak vége (s)':'Shift end (s)',maxTrips:hu?'Max. fordulók':'Max trips',maxDistanceKm:hu?'Max. km':'Max km',maxDurationSeconds:hu?'Max. időtartam (s)':'Max duration (s)',openingSeconds:hu?'Nyitás (s)':'Opening (s)',deadlineSeconds:hu?'Határidő (s)':'Deadline (s)',serviceSeconds:hu?'Kiszolgálás (s)':'Service (s)',maxGrossWeightTonnes:hu?'Behajtási össztömeg (t)':'Access GVW (t)',tailLiftRequired:hu?'Emelőhátfal szükséges':'Tail-lift required',currency:hu?'Pénznem':'Currency',model:hu?'Díjmodell':'Charging model',source:hu?'Forrás':'Source',perKmDefault:hu?'Alap km-díj':'Default rate / km',fixedPerVehicle:hu?'Fix járműdíj':'Fixed / vehicle',perTripBase:hu?'Alap fuvardíj':'Base / trip',perKm:hu?'Km-díj':'Rate / km',perDrop:hu?'Lerakódíj':'Rate / drop',includedDrops:hu?'Beépített lerakók':'Included drops',perKmByClass:hu?'Km-díj kategóriánként':'Rate / km by class',fixedByClass:hu?'Fix díj kategóriánként':'Fixed rate by class',subcontractorMultiplier:hu?'Alvállalkozói szorzó':'Subcontractor multiplier',ownFleetMultiplier:hu?'Saját flotta szorzó':'Own-fleet multiplier'} as Record<string,string>)[field]??field;
 const value=(field:string,v:unknown):string=>v==null?(hu?'Ismeretlen / forrás szerint':'Unknown / source'):field==='operatingLimits'?operatingSummary(v as OperatingLimits,hu):typeof v==='boolean'?(v?(hu?'Igen':'Yes'):(hu?'Nem':'No')):typeof v==='object'?Object.entries(v).map(([k,x])=>`${k}: ${String(x)}`).join('; '):String(v);
 const totals=preview?.stats?[
  [hu?'Kiszolgált rendelések':'Served orders',`${plan.stats.servedOrders} / ${plan.stats.totalOrders}`,`${preview.stats.servedOrders} / ${preview.stats.totalOrders}`],
  [hu?'Kiosztatlan':'Unassigned',String(plan.unassigned.length),String(preview.stats.unassignedOrders)],
  [hu?'Járművek':'Vehicles',String(plan.stats.vehiclesUsed),String(preview.stats.vehiclesUsed)],
  [hu?'Fordulók':'Trips',String(plan.stats.trips),String(preview.stats.trips)],
  [hu?'Távolság':'Distance',km(plan.stats.totalDistanceKm),km(preview.stats.totalDistanceKm)],
  [hu?'Becsült költség':'Estimated cost',plan.cost?money(plan.cost.total,plan.cost.currency):'—',preview.cost?money(preview.cost.total,preview.cost.currency):'—']
 ]:[];
 return <details data-profile-change className="space-y-3 rounded border p-3 text-sm">
  <summary className="cursor-pointer font-semibold">{hu?'Meglévő tervezés megőrzése új profilokkal':'Preserve current planning with new profiles'}</summary>
  <p>{hu?'Az új tervezet megőrzi a kiosztásokat és a sorrendet. Az eredeti terv és jóváhagyása változatlan marad. Nincs automatikus optimalizálás vagy adatküldés.':'The new draft preserves assignments and stop order. The original plan and its approval remain unchanged. Nothing is optimized or sent automatically.'}</p>
  {blocked&&<p role="status">{hu?'Előbb fejezze be a folyamatban lévő műveleteket, és nyisson aktuális tervet.':'Finish pending operations and open the current plan first.'}</p>}
  {error&&<p role="alert" className="text-destructive">{error}</p>}
  <fieldset disabled={busy||blocked} className="space-y-3">
   <label className="block">{hu?'Profilváltás indoka':'Profile change reason'}<input required maxLength={500} className="mt-1 w-full rounded border bg-background p-1" value={intent.reason} onChange={e=>change({reason:e.target.value})}/></label>
   {options&&<details className="space-y-2"><summary className="cursor-pointer">{hu?'Döntések feloldása az új tervezetben':'Release decisions in the new draft'}</summary>
    <p className="text-xs text-muted-foreground">{hu?'Semmi sem oldódik fel automatikusan. A kiosztás feloldása önmagában nem helyezi át a rendelést; az újratervezést teszi szabaddá.':'Nothing is released automatically. Releasing an assignment leaves its current placement intact and frees it for Replan.'}</p>
    <div className="max-h-48 space-y-2 overflow-auto">
     {options.decisions.map(o=><label key={`d${o.requestId}`} className="block"><input type="checkbox" checked={intent.releaseRequestIds.includes(o.requestId)} onChange={e=>toggle('releaseRequestIds',o.requestId,e.target.checked)}/> {hu?'Döntés feloldása':'Release decision'}: {o.label} · {o.requestId}</label>)}
     {options.routes.map(o=><label key={`r${o.vehicleId}`} className="block"><input type="checkbox" checked={intent.unlockVehicleIds.includes(o.vehicleId)} onChange={e=>toggle('unlockVehicleIds',o.vehicleId,e.target.checked)}/> {hu?'Sorrend / zárolás feloldása':'Release route order / lock'}: {o.label}</label>)}
     {options.overrides.map(o=><label key={`v${o.vehicleId}`} className="block"><input type="checkbox" checked={intent.clearVehicleOverrideIds.includes(o.vehicleId)} onChange={e=>toggle('clearVehicleOverrideIds',o.vehicleId,e.target.checked)}/> {hu?'Szcenárió-korlátok törlése':'Clear scenario overrides'}: {o.label}</label>)}
    </div>
   </details>}
   <Button variant="outline" disabled={busy||blocked||!intent.reason.trim()} onClick={()=>void run()}>{hu?'Profilváltás előnézete':'Preview profile changes'}</Button>
   {preview&&<div className="space-y-3" data-profile-change-preview>
    <p className="text-xs">{hu?'Megőrzött kiosztások':'Preserved assignments'}: {preview.retained.assignments} · {hu?'Döntések':'Decisions'}: {preview.retained.decisions} · {hu?'Zárolt járművek':'Locked vehicles'}: {preview.retained.lockedVehicles}</p>
    <details open><summary className="cursor-pointer">{hu?'Beállítások változásai':'Settings changes'} ({preview.changes.length})</summary><ul className="max-h-48 space-y-1 overflow-auto break-words text-xs">{preview.changes.map((c,i)=><li key={i}>{c.kind==='tariff'?(hu?'Díjszabás':'Rate card'):c.label} · {label(c.field)}: {value(c.field,c.before)} → {value(c.field,c.after)}</li>)}</ul></details>
    {preview.conflicts.map((c,i)=><p key={i} role="alert" data-profile-conflict={c.code} className="rounded border border-warning p-2 text-xs">{c.vehicleId!==undefined?`${hu?'Jármű':'Vehicle'} ${c.vehicleId} · `:''}{c.requestId!==undefined?`${hu?'Rendelés':'Delivery'} ${c.requestId} · `:''}{hu?({override:'A szcenárió-korlát meghaladja az új profilt. Törölje kifejezetten vagy válasszon másik profilt.',locked_route:'Az új beállítások zárolt útvonalat sértenek. Oldja fel a sorrendet / zárolást vagy álljon meg.',retained_decision:'Megőrzött döntést érint az új korlát. Oldja fel kifejezetten az újratervezéshez vagy válasszon másik beállítást.',downstream_commitment:'Előbb rendezze vagy vonja vissza a folyamatban lévő / elfogadott adatátadást.'})[c.code]:c.message}</p>)}
    {!preview.stats&&<p>{hu?'Az összesített előnézethez előbb rendezze a szcenárió-korlátok konfliktusait.':'Resolve override conflicts before totals can be evaluated.'}</p>}
    {!!totals.length&&<><p className="text-xs text-muted-foreground">{hu?'Mentett jelenlegi értékek és újraszámolt tervezet, azonos kiosztásokkal. A költségváltozás új díjszabásból is eredhet.':'Saved current totals versus a recalculated draft with the same placements. A cost change may come from different rates.'}</p><table className="w-full text-xs tnum"><thead><tr><th className="text-left">{hu?'Mutató':'Metric'}</th><th>{hu?'Jelenlegi':'Current'}</th><th>{hu?'Új tervezet':'New draft'}</th></tr></thead><tbody>{totals.map(([name,before,after])=><tr key={name}><th className="text-left font-normal">{name}</th><td className="text-center">{before}</td><td className="text-center">{after}</td></tr>)}</tbody></table></>}
    {preview.validation&&!preview.validation.valid&&<p role="status" className="text-warning">{hu?'A tervezet nem érvényes. Jóváhagyás előtt rendezze a jelzett problémákat és szükség esetén tervezzen újra.':'This draft is not valid. Resolve the reported issues and Replan where needed before approval.'}</p>}
    {preview.validation?.violations.map((v,i)=><p className="text-xs" key={i}>{v.type} · {hu?'Jármű':'Vehicle'} {v.vehicle_id??'—'}{v.request_id!==undefined?` · ${v.request_id}`:''}{v.actual!==undefined?` · ${v.actual} / ${v.limit??'—'}`:''}</p>)}
    {preview.physicalLoadingPending&&<p className="text-xs">{hu?'A fizikai rakodást újra kell ellenőrizni az újratervezéssel.':'Replan must recertify physical loading.'}</p>}
   </div>}
   {(preview?.validation?.valid===false||intent.acknowledgeInvalid)&&<label className="block text-xs"><input type="checkbox" checked={intent.acknowledgeInvalid} onChange={e=>change({acknowledgeInvalid:e.target.checked})}/> {hu?'Tudomásul veszem, hogy csak nem jóváhagyható tervezet készül; ismét kiszámítom az előnézetet.':'I acknowledge an invalid draft and will recalculate the preview. It cannot be approved until resolved.'}</label>}
   {preview&&<label className="block"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> {hu?'Új, külön jóváhagyást igénylő tervezet létrehozása; az előző terv változatlan.':'Create a new draft requiring its own approval; keep the previous plan unchanged.'}</label>}
   <Button disabled={busy||blocked||!preview||!preview.validation||!!preview.conflicts.length||!confirmed||!preview.validation.valid&&!intent.acknowledgeInvalid} onClick={()=>void run(true)}>{hu?'Tervezet létrehozása új profilokkal':'Create draft with new profiles'}</Button>
  </fieldset>
 </details>;
}
