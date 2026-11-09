import {useI18n} from '@/i18n';
import type {Plan} from '@/types';
export function LoadingEvidence({plan,confirmed=false,invalidated=false}:{plan:Plan;confirmed?:boolean;invalidated?:boolean}){
 const {lang}=useI18n(),hu=lang==='hu',data=plan.physicalLoading;
 const hard=data?.mode==='hard',certificate=hard?data.certificate:undefined;
 const verified=hard&&data.status==='feasible'&&(certificate?.version===1||certificate?.version===2)&&certificate.planId===plan.id&&certificate.scenarioId===plan.scenarioId&&certificate.scenarioRevision===plan.scenarioRevision&&certificate.result?.mode==='hard'&&Array.isArray(certificate.result.rounds)&&confirmed;
 const stale=hard&&(data.status==='stale'||invalidated);
 const candidate=hard?data.certificate?.result?.unassigned_checks:undefined;
 const diagnostics=verified&&Array.isArray(candidate)?candidate.filter(d=>d&&Number.isSafeInteger(d.request_id)):undefined;
 const rounds=data&&Array.isArray(data.rounds)?data.rounds:[];
 return <div data-testid="loading-evidence" className="space-y-1 border-t border-divider pt-2 text-muted-foreground">
  <p className="font-medium">{hu?'Fizikai rakodhatóság':'Physical loading'}</p>
  {Array.isArray(data?.requiredCapabilities)&&data.requiredCapabilities.includes('axle_loads')&&<p data-testid="axle-loading-status">{hu?'Tengelyterhelések':'Axle loads'} · {verified&&rounds.length>0&&certificate?.version===2&&certificate.result.version===2&&Array.isArray(certificate.requiredCapabilities)&&certificate.requiredCapabilities.includes('axle_loads')?(hu?'Igazolt':'Verified'):(hu?'Nem ellenőrzött':'Not verified')}</p>}
  <p role={hard&&!verified?'status':undefined}>{hard?(verified?
   rounds.length===0?(hu?'Nincs hozzárendelt kör. Tekintse át az alábbi rakodási vizsgálatokat.':'No assigned rounds. Review the loading-only checks below.'):(hu?'A hozzárendelt körök fizikai rakodhatósága ennél a tervverziónál igazolt.':'Physical loading verified for the assigned rounds of this plan revision.'):
   stale?(hu?'Újratervezés szükséges. A módosítások érvénytelenítették a rakodási igazolást; jóváhagyás és jóváhagyott export nem lehetséges.':'Replan required. Edits invalidated loading evidence; approval and Approved export are blocked.'):(hu?'A rakodási igazolás még nincs megerősítve. Jóváhagyás előtt várja meg az ellenőrzést.':'Loading evidence is not yet confirmed. Wait for verification before approval.')):
   data?(hu?'Fizikai adatok importálva. A szigorú rakodási ellenőrzés ki van kapcsolva; a rakodhatóság nincs igazolva.':'Physical data imported. Hard loading is disabled; feasibility has not been verified.'):
   (hu?'Fizikai adatok nincsenek megadva. A raklap-egyenérték nem igazolja a rakodhatóságot.':'Physical data not supplied. Pallet equivalents do not prove loading feasibility.')}</p>
  {data&&<><ul aria-label={hu?'Körönkénti rakodási adatok':'Loading evidence by round'}>{rounds.map(r=><li key={`${r.vehicleId}:${r.tripIndex}`}>
   {plan.vehicles.find(v=>v.id===r.vehicleId)?.ref??r.vehicleId} · {hu?'Kör':'Round'} {r.tripIndex+1} · {r.unitCount} {hu?'egység':'units'} · {r.status==='feasible'&&verified?(hu?'Igazolt':'Verified'):(hu?'Nem ellenőrzött':'Not evaluated')}
  </li>)}</ul><p className="break-all">{hu?'Forrás SHA-256':'Source SHA-256'}: {data.sourceSha256}</p></>}
  {diagnostics&&diagnostics.length>0&&<div data-testid="loading-unassigned"><p>{hu?'Csak rakodási vizsgálat; nem bizonyítja a kiosztatlanul maradás okát vagy a körbe illeszthetőséget.':'Loading-only checks; these do not prove why an order is unassigned or whether it fits an existing route.'}</p>
   <ul>{diagnostics.map(d=><li key={d.request_id}>{plan.unassigned.find(s=>s.requestId===d.request_id)?.orderNo??d.request_id} (#{d.request_id}) · {hu?'Rakodásra alkalmas járművek':'Loading-compatible vehicles'}: {d.feasible_vehicles} · {hu?'Nem alkalmas':'Incompatible'}: {d.infeasible_vehicles}
    {d.feasible_vehicles===0&&<span> · {hu?'Ellenőrizze a fizikai egységeket és a jármű rakodási adatait.':'Check physical units and vehicle loading geometry.'}</span>}</li>)}</ul></div>}
 </div>;
}
