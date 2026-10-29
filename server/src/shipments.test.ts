import test from 'node:test';
import assert from 'node:assert/strict';
import {validateShipments,summarizeShipments} from './shipments.js';
import type {ShipmentDocument} from './shipment-contract.js';
import {preparedBundle} from './state/prepared-bundle.js';
import {shipmentFixture} from './state/shipment-fixture.js';

test('commercial references may repeat while delivery, allocation and native identities stay distinct',()=>{
 const f=shipmentFixture(),before=structuredClone(f.document);
 assert.deepEqual(validateShipments(f.document,f.request,'a'.repeat(64)),f.document);
 assert.deepEqual(f.document,before);
 assert.equal(f.document.deliveries.reduce((sum,d)=>sum+d.planningWeightKg,0),200);
 assert.equal(f.document.deliveries.reduce((sum,d)=>sum+d.palletEquivalent,0),2);
});

test('indivisible is the default; split deliveries require explicit source permission and exact allocations',()=>{
 const f=shipmentFixture();f.document.shipments.splice(1,1);
 f.document.shipments[0]!.lines[0]!.quantity=2;f.document.shipments[0]!.lines[0]!.grossWeightKg=200;
 for(const delivery of f.document.deliveries){delivery.shipmentId='commercial-1';delivery.allocations[0]!.quantity=1;}
 delete (f.document.shipments[0] as Partial<ShipmentDocument['shipments'][number]>).splitPolicy;
 assert.throws(()=>validateShipments(f.document,f.request,'a'.repeat(64)),/indivisible/);
 f.document.shipments[0]!.splitPolicy='explicit';
 assert.doesNotThrow(()=>validateShipments(f.document,f.request,'a'.repeat(64)));
 f.document.deliveries[1]!.allocations[0]!.quantity=.5;
 assert.throws(()=>validateShipments(f.document,f.request,'a'.repeat(64)),/weight|quantities/);
});

test('missing, duplicated, cross-dataset or contradictory metadata never becomes solver evidence',()=>{
 for(const change of [
  (d:ShipmentDocument)=>{d.deliveries.pop();},
  (d:ShipmentDocument)=>{d.deliveries[1]!.requestId=91;},
  (d:ShipmentDocument)=>{d.deliveries[0]!.locationId=2;},
  (d:ShipmentDocument)=>{d.datasetSha256='b'.repeat(64);},
  (d:ShipmentDocument)=>{d.deliveries[0]!.date='2026-02-30';},
  (d:ShipmentDocument)=>{d.deliveries[0]!.planningWeightKg=99;},
  (d:ShipmentDocument)=>{d.deliveries[0]!.allocations[0]!.lineId='missing';},
  (d:ShipmentDocument)=>{d.deliveries[0]!.loadUnits[0]!.quantity=.5;},
  (d:ShipmentDocument)=>{d.shipments[0]!.lines[0]!.unit='';},
  (d:ShipmentDocument)=>{d.shipments[0]!.lines[0]!.netWeightKg=200;},
 ]){const f=shipmentFixture();change(f.document);assert.throws(()=>validateShipments(f.document,f.request,'a'.repeat(64)));}
});

test('native summaries require explicit row IDs and never invent commercial grouping or weight basis',()=>{
 const f=shipmentFixture(),rows=f.request.requests.map((r,i)=>({request_id:r.id,order_no:f.request.tasks[i]!.ref,delivery_date:'2026-10-26'}));
 const document=summarizeShipments(f.request,rows,'a'.repeat(64),[{isoDate:'2026-10-26'}]);
 assert.deepEqual(document.shipments,[]);assert.ok(document.deliveries.every(d=>d.detail==='summary'&&d.shipmentId===null&&d.weightBasis==='unspecified'));
 delete (rows[0] as Partial<typeof rows[number]>).request_id;
 assert.throws(()=>summarizeShipments(f.request,rows,'a'.repeat(64),[{isoDate:'2026-10-26'}]),/identities/);
});

test('prepared bundles preserve sparse IDs and require complete matrices and explicit source access facts',()=>{
 const f=shipmentFixture(),bundle={schemaVersion:1,days:[{dayId:'public-day',isoDate:'2026-10-26'}],surgeRequest:f.request,
  geocoded:f.request.requests.map((r,i)=>({request_id:r.id,order_no:f.request.tasks[i]!.ref,delivery_date:'2026-10-26',requires_tail_lift:false,max_gross_weight_kg:null}))};
 const result=preparedBundle(bundle);assert.deepEqual(result.shipments.deliveries.map(d=>d.requestId),[91,92]);
 bundle.surgeRequest.travel.distances.pop();assert.throws(()=>preparedBundle(bundle),/matrix/);
});
