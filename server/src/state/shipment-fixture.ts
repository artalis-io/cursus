import {manualFixture} from './manual-fixture.js';
import type {ShipmentDocument} from '../shipment-contract.js';
/** Non-confidential commercial/physical metadata for authoritative tests. */
export function shipmentFixture(){
 const f=manualFixture(),request=f.context.day.request;
 const document:ShipmentDocument={schemaVersion:1,datasetSha256:'a'.repeat(64),shipments:[
  {id:'commercial-1',reference:'Repeated reference',splitPolicy:'indivisible',lines:[{id:'line',productRef:'SKU-1',quantity:10,unit:'case',netWeightKg:90,grossWeightKg:100}]},
  {id:'commercial-2',reference:'Repeated reference',splitPolicy:'indivisible',lines:[{id:'line',productRef:'SKU-2',quantity:20,unit:'case',grossWeightKg:100}]},
 ],deliveries:request.requests.map((order,i)=>({id:`delivery-${i}`,requestId:order.id,reference:request.tasks[i]!.ref,locationId:i+1,date:'2026-10-26',
  shipmentId:`commercial-${i+1}`,allocations:[{lineId:'line',quantity:i===0?10:20}],planningWeightKg:100,palletEquivalent:1,weightBasis:'gross',detail:'line_items',
  loadUnits:[{id:'pallet',kind:'EUR pallet',quantity:1,stackable:false,grossWeightKg:100}]}))};
 return {...f,request,document};
}
