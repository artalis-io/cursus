import {useEffect,useState} from 'react';
import {Dialog,DialogContent,DialogHeader,DialogTitle} from '@/components/ui/dialog';
import {Button} from '@/components/ui/button';
import {useI18n,describeApiError} from '@/i18n';
import {usePermission} from '@/permissions';
import {api} from '@/lib/api';
import type {Plan,Scenario} from '@/types';
import type {ProfileContent,ProfileRef,ProfileRevision} from '../../../server/src/planning-profile-contract';

function WindowInput({value,onChange,label}:{value:number;onChange:(value:number)=>void;label:string}){
 const format=(s:number)=>`${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor(s%3600/60)).padStart(2,'0')}${s%60?`:${String(s%60).padStart(2,'0')}`:''}`;
 const [text,setText]=useState(format(value));
 useEffect(()=>setText(format(value)),[value]);
 return <label>{label}<input required aria-label={label} className="ml-1 w-24 rounded border bg-background p-1" placeholder="HH:MM" pattern="[0-9]{1,2}:[0-5][0-9](:[0-5][0-9])?" value={text} onChange={e=>{
  setText(e.target.value);const match=/^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$/.exec(e.target.value);
  const seconds=match?Number(match[1])*3600+Number(match[2])*60+Number(match[3]??0):NaN;
  e.target.setCustomValidity(Number.isFinite(seconds)&&seconds<=172800?'':'Use HH:MM between 00:00 and 48:00');
  if(Number.isFinite(seconds)&&seconds<=172800)onChange(seconds);
 }}/></label>;
}

export function ProfilesDialog({open,onOpenChange,plan,scenario,onBound}:{open:boolean;onOpenChange:(value:boolean)=>void;plan:Plan;scenario:Scenario;onBound:(scenario:Scenario)=>void}){
 const {lang,t}=useI18n(),hu=lang==='hu';
 const propose=usePermission('profile.propose'),approve=usePermission('profile.approve'),edit=usePermission('scenario.edit');
 const [rows,setRows]=useState<ProfileRevision[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
 const [draft,setDraft]=useState<{content:ProfileContent;id?:string;version:number}|null>(null);
 const [chosen,setChosen]=useState<ProfileRef[]>(scenario.planningProfiles??[]);
 useEffect(()=>{if(!open)return;let alive=true;setError(null);setDraft(null);setChosen(scenario.planningProfiles??[]);
  api.profiles().then(rows=>{if(alive)setRows(rows);}).catch(e=>{if(alive)setError(describeApiError(e,t));});return()=>{alive=false;};
 },[open,scenario.id,scenario.revision,scenario.planningProfiles,t]);
 async function run(action:()=>Promise<void>){if(busy)return;setBusy(true);setError(null);try{await action();}catch(e){setError(describeApiError(e,t));}finally{setBusy(false);}}
 function change(change:(copy:ProfileContent)=>void){setDraft(d=>{if(!d)return d;const content=structuredClone(d.content);change(content);return {...d,content};});}
 const title=hu?'Tervezési profilok':'Planning profiles';
 const ordered=(refs:ProfileRef[])=>JSON.stringify([...refs].sort((a,b)=>a.kind<b.kind?-1:a.kind>b.kind?1:0));
 const unchanged=ordered(chosen)===ordered(scenario.planningProfiles??[]);
 return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[85vh] max-w-4xl overflow-y-auto">
  <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
  <p className="text-xs text-muted-foreground">{hu?'A profil jóváhagyása nem módosít meglévő terveket. Válasszon pontos verziót, majd tervezzen újra.':'Approving a profile does not change existing plans. Choose exact revisions, then Replan.'}</p>
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  {propose&&<div className="flex flex-wrap gap-2">{(['fleet','locations'] as const).map(kind=><Button key={kind} variant="outline" size="sm" disabled={busy} onClick={()=>void run(async()=>setDraft({content:await api.profileTemplate(plan.id,kind),version:0}))}>
   {kind==='fleet'?(hu?'Új flottaprofil':'New fleet profile'):(hu?'Új helyszínprofil':'New location profile')}</Button>)}</div>}
  {draft&&propose&&<form className="space-y-3 rounded border p-3" onSubmit={e=>{e.preventDefault();void run(async()=>{await api.proposeProfile(draft.content,draft.version,draft.id);setRows(await api.profiles());setDraft(null);});}}>
   <label className="block text-sm">{hu?'Profil neve':'Profile name'}<input required maxLength={120} className="mt-1 w-full rounded border bg-background px-2 py-1" value={draft.content.label} onChange={e=>change(c=>{c.label=e.target.value;})}/></label>
   <label className="block text-sm">{hu?'Változtatás indoka':'Change reason'}<input required maxLength={500} className="mt-1 w-full rounded border bg-background px-2 py-1" value={draft.content.reason} onChange={e=>change(c=>{c.reason=e.target.value;})}/></label>
   <p className="break-all text-xs text-muted-foreground">{hu?'Adatkészlet':'Dataset'}: {draft.content.datasetSha256}</p>
   <div className="max-h-64 space-y-2 overflow-auto">
   {draft.content.settings?.vehicles.map((v,i)=><fieldset key={v.id} className="flex flex-wrap items-center gap-3 rounded border p-2 text-xs"><legend>{v.ref} · {v.id}</legend>
    {(['capacityKg','capacityPallets'] as const).map(key=><label key={key}>{key==='capacityKg'?(hu?'Teherbírás (kg)':'Payload capacity (kg)'):(hu?'Raklapkapacitás':'Pallet capacity')}<input className="ml-1 w-20 rounded border bg-background p-1" type="number" min="0.001" step="0.001" value={v[key]??''} onChange={e=>change(c=>{c.settings!.vehicles[i][key]=e.target.value===''?undefined:Number(e.target.value);})}/></label>)}
    <label>{hu?'Össztömeg (t)':'Gross vehicle weight (t)'}<input aria-label={`${v.ref} GVW`} className="ml-1 w-20 rounded border bg-background p-1" type="number" min="0.001" step="0.001" value={v.tonnage??''} onChange={e=>change(c=>{c.settings!.vehicles[i].tonnage=e.target.value===''?null:Number(e.target.value);})}/></label>
    <label><input type="checkbox" checked={v.hasTailLift} onChange={e=>change(c=>{c.settings!.vehicles[i].hasTailLift=e.target.checked;})}/> {hu?'Emelőhátfal':'Tail-lift'}</label>
    <label><input type="checkbox" checked={v.available!==false} onChange={e=>change(c=>{c.settings!.vehicles[i].available=e.target.checked;})}/> {hu?'Elérhető':'Available'}</label>
    <label>{hu?'Újrarakodás (perc)':'Reload (minutes)'}<input className="ml-1 w-20 rounded border bg-background p-1" type="number" min="0" step="any" required value={v.reloadSec/60} onChange={e=>change(c=>{c.settings!.vehicles[i].reloadSec=Math.round(Number(e.target.value)*60);})}/></label>
   </fieldset>)}
   {draft.content.locations?.map((rule,i)=><fieldset key={rule.locationId} className="flex flex-wrap items-center gap-3 rounded border p-2 text-xs"><legend>{rule.label??`${hu?'Helyszín':'Location'} ${rule.locationId}`}</legend>
    <label>{hu?'Max. össztömeg (kg)':'Maximum GVW (kg)'}<input className="ml-1 w-24 rounded border bg-background p-1" type="number" min="1" step="1" value={rule.maxGrossWeightKg??''} onChange={e=>change(c=>{c.locations![i].maxGrossWeightKg=e.target.value===''?null:Number(e.target.value);})}/></label>
    <label><input type="checkbox" checked={rule.requiresTailLift} onChange={e=>change(c=>{c.locations![i].requiresTailLift=e.target.checked;})}/> {hu?'Emelőhátfal szükséges':'Requires tail-lift'}</label>
    <label>{hu?'Kiszolgálás (perc)':'Service (minutes)'}<input required className="ml-1 w-20 rounded border bg-background p-1" type="number" min="0" step="any" value={rule.serviceSeconds/60} onChange={e=>change(c=>{c.locations![i].serviceSeconds=Math.round(Number(e.target.value)*60);})}/></label>
    <WindowInput value={rule.windowStartSeconds} label={hu?'Nyitás (HH:MM)':'Opening (HH:MM)'} onChange={value=>change(c=>{c.locations![i].windowStartSeconds=value;})}/>
    <WindowInput value={rule.windowEndSeconds} label={hu?'Határidő (HH:MM)':'Deadline (HH:MM)'} onChange={value=>change(c=>{c.locations![i].windowEndSeconds=value;})}/>
    <label className="w-full">{hu?'Indok':'Reason'}<input required maxLength={500} className="ml-1 w-full rounded border bg-background p-1" value={rule.reason} onChange={e=>change(c=>{c.locations![i].reason=e.target.value;})}/></label>
   </fieldset>)}
   </div>
   <div className="flex gap-2"><Button disabled={busy} type="submit">{hu?'Verzió benyújtása':'Propose revision'}</Button><Button variant="outline" type="button" onClick={()=>setDraft(null)}>{hu?'Mégse':'Cancel'}</Button></div>
  </form>}
  <div className="space-y-2">{!rows.length&&<p className="text-sm text-muted-foreground">{hu?'Még nincsenek verziózott profilok. A külső forrásbeállítások változatlanul használhatók.':'No versioned profiles yet. External source settings remain available.'}</p>}
  {rows.map(row=><article key={`${row.id}:${row.revision}`} className="space-y-1 rounded border p-3 text-sm">
   <strong>{row.body.label} · v{row.revision}</strong> <span className="text-xs text-muted-foreground">{row.approved_at?(row.active_revision===row.revision?(hu?'Aktív':'Active'):(hu?'Jóváhagyott':'Approved')):(hu?'Javaslat':'Proposed')}</span>
   <p>{row.body.reason}</p><p className="break-all text-xs text-muted-foreground">{row.sha256}</p>
   <details className="text-xs"><summary className="cursor-pointer">{hu?'Profil részletei':'Profile details'}</summary>
    {row.body.settings?.vehicles.map(v=><p key={v.id}>{v.ref} · {hu?'Össztömeg':'GVW'}: {v.tonnage??(hu?'ismeretlen':'unknown')} t · {hu?'Teherbírás':'Payload'}: {v.capacityKg??'—'} kg / {v.capacityPallets??'—'} {hu?'raklap':'pallets'} · {v.hasTailLift?(hu?'emelőhátfal':'tail-lift'):(hu?'nincs emelőhátfal':'no tail-lift')} · {v.available===false?(hu?'nem elérhető':'unavailable'):(hu?'elérhető':'available')} · {v.reloadSec/60} {hu?'perc újrarakodás':'min reload'}</p>)}
    {row.body.locations?.map(rule=><p key={rule.locationId}>{rule.label??rule.locationId} · {hu?'Max. össztömeg':'Maximum GVW'}: {rule.maxGrossWeightKg??'—'} kg · {rule.requiresTailLift?(hu?'emelőhátfal szükséges':'tail-lift required'):(hu?'emelőhátfal nem szükséges':'tail-lift not required')} · {rule.reason}</p>)}
    {row.body.settings&&<details><summary>{hu?'Díjszabás':'Rate card'}</summary><dl className="grid grid-cols-2 gap-1">{Object.entries(row.body.settings.tariff as Record<string,unknown>).map(([key,value])=><div key={key} className="contents"><dt>{({currency:hu?'Pénznem':'Currency',source:hu?'Forrás':'Source',model:hu?'Díjmodell':'Charging model',perKmDefault:hu?'Alap km-díj':'Default rate / km',fixedPerVehicle:hu?'Fix járműdíj':'Fixed / vehicle',perTripBase:hu?'Alap fuvardíj':'Base / trip',perKm:hu?'Km-díj':'Rate / km',perDrop:hu?'Lerakódíj':'Rate / drop',includedDrops:hu?'Beépített lerakók':'Included drops',perKmByClass:hu?'Km-díj kategóriánként':'Rate / km by class',fixedByClass:hu?'Fix díj kategóriánként':'Fixed rate by class',subcontractorMultiplier:hu?'Alvállalkozói szorzó':'Subcontractor multiplier',ownFleetMultiplier:hu?'Saját flotta szorzó':'Own-fleet multiplier'} as Record<string,string>)[key]??key}</dt><dd className="break-words">{value&&typeof value==='object'?Object.entries(value).map(([name,rate])=>`${name}: ${rate}`).join('; '):String(value)}</dd></div>)}</dl></details>}
   </details>
   <div className="flex flex-wrap gap-2">
    {propose&&<Button size="sm" variant="outline" disabled={busy} onClick={()=>setDraft({id:row.id,version:row.version,content:{...structuredClone(row.body),reason:''}})}>{hu?'Új verzió':'Propose changes'}</Button>}
    {approve&&row.active_revision!==row.revision&&<Button size="sm" variant="outline" disabled={busy} onClick={()=>void run(async()=>{await api.activateProfile(row.id,row.revision,row.version);setRows(await api.profiles());})}>{hu?'Jóváhagyás és aktiválás':'Approve and activate'}</Button>}
    {edit&&row.approved_at&&<label className="flex items-center gap-1 text-xs"><input type="checkbox" disabled={busy||row.body.datasetSha256!==plan.provenance.datasetSha256} checked={chosen.some(p=>p.id===row.id&&p.revision===row.revision)} onChange={e=>setChosen(old=>e.target.checked?[...old.filter(p=>p.kind!==row.kind),{id:row.id,kind:row.kind,revision:row.revision,sha256:row.sha256}]:old.filter(p=>p.id!==row.id||p.revision!==row.revision))}/>{hu?'Használat ebben a szcenárióban':'Use in this scenario'}</label>}
   </div>
  </article>)}</div>
  {edit&&<Button disabled={busy||unchanged} onClick={()=>void run(async()=>{const updated=await api.bindProfiles(scenario,chosen);onBound(updated);onOpenChange(false);})}>{hu?'Profilválasztás alkalmazása — újratervezés szükséges':'Apply profile selection — Replan required'}</Button>}
 </DialogContent></Dialog>;
}
