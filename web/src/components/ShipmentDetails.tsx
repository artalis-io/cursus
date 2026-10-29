import {useI18n} from '@/i18n';
import type {Plan} from '@/types';

export function ShipmentDetails({plan,requestId}:{plan:Plan;requestId?:number}){
 const {lang}=useI18n(),hu=lang==='hu';
 const snapshot=plan.shipmentMetadata,delivery=snapshot?.deliveries.find(d=>d.requestId===requestId);
 const shipment=delivery&&snapshot?.shipments.find(s=>s.id===delivery.shipmentId);
 return <section aria-label={hu?'Szállítmány adatai':'Shipment details'} className="space-y-2 rounded border border-divider bg-muted/20 p-2.5 text-xs">
  <h3 className="font-semibold">{hu?'Szállítmány és rakomány':'Shipment and load'}</h3>
  {!delivery?<p className="text-muted-foreground">{hu?'Ehhez a korábbi bemenethez nem áll rendelkezésre szállítmányszintű részletezés.':'Shipment-level detail is unavailable for this historical input.'}</p>:<>
   <p className="break-all">{hu?'Kiszállítás':'Delivery'}: {delivery.id}</p>
   {shipment&&<p>{hu?'Megrendelés':'Shipment'}: {shipment.reference} · {shipment.splitPolicy==='indivisible'?(hu?'Nem osztható':'Indivisible'):(hu?'Kifejezetten felosztott':'Explicit split')}</p>}
   <dl className="grid grid-cols-2 gap-1"><dt>{hu?'Tervezési tömeg':'Planning weight'}</dt><dd className="text-right tnum">{delivery.planningWeightKg.toLocaleString()} kg</dd>
    <dt>{hu?'Tömeg alapja':'Weight basis'}</dt><dd className="text-right">{delivery.weightBasis==='gross'?(hu?'Bruttó':'Gross'):delivery.weightBasis==='net'?(hu?'Nettó':'Net'):(hu?'Nincs megadva':'Unspecified')}</dd>
    <dt>{hu?'Raklap-egyenérték':'Pallet equivalent'}</dt><dd className="text-right tnum">{delivery.palletEquivalent.toLocaleString()}</dd></dl>
   {delivery.detail==='summary'?<p className="text-muted-foreground">{hu?'A forrás nem tartalmazott cikksorszintű részletezést.':'The source supplied no line-item detail.'}</p>:<ul aria-label={hu?'Cikksorok':'Line items'} className="space-y-1">{delivery.allocations.map(allocation=>{
    const line=shipment?.lines.find(line=>line.id===allocation.lineId);
    return <li key={allocation.lineId} className="flex justify-between gap-2"><span>{line?.productRef??allocation.lineId}</span><span className="tnum">{allocation.quantity.toLocaleString()} {line?.unit}</span></li>;
   })}</ul>}
   {delivery.loadUnits.length>0&&<ul aria-label={hu?'Rakományegységek':'Load units'}>{delivery.loadUnits.map(unit=><li key={unit.id} className="flex justify-between gap-2"><span>{unit.kind}</span><span>{unit.quantity} · {unit.stackable===null?(hu?'Rakhatóság ismeretlen':'Stackability unknown'):unit.stackable?(hu?'Rakható':'Stackable'):(hu?'Nem rakható':'Not stackable')}</span></li>)}</ul>}
   {delivery.loadUnits.length===0&&<p className="text-muted-foreground">{hu?'A fizikai rakományegységek adatai nincsenek megadva.':'Physical load-unit detail was not supplied.'}</p>}
   <p className="text-muted-foreground">{hu?'A térbeli rakhatóság és a tengelyterhelés nincs igazolva.':'Spatial loading feasibility and axle loads have not been verified.'}</p>
  </>}
 </section>;
}
