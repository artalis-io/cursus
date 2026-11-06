import {useI18n} from '@/i18n';
import type {Plan} from '@/types';
/** Imported facts are not a packing certificate or an approval gate. */
export function LoadingEvidence({plan}:{plan:Plan}){
 const {lang}=useI18n(),hu=lang==='hu',data=plan.physicalLoading;
 return <div data-testid="loading-evidence" className="space-y-1 border-t border-divider pt-2 text-muted-foreground">
  <p className="font-medium">{hu?'Fizikai rakodhatóság':'Physical loading'}</p>
  <p>{data?(hu?'Fizikai adatok importálva. A szigorú rakodási ellenőrzés ki van kapcsolva; a rakodhatóság nincs igazolva.':'Physical data imported. Hard loading is disabled; feasibility has not been verified.'):(hu?'Fizikai adatok nincsenek megadva. A raklap-egyenérték nem igazolja a rakodhatóságot.':'Physical data not supplied. Pallet equivalents do not prove loading feasibility.')}</p>
  {data&&<><ul aria-label={hu?'Körönkénti rakodási adatok':'Loading evidence by round'}>{data.rounds.map(r=><li key={`${r.vehicleId}:${r.tripIndex}`}>
   {plan.vehicles.find(v=>v.id===r.vehicleId)?.ref??r.vehicleId} · {hu?'Kör':'Round'} {r.tripIndex+1} · {r.unitCount} {hu?'egység · Nem ellenőrzött':'units · Not evaluated'}
  </li>)}</ul><p className="break-all">{hu?'Forrás SHA-256':'Source SHA-256'}: {data.sourceSha256}</p></>}
 </div>;
}
