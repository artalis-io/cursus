import {useEffect,useRef,useState} from 'react';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {Button} from '@/components/ui/button';
import {api,ApiError,type InputUpdateOptions,type InputUpdatePreview} from '@/lib/api';
import {useI18n,describeApiError} from '@/i18n';
import {usePermission} from '@/permissions';
import {km,money} from '@/lib/format';
import {violationDetail} from '@/lib/violations';
import type {Plan,Scenario} from '@/types';
import type {InputUpdateIntent} from '../../../server/src/input-update-contract';
import type {ProfileRef} from '../../../server/src/planning-profile-contract';

export function InputUpdatesDialog({plan,scenario,onClose,onApplied,onUpload}:{plan:Plan;scenario:Scenario;onClose:()=>void;onApplied:(plan:Plan)=>Promise<void>;onUpload:()=>void}){
 const {lang,t}=useI18n(),hu=lang==='hu',text=(en:string,hungarian:string)=>hu?hungarian:en;
 const edit=usePermission('scenario.edit'),create=usePermission('scenario.create'),propose=usePermission('profile.propose'),approve=usePermission('profile.approve'),upload=usePermission('dataset.upload');
 const [options,setOptions]=useState<InputUpdateOptions|null>(null),[choice,setChoice]=useState<InputUpdateOptions['choices'][number]|null>(null);
 const [matches,setMatches]=useState<{from:number;to:number}[]>([]),[released,setReleased]=useState<number[]>([]),[unlocked,setUnlocked]=useState<number[]>([]),[profiles,setProfiles]=useState<ProfileRef[]>([]);
 const [reason,setReason]=useState(''),[reviewed,setReviewed]=useState(false),[carry,setCarry]=useState(false),[invalid,setInvalid]=useState(false),[archive,setArchive]=useState(false);
 const [preview,setPreview]=useState<InputUpdatePreview|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[attempted,setAttempted]=useState(false),[page,setPage]=useState(0);
 const [operationId]=useState(()=>crypto.randomUUID()),alive=useRef(true),inFlight=useRef(false),generation=useRef(0);
 useEffect(()=>{if(!approve)setCarry(false);},[approve]);
 useEffect(()=>{alive.current=true;void api.inputUpdateOptions(scenario.id,plan.id).then(value=>{if(alive.current)setOptions(value);}).catch(e=>{if(alive.current)setError(describeApiError(e,t));});return()=>{alive.current=false;};},[scenario.id,plan.id,t]);
 const intent:InputUpdateIntent={operationId,parentPlanId:plan.id,datasetId:choice?.datasetId??'',dayId:choice?.dayId??'',reason,matches,releaseRequestIds:released,unlockVehicleIds:unlocked,
  profiles,identityReviewed:reviewed,carryExceptions:carry,acknowledgeInvalid:invalid};
 const key=JSON.stringify(intent);
 useEffect(()=>{generation.current++;setPreview(null);setArchive(false);},[key]);
 async function run(work:()=>Promise<void>){
  if(inFlight.current||!edit||!create)return;
  inFlight.current=true;setBusy(true);setError(null);
  try{await work();}catch(e){if(alive.current)setError(describeApiError(e,t));}finally{inFlight.current=false;if(alive.current)setBusy(false);}
 }
 function toggle(values:number[],value:number,checked:boolean){return checked?[...values.filter(v=>v!==value),value]:values.filter(v=>v!==value);}
 async function choose(value:string){
  const next=options?.choices.find(c=>JSON.stringify([c.datasetId,c.dayId])===value);if(!next)return;
  await run(async()=>{const data=await api.inputUpdateOptions(scenario.id,plan.id,next.datasetId,next.dayId);if(!alive.current)return;
   setChoice(next);setOptions(data);setMatches(data.suggested??[]);setReleased([]);setUnlocked([]);setProfiles([]);setReviewed(false);setCarry(false);setInvalid(false);setPage(0);setAttempted(false);
  });
 }
 async function refreshProfiles(){if(!choice)return;const data=await api.inputUpdateOptions(scenario.id,plan.id,choice.datasetId,choice.dayId);if(alive.current)setOptions(data);}
 async function calculate(){await run(async()=>{const token=++generation.current,result=await api.inputUpdatePreview(scenario,intent);if(alive.current&&generation.current===token)setPreview(result);});}
 async function apply(){if(!preview||!archive)return;await run(async()=>{
  setAttempted(true);
  let result:Plan;
  try{result=await api.inputUpdateApply(scenario,intent,preview.previewSha256);}
  catch(e){
   if(!(e instanceof ApiError)||(e.status!==null&&e.status<500))throw e;
   const current=await api.scenario(scenario.id);
   if(!current.supersededBy)throw e;
   const saved=await api.planSnapshot(current.supersededBy.planId);
   if(saved.provenance.inputUpdate?.operationId!==operationId)throw e;
   result=saved;
  }
  if(alive.current)await onApplied(result);
 });}
 const pageRows=options?.before?.slice(page*25,page*25+25)??[];
 return <Dialog open onOpenChange={open=>{if(!open&&!attempted)onClose();}}><DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
  <DialogHeader><DialogTitle>{text('Update input snapshot','Bemeneti adatok frissítése')}</DialogTitle><DialogDescription>{text('Review a replacement admitted snapshot. Existing data stays immutable; the previous planning cycle becomes read-only.','Ellenőrizze a befogadott új adatpillanatképet. Az eredeti adatok változatlanok maradnak; a korábbi tervezési ciklus csak olvasható lesz.')}</DialogDescription></DialogHeader>
  <fieldset disabled={busy||attempted||!edit||!create} className="space-y-3">
   <label className="block text-sm">{text('Replacement snapshot','Új adatpillanatkép')}<select className="mt-1 w-full rounded border bg-card p-2" aria-label={text('Replacement snapshot','Új adatpillanatkép')} value={choice?JSON.stringify([choice.datasetId,choice.dayId]):''} onChange={e=>void choose(e.target.value)}>
    <option value="">{text('Select an admitted revision for this date…','Válasszon befogadott verziót erre a napra…')}</option>
    {options?.choices.map(c=><option key={JSON.stringify([c.datasetId,c.dayId])} value={JSON.stringify([c.datasetId,c.dayId])}>{c.label} · {c.sha256.slice(0,12)}</option>)}
   </select></label>
   {options?.choices.length===0&&<p className="text-sm">{text('No replacement snapshot is admitted for this date yet. Upload, convert and admit the revised input first.','Erre a napra még nincs új befogadott pillanatkép. Először töltse fel, konvertálja és fogadja be a módosított adatokat.')}</p>}
   {upload&&<Button size="sm" variant="outline" onClick={()=>{onClose();onUpload();}}>{text('Upload revised input','Módosított adatok feltöltése')}</Button>}
   <label className="block text-sm">{text('Update reason','Frissítés indoka')}<input aria-label={text('Update reason','Frissítés indoka')} className="mt-1 w-full rounded border bg-card p-2" value={reason} maxLength={500} onChange={e=>setReason(e.target.value)}/></label>
   {choice&&options?.before&&<section className="space-y-2 rounded border p-3" aria-label={text('Delivery correspondence','Kiszállítások megfeleltetése')}>
    <p className="text-xs text-muted-foreground">{text('Request IDs are snapshot-scoped. Suggested pairs use unique references only as a review aid, not identity proof. Verify quantities, destinations and correspondence. Unmatched source deliveries are cancellations; unmatched target deliveries are additions.','A kérésazonosítók pillanatképhez kötöttek. Az egyedi hivatkozások csak javaslatot adnak, nem bizonyítanak azonosságot. Ellenőrizze a mennyiségeket, címeket és megfeleltetéseket. A pár nélküli régi tételek törlések, az új tételek hozzáadások.')}</p>
    {pageRows.map(row=><label key={row.id} className="block border-b py-2 text-xs"><span className="block break-words">#{row.reference} · {row.customer} · {row.address} · {row.weightKg} kg / {row.pallets} {text('pallets','raklap')} · ID {row.id}</span>
     <select className="mt-1 w-full rounded border bg-card p-1" aria-label={`${text('Match delivery','Megfeleltetés')} ${row.id}`} value={matches.find(p=>p.from===row.id)?.to??''} onChange={e=>{const value=e.target.value;setMatches(old=>[...old.filter(p=>p.from!==row.id),...(value===''?[]:[{from:row.id,to:Number(value)}])]);setReviewed(false);}}>
      <option value="">{text('Cancelled / no corresponding delivery','Törölt / nincs megfelelő tétel')}</option>
      {options.after?.map(next=><option key={next.id} value={next.id}>#{next.reference} · {next.customer} · {next.address} · {next.weightKg} kg / {next.pallets} · ID {next.id}</option>)}
     </select>
    </label>)}
    <div className="flex flex-wrap items-center gap-2 text-xs"><Button size="sm" variant="outline" disabled={page===0} onClick={()=>setPage(v=>v-1)}>{text('Previous','Előző')}</Button>
     <span>{page*25+1}–{Math.min((page+1)*25,options.before.length)} / {options.before.length}</span><Button size="sm" variant="outline" disabled={(page+1)*25>=options.before.length} onClick={()=>setPage(v=>v+1)}>{text('Next','Következő')}</Button></div>
    <label className="flex gap-2 text-sm"><input type="checkbox" checked={reviewed} onChange={e=>setReviewed(e.target.checked)}/>{text('I verified the delivery correspondence, including additions and cancellations.','Ellenőriztem a megfeleltetéseket, a hozzáadásokat és a törléseket is.')}</label>
   </section>}
   {!!options?.manualRequestIds?.length&&<details><summary className="cursor-pointer text-sm">{text('Explicitly release retained decisions','Megtartott döntések kifejezett feloldása')}</summary><p className="text-xs text-muted-foreground">{text('Only select decisions you intend to release. Surviving decisions are kept by default.','Csak a feloldani kívánt döntéseket jelölje meg. A megmaradó döntések alapértelmezetten érvényben maradnak.')}</p>
    {options.manualRequestIds.map(id=><label key={id} className="flex gap-2 text-xs"><input type="checkbox" checked={released.includes(id)} onChange={e=>setReleased(toggle(released,id,e.target.checked))}/>{text('Release decision','Döntés feloldása')} #{options.before?.find(r=>r.id===id)?.reference??id} · ID {id}</label>)}
   </details>}
   {!!options?.lockedVehicleIds?.length&&<details><summary className="cursor-pointer text-sm">{text('Explicitly unlock affected routes','Érintett útvonalak kifejezett feloldása')}</summary>
    {options.lockedVehicleIds.map(id=><label key={id} className="flex gap-2 text-xs"><input type="checkbox" checked={unlocked.includes(id)} onChange={e=>setUnlocked(toggle(unlocked,id,e.target.checked))}/>{text('Unlock route on','Útvonal feloldása:')} {plan.vehicles.find(v=>v.id===id)?.ref??id}</label>)}
   </details>}
   {!!options?.exceptions?.length&&<section className="space-y-2 rounded border border-warning/40 p-2 text-xs"><strong>{text('Existing access exceptions','Meglévő behajtási kivételek')}</strong>
    {options.exceptions.map((e,i)=><p key={i}>#{e.orderNo} · {e.reason}</p>)}
    <label className="flex gap-2"><input type="checkbox" checked={carry} disabled={!approve} onChange={e=>setCarry(e.target.checked)}/>{text('Admin: reapprove these exact exceptions for the verified unchanged destinations.','Admin: a változatlan címekre ugyanezen kivételek újbóli jóváhagyása.')}</label>
   </section>}
   {!!options?.requiredProfiles?.length&&<section className="space-y-2 rounded border p-3 text-xs"><strong>{text('Replacement planning profiles required','Új tervezési profilok szükségesek')}</strong>
    {options.requiredProfiles.map(kind=><details key={kind}><summary>{kind==='fleet'?text('Fleet','Flotta'):text('Locations','Helyszínek')}</summary>
     {options.profileTemplates?.[kind]&&propose&&<><pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(options.profileTemplates[kind],null,2)}</pre>
      <Button size="sm" variant="outline" disabled={!reason.trim()} onClick={()=>void run(async()=>{await api.proposeProfile({...options.profileTemplates![kind]!,reason},0);await refreshProfiles();})}>{text('Propose reviewed replacement profile','Ellenőrzött új profil benyújtása')}</Button></>}
    </details>)}
    {options.profiles?.map(row=><div key={`${row.id}:${row.revision}`} className="my-2 rounded border p-2"><span>{row.body.label} · v{row.revision} · {row.approved_at?text('Approved','Jóváhagyott'):text('Proposed','Javasolt')}</span>
     {!row.approved_at&&approve&&<Button size="sm" variant="outline" onClick={()=>void run(async()=>{await api.activateProfile(row.id,row.revision,row.version);await refreshProfiles();})}>{text('Approve replacement profile','Új profil jóváhagyása')}</Button>}
     {row.approved_at&&<label className="flex gap-2"><input type="checkbox" checked={profiles.some(p=>p.id===row.id&&p.revision===row.revision)} onChange={e=>setProfiles(old=>e.target.checked?[...old.filter(p=>p.kind!==row.kind),{id:row.id,kind:row.kind,revision:row.revision,sha256:row.sha256}]:old.filter(p=>p.id!==row.id))}/>{text('Use this approved revision','Ezen jóváhagyott verzió használata')}</label>}
    </div>)}
   </section>}
   <label className="flex gap-2 text-xs"><input type="checkbox" checked={invalid} onChange={e=>setInvalid(e.target.checked)}/>{text('Allow an explicitly invalid draft for further manual repair; it cannot be approved or dispatched.','Kifejezetten érvénytelen munkaterv engedélyezése kézi javításhoz; nem hagyható jóvá és nem adható át.')}</label>
  </fieldset>
  {preview&&<section aria-label={text('Input update preview','Adatfrissítés előnézete')} className="space-y-2 rounded border p-3 text-sm">
   <p className="font-semibold">{text('New draft — no approval inherited','Új munkaterv — jóváhagyás nélkül')}</p>
   <p>{text('Added','Új')}: {preview.diff.added.length} · {text('Cancelled','Törölt')}: {preview.diff.cancelled.length} · {text('Changed','Módosult')}: {preview.diff.changed.length} · {text('Unchanged','Változatlan')}: {preview.diff.unchanged}</p>
   <p>{text('Retained decisions','Megtartott döntések')}: {preview.diff.retainedDecisions} · {text('Affected vehicles','Érintett járművek')}: {preview.diff.affectedVehicles.map(id=>plan.vehicles.find(v=>v.id===id)?.ref??`#${id}`).join(', ')||'—'}</p>
   <p>{text('Recalculated','Újraszámolva')}: {preview.stats.servedOrders}/{preview.stats.totalOrders} · {km(preview.stats.totalDistanceKm,1)} · {preview.cost?money(preview.cost.total,preview.cost.currency):'—'} · {preview.stats.vehiclesUsed} {text('vehicles','jármű')} / {preview.stats.trips} {text('trips','forduló')}</p>
   {preview.diff.matrixChanged&&<p>{text('Travel data changed; route timing and metrics have been recalculated.','Az útvonaladatok változtak; az idők és mutatók újraszámítva.')}</p>}
   <details><summary className="cursor-pointer">{text('Changed delivery details','Tételes változások')}</summary><ul className="space-y-1 text-xs">
    {preview.diff.changed.map(r=><li key={r.before.id}>#{r.before.reference} → #{r.after.reference} · {r.fields.join(', ')} · {r.before.weightKg} → {r.after.weightKg} kg · {r.before.pallets} → {r.after.pallets} {text('pallets','raklap')} · {r.before.address} → {r.after.address}</li>)}
    {preview.diff.added.map(r=><li key={`a${r.id}`}>+ #{r.reference} · {r.customer} · {r.address}</li>)}{preview.diff.cancelled.map(r=><li key={`c${r.id}`}>− #{r.reference} · {r.customer} · {r.address}</li>)}
   </ul></details>
   {!!preview.diff.conflicts.length&&<ul role="alert" className="list-inside list-disc text-destructive">{preview.diff.conflicts.map((c,i)=><li key={i}>{c.message}{c.requestId===undefined?'':` · ID ${c.requestId}`}{c.vehicleId===undefined?'':` · ${plan.vehicles.find(v=>v.id===c.vehicleId)?.ref??c.vehicleId}`}</li>)}</ul>}
   {!preview.validation.valid&&<div role="status" className="text-warning">{text('Invalid draft: resolve violations before review or approval.','Érvénytelen munkaterv: jóváhagyás előtt javítsa a szabálysértéseket.')}<ul>{preview.validation.violations.map((v,i)=><li key={i}>{violationDetail(v,t)}</li>)}</ul></div>}
   <details><summary>{text('Workspaces and approvals being superseded','Lezárt munkaterületek és jóváhagyások')} ({preview.archivedWorkspaces.length})</summary>{preview.archivedWorkspaces.map(s=><p key={s.id} className="text-xs">{s.label}</p>)}</details>
   <label className="flex gap-2"><input type="checkbox" checked={archive} disabled={busy||attempted} onChange={e=>setArchive(e.target.checked)}/>{text('Make this the new input cycle. Keep the previous workspaces read-only and invalidate their approval for new dispatch.','Ez legyen az új adatciklus. A korábbi munkaterületek csak olvashatók lesznek, jóváhagyásuk új átadáshoz érvénytelenné válik.')}</label>
  </section>}
  {error&&<p role="alert" className="text-sm text-destructive">{error}{attempted&&` ${text('Retry the same operation; do not create another update.','Ugyanezt a műveletet próbálja újra, ne hozzon létre másik frissítést.')}`}</p>}
  <div className="flex flex-wrap justify-end gap-2"><Button variant="outline" disabled={busy&&attempted} onClick={onClose}>{text('Cancel','Mégse')}</Button>
   <Button variant="outline" disabled={busy||attempted||!choice||!reason.trim()||!reviewed||!edit||!create} onClick={()=>void calculate()}>{text('Preview input changes','Adatváltozások előnézete')}</Button>
   <Button disabled={busy||!reviewed||!preview||!archive||!!preview.diff.conflicts.length||(!preview.validation.valid&&!invalid)||!edit||!create} onClick={()=>void apply()}>{text(preview&&!preview.validation.valid?'Create invalid updated draft':'Create updated draft',preview&&!preview.validation.valid?'Érvénytelen új munkaterv létrehozása':'Új munkaterv létrehozása')}</Button></div>
 </DialogContent></Dialog>;
}
