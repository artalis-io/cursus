import {useEffect,useState} from 'react';
import {Dialog,DialogContent,DialogHeader,DialogTitle} from '@/components/ui/dialog';
import {Button} from '@/components/ui/button';
import {api} from '@/lib/api';
import {usePermission} from '@/permissions';
import {useI18n,describeApiError} from '@/i18n';
import type {Plan,Scenario} from '@/types';
import type {DestinationSummary,HandoffOperation,TransferSummary} from '../../../server/src/integration-contract';
import type {Workflow} from '../../../server/src/workflow-contract';

export function HandoffDialog({open,onOpenChange,plan,scenario}:{open:boolean;onOpenChange:(value:boolean)=>void;plan:Plan;scenario:Scenario}){
 const {lang,t}=useI18n(),hu=lang==='hu',send=usePermission('handoff.send'),cancel=usePermission('handoff.cancel');
 const [destinations,setDestinations]=useState<DestinationSummary[]>([]),[status,setStatus]=useState<Awaited<ReturnType<typeof api.transfers>>|null>(null),[workflow,setWorkflow]=useState<Workflow|null>(null);
 const [destination,setDestination]=useState(''),[reason,setReason]=useState(''),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
 const [operationId,setOperationId]=useState(()=>crypto.randomUUID());
 useEffect(()=>{if(!open)return;let alive=true;setStatus(null);setWorkflow(null);setError(null);setReason('');setConfirmed(false);setOperationId(crypto.randomUUID());
  const refresh=()=>Promise.all([api.transferDestinations(),api.transfers(plan.id),api.planWorkflow(plan.id)]).then(([d,s,w])=>{if(alive){setDestinations(d);setStatus(s);setWorkflow(w);setDestination(old=>d.some(x=>x.id===old)?old:d[0]?.id??'');}}).catch(e=>{if(alive)setError(describeApiError(e,t));});
  void refresh();const timer=setInterval(()=>void refresh(),2000);return()=>{alive=false;clearInterval(timer);};
 },[open,plan.id,scenario.revision,t]);
 const head=status?.heads.find(h=>h.destinationId===destination),current=status?.intents.find(i=>i.id===head?.currentIntentId),accepted=status?.intents.find(i=>i.id===head?.acceptedIntentId);
 const outstanding=current&&['queued','sending','retrying','needs_reconciliation'].includes(current.state);
 const active=accepted&&accepted.operation!=='cancel';
 const approved=workflow?.state==='approved'&&!workflow.blockers.length&&workflow.currentRevision===scenario.revision&&plan.scenarioRevision===scenario.revision;
 async function run(action:()=>Promise<unknown>){if(busy)return;setBusy(true);setError(null);try{await action();setStatus(await api.transfers(plan.id));setOperationId(crypto.randomUUID());setConfirmed(false);setReason('');}catch(e){setError(describeApiError(e,t));}finally{setBusy(false);}}
 const queue=(operation:HandoffOperation)=>run(()=>api.queueTransfer(plan.id,scenario.revision,{operationId,destinationId:destination,version:head?.version??0,operation,reason,
  previousIntentId:accepted?.id,approvalVersion:operation==='cancel'?accepted!.approvalVersion:workflow!.version}));
 const label=(state:TransferSummary['state'])=>hu?({queued:'Sorban',sending:'Küldés',retrying:'Újrapróbálás',acknowledged:'Visszaigazolt',acknowledged_superseded:'Visszaigazolt, de elavult',rejected:'Elutasítva',stale:'Elavult',needs_reconciliation:'Egyeztetés szükséges'}[state]):state.replace(/_/g,' ');
 return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto"><DialogHeader><DialogTitle>{hu?'Visszaigazolt átadás':'Acknowledged handoff'}</DialogTitle></DialogHeader>
  <p className="text-xs text-muted-foreground">{hu?'A visszaigazolás az utasítás átvételét jelenti, nem a kiszállítás teljesítését. Csak a rendszergazda által konfigurált célrendszerek érhetők el.':'Acknowledgement confirms acceptance of an instruction, not completion of delivery. Only operator-configured destinations are available.'}</p>
  <p className="break-all text-xs">{plan.id} · r{plan.scenarioRevision}</p>
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  {!status?<p>{hu?'Betöltés…':'Loading…'}</p>:!destinations.length?<p>{hu?'Nincs konfigurált célrendszer. A szokásos tervexport továbbra is elérhető.':'No destinations configured. Ordinary plan exports remain available.'}</p>:<>
   <label className="text-sm">{hu?'Célrendszer':'Destination'}<select aria-label={hu?'Célrendszer':'Destination'} className="ml-2 rounded border bg-background p-1" value={destination} onChange={e=>{setDestination(e.target.value);setConfirmed(false);setOperationId(crypto.randomUUID());}}>{destinations.map(d=><option key={d.id} value={d.id}>{d.label}</option>)}</select></label>
   {current&&<p role="status" className="text-sm">{hu?'Állapot':'Status'}: {label(current.state)} · {hu?'Generáció':'Generation'} {current.generation}</p>}
   {send&&<>
    <label className="block text-sm">{hu?'Átadás indoka':'Handoff reason'}<textarea aria-label={hu?'Átadás indoka':'Handoff reason'} maxLength={500} className="mt-1 w-full rounded border bg-background p-2" value={reason} onChange={e=>{setReason(e.target.value);setOperationId(crypto.randomUUID());}}/></label>
    <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>{hu?'Megerősítem a pontos terv és verzió külső átadását.':'I confirm sending this exact plan and revision to the destination.'}</label>
    <div className="flex flex-wrap gap-2"><Button disabled={busy||!approved||!!outstanding||!reason.trim()||!confirmed} onClick={()=>void queue(active?'amend':'publish')}>{active?(hu?'Módosítás küldése':'Send amendment'):(hu?'Jóváhagyott terv küldése':'Send approved plan')}</Button>
    {active&&cancel&&<Button variant="outline" disabled={busy||!!outstanding||!reason.trim()||!confirmed} onClick={()=>void queue('cancel')}>{hu?'Elfogadott utasítás visszavonása':'Cancel accepted instruction'}</Button>}</div>
    {!approved&&<p className="text-xs text-muted-foreground">{hu?'Küldéshez az aktuális terv jóváhagyása szükséges.':'Sending requires current approval of this plan.'}</p>}
    {current?.state==='needs_reconciliation'&&<div className="rounded border p-2 text-xs"><p>{hu?'A célrendszer elfogadhatta az előző kérést. Új utasítás blokkolva az egyeztetésig.':'The receiver may have accepted the previous request. New instructions are blocked pending reconciliation.'}</p>
     <Button variant="outline" size="sm" disabled={busy} onClick={()=>void run(()=>api.retryTransfer(current.id,'lookup'))}>{hu?'Bizonylat lekérdezése':'Look up receipt'}</Button>
     <Button variant="outline" size="sm" disabled={busy||!confirmed} onClick={()=>void run(()=>api.retryTransfer(current.id,'retry'))}>{hu?'Azonos utasítás újrapróbálása':'Retry same instruction'}</Button></div>}
   </>}
   <ol className="space-y-2">{status.intents.filter(i=>i.destinationId===destination).map(i=><li key={i.id} className="rounded border p-2 text-xs"><div>{i.operation} · r{i.scenarioRevision} · {label(i.state)} · {i.attempts} {hu?'kísérlet':'attempt(s)'}</div><p>{i.reason}</p><div className="break-all text-muted-foreground">{i.planId} · {i.planSha256}</div>{i.receipt&&<p>{hu?'Bizonylat':'Receipt'}: {i.receipt.receiptId}</p>}{i.lastError&&<p>{i.lastError}</p>}</li>)}</ol>
  </>}
 </DialogContent></Dialog>;
}
