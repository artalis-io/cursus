import {test,expect} from '@playwright/test';
import {validCostReview} from '../src/lib/cost-review';
import type {Plan} from '../src/types';
import type {CostReview} from '../../server/src/cost-review-contract';
function fixture(){
 const p={id:'priced-plan',scenarioId:'scenario',scenarioRevision:3,createdAt:'2026-11-10T00:00:00Z',provenance:{inputSha256:'a'.repeat(64),tariffSha256:'b'.repeat(64)},
  cost:{currency:'HUF',source:'external',total:12,fixed:10,variable:2,perVehicle:[{vehicleId:7,ref:'V7',vehicleClass:null,distanceKm:2,fixedCost:10,variableCost:2,totalCost:12}]},
  vehicles:[{id:7,ref:'V7',vehicleClass:null,isSubcontractor:false,distanceKm:2,trips:[{index:0,distanceKm:2,stops:[{},{}],costFt:12}]}]} as unknown as Plan;
 const r:CostReview={version:1,planId:p.id,scenarioId:p.scenarioId,scenarioRevision:3,inputSha256:p.provenance.inputSha256,createdAt:p.createdAt,currentScenarioRevision:3,status:'verified',issues:[],
  total:12,fixed:10,variable:2,currency:'HUF',source:'external',tariffSha256:'b'.repeat(64),model:'per_vehicle',evidence:'matched_tariff',tariffFreshness:'current',currentTariffSha256:'b'.repeat(64),
  vehicles:[{vehicleId:7,ref:'V7',distanceKm:2,pricedDistanceKm:2,fixed:10,variable:2,total:12,rates:{vehicleId:7,vehicleClass:null,isSubcontractor:false,fixedBase:10,perKm:1,perDrop:0,includedDrops:0,multiplier:1},
   trips:[{index:0,distanceKm:2,pricedDistanceKm:2,drops:2,extraDrops:null,allocatedTotal:12,referenceEstimate:12,allocationAdjustment:0}]}]};return {p,r};
}
test('cost evidence stays bound to exact saved totals, tariff, vehicle and trip identities',()=>{
 const {p,r}=fixture();expect(validCostReview(r,p)).toBe(true);
 for(const mutate of [(r:CostReview)=>r.planId='borrowed',(r:CostReview)=>r.scenarioRevision++,(r:CostReview)=>r.inputSha256='x',
  (r:CostReview)=>r.total=13,(r:CostReview)=>r.currency='EUR',(r:CostReview)=>r.tariffSha256='c'.repeat(64),
  (r:CostReview)=>r.currentTariffSha256='c'.repeat(64),(r:CostReview)=>r.vehicles[0].vehicleId=99,
  (r:CostReview)=>r.vehicles[0].rates=null,(r:CostReview)=>r.vehicles[0].trips[0].index=9,
  (r:CostReview)=>r.vehicles[0].trips[0].allocatedTotal=13,(r:CostReview)=>r.vehicles[0].trips[0].referenceEstimate=NaN]){
  const bad=structuredClone(r);mutate(bad);expect(validCostReview(bad,p)).toBe(false);
 }
 expect(validCostReview({...r,vehicles:[null]},p)).toBe(false);expect(validCostReview({...r,vehicles:[{...r.vehicles[0],trips:[null]}]},p)).toBe(false);
});
test('partial and contradictory cost evidence cannot smuggle formulas; changed tariff does not overwrite saved amounts',()=>{
 const {p,r}=fixture();const partial=structuredClone(r);partial.status='partial';partial.issues=['missing_rates'];partial.evidence='missing';partial.model=null;partial.tariffFreshness='unknown';
 expect(validCostReview(partial,p)).toBe(false);partial.vehicles.forEach(v=>{v.rates=null;v.trips.forEach(t=>{t.extraDrops=null;t.referenceEstimate=null;t.allocationAdjustment=null;});});expect(validCostReview(partial,p)).toBe(true);
 r.tariffFreshness='changed';r.currentTariffSha256='c'.repeat(64);expect(validCostReview(r,p)).toBe(true);expect(r.total).toBe(12);
});
