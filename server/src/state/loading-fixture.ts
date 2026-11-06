import {createHash} from 'node:crypto';
import {manualFixture} from './manual-fixture.js';
import type {LoadingDocument} from '../loading-contract.js';
export function loadingFixture(){
 const f=manualFixture(),request=f.context.day.request,sha=createHash('sha256').update(JSON.stringify(request)).digest('hex');
 const document:LoadingDocument={schemaVersion:1,datasetSha256:sha,mode:'disabled',vehicles:request.vehicles.map(v=>({vehicleId:v.id,slotCount:1,maxLayers:2,clearanceMm:2400,maxStackWeightG:200000,payloadG:1000000,access:'rear_lifo',allowedTop:[[0]],slots:[{lane:0,depth:0}]})),requests:request.requests.map(r=>({requestId:r.id,units:[{id:'pallet-1',heightMm:1000,weightG:100000,stackClass:0,maxWeightAboveG:100000,maxUnitsAbove:1}]}))};
 const bundle={schemaVersion:1,surgeRequest:request,days:[{dayId:f.scenario.day,isoDate:'2026-10-26'}],geocoded:request.requests.map((r,i)=>({request_id:r.id,order_no:request.tasks[i]!.ref,delivery_date:'2026-10-26',requires_tail_lift:false,max_gross_weight_kg:null})),physicalLoading:document};
 return {...f,request,sha,document,bundle};
}
