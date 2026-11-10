import test from 'node:test';
import assert from 'node:assert/strict';
import {manualFixture} from './state/manual-fixture.js';
import {costReview,captureCosting} from './cost-review.js';
import {vehicleCostFor,tripCost,reconcileTripCosts,tariffIdentity,type Tariff} from './cost.js';
import type {Plan} from './types.js';

function pricedPlan(tariff:Tariff,distances=[1.25,2.25,3.25]):Plan {
 const p=manualFixture().parent,v=p.vehicles[0]!;v.isSubcontractor=false;v.vehicleClass='SEMI_TRAILER';
 v.trips=distances.map((distanceKm,index)=>({...structuredClone(v.trips[0]!),index,distanceKm,stops:structuredClone(v.trips[0]!.stops)}));
 v.tripCount=v.trips.length;v.distanceKm=distances.reduce((sum,n)=>sum+n,0);
 const priced=(km:number)=>Math.round(km*10)/10,shape={...v,distanceKm:priced(v.distanceKm),trips:v.trips.map(t=>({distanceKm:priced(t.distanceKm),drops:t.stops.length}))};
 const c=vehicleCostFor(tariff,shape),costs=reconcileTripCosts(c.total,v.trips.map(t=>tripCost(tariff,v,{distanceKm:priced(t.distanceKm),drops:t.stops.length},v.trips.length)));
 v.trips.forEach((t,i)=>{t.costFt=costs[i]!;});
 p.cost={currency:tariff.currency,source:tariff.source,total:c.total,fixed:c.fixed,variable:c.variable,perVehicle:[{vehicleId:v.id,ref:v.ref,vehicleClass:v.vehicleClass,distanceKm:v.distanceKm,fixedCost:c.fixed,variableCost:c.variable,totalCost:c.total}]};
 p.provenance.tariffSha256=tariffIdentity(tariff);p.provenance.costing=captureCosting(p,tariff);return p;
}
const tariff:Tariff={currency:'HUF',source:'external',model:'per_vehicle',fixedPerVehicle:99,perKmDefault:2.25,fixedByClass:{SEMI:10.2,TRAILER:500},perKmByClass:{SEMI:1.25,TRAILER:50},perTripBase:3.4,perKm:1.25,perDrop:2.3,includedDrops:1,ownFleetMultiplier:0.8,subcontractorMultiplier:1.1};
for(const model of ['per_vehicle','per_trip'] as const)test(`${model}: recorded rates reproduce saved costs and allocated trips without repricing`,()=>{
 const t={...tariff,model},p=pricedPlan(t),before=structuredClone(p),r=costReview(p,{currentTariff:t,currentScenarioRevision:p.scenarioRevision});
 assert.equal(r.status,'verified');assert.equal(r.evidence,'saved_rates');assert.equal(r.tariffFreshness,'current');assert.deepEqual(r.issues,[]);assert.deepEqual(p,before);
 assert.equal(r.total,p.cost!.total);assert.equal(r.vehicles.reduce((s,v)=>s+v.total,0),r.total);
 for(const v of r.vehicles){assert.equal(v.fixed+v.variable,v.total);assert.equal(v.trips.reduce((s,t)=>s+t.allocatedTotal!,0),v.total);for(const trip of v.trips)assert.equal(trip.referenceEstimate!+trip.allocationAdjustment!,trip.allocatedTotal);}
});
test('standing charge is paid once across multiple trips; whole EUR rounding remains unchanged',()=>{
 const t={...tariff,currency:'EUR',fixedByClass:{},fixedPerVehicle:10.2,perKmByClass:{},perKmDefault:1.25},p=pricedPlan(t),r=costReview(p,{currentTariff:t});
 assert.equal(r.fixed,10);assert.equal(r.variable,9);assert.equal(r.total,19);assert.equal(r.vehicles[0]!.rates!.multiplier,1,'own-fleet multiplier is not applied in per-vehicle model');
 for(const fixedPerVehicle of [1,2]){const tiny={...t,fixedPerVehicle,perKmDefault:0};const allocation=costReview(pricedPlan(tiny,[0,0,0]));assert.equal(allocation.status,'verified');assert.ok(allocation.vehicles[0]!.trips.some(t=>t.allocationAdjustment!==0),'rounding allocation must be explained');}
});
test('subcontractor multipliers remain part of both fixed and variable charges',()=>{
 for(const model of ['per_vehicle','per_trip'] as const){const t={...tariff,model};const p=pricedPlan(t);p.vehicles[0]!.isSubcontractor=true;
 const v=p.vehicles[0]!,shape={...v,distanceKm:Math.round(v.distanceKm*10)/10,trips:v.trips.map(tr=>({distanceKm:Math.round(tr.distanceKm*10)/10,drops:tr.stops.length}))},c=vehicleCostFor(t,shape);
 const costs=reconcileTripCosts(c.total,v.trips.map(tr=>tripCost(t,v,{distanceKm:Math.round(tr.distanceKm*10)/10,drops:tr.stops.length},v.trips.length)));v.trips.forEach((tr,i)=>tr.costFt=costs[i]!);
 Object.assign(p.cost!,{total:c.total,fixed:c.fixed,variable:c.variable});Object.assign(p.cost!.perVehicle[0]!,{totalCost:c.total,fixedCost:c.fixed,variableCost:c.variable});p.provenance.costing=captureCosting(p,t);
 const r=costReview(p,{currentTariff:t});assert.equal(r.status,'verified');assert.equal(r.vehicles[0]!.rates!.multiplier,1.1);}
});
test('saved effective class precedence survives reordered JSONB and detects changed effective pricing',()=>{
 const p=pricedPlan(tariff),copy=JSON.parse(JSON.stringify(p)) as Plan;
 const reordered={...tariff,perKmByClass:{TRAILER:50,SEMI:1.25},fixedByClass:{TRAILER:500,SEMI:10.2}};
 assert.equal(tariffIdentity(tariff),tariffIdentity(reordered),'legacy identity is canonical, even when precedence is not');
 const r=costReview(copy,{currentTariff:reordered});assert.equal(r.status,'verified');assert.equal(r.vehicles[0]!.rates!.perKm,1.25);assert.equal(r.tariffFreshness,'changed');
 delete copy.provenance.costing;assert.equal(costReview(copy,{currentTariff:reordered}).status,'partial');assert.ok(costReview(copy,{currentTariff:reordered}).issues.includes('ambiguous_class_rates'));
});
test('historical matching checksum permits only unambiguous, reconciling rates',()=>{
 const t={...tariff,fixedByClass:{},perKmByClass:{}},p=pricedPlan(t);delete p.provenance.costing;
 assert.equal(costReview(p,{currentTariff:t}).status,'verified');assert.equal(costReview(p,{currentTariff:t}).evidence,'matched_tariff');
 const altered={...t,perKmDefault:100};const r=costReview(p,{currentTariff:altered});assert.equal(r.status,'partial');assert.equal(r.tariffFreshness,'changed');assert.equal(r.vehicles[0]!.rates,null);
 delete p.provenance.tariffSha256;assert.equal(costReview(p,{currentTariff:t}).status,'partial','equal-looking costs never establish historical identity');
});
test('recorded historical rates remain inspectable after tariff changes without modifying totals',()=>{
 const p=pricedPlan(tariff),r=costReview(p,{currentTariff:{...tariff,perKmDefault:50},currentScenarioRevision:99});
 assert.equal(r.status,'verified');assert.equal(r.tariffFreshness,'changed');assert.equal(r.currentScenarioRevision,99);assert.equal(r.total,p.cost!.total);
});
test('missing cost, tariff and trip evidence are honest unknowns',()=>{
 const p=pricedPlan(tariff);delete p.provenance.costing;
 const r=costReview(p);assert.equal(r.status,'partial');assert.equal(r.vehicles[0]!.rates,null);assert.equal(r.total,p.cost!.total);
 p.vehicles[0]!.trips[0]!.costFt=null;assert.ok(costReview(p).issues.includes('trip_allocation_missing'));
 p.cost=null;assert.equal(costReview(p).status,'unavailable');assert.equal(costReview(p).total,null);
});
for(const change of ['identity','revision','rates','total','trip','duplicate'] as const)test(`contradictory ${change} evidence withholds all formulas and never repairs the plan`,()=>{
 const p=pricedPlan(tariff);
 if(change==='identity')p.provenance.costing!.planId='foreign';
 if(change==='revision')p.provenance.costing!.scenarioRevision++;
 if(change==='rates')p.provenance.costing!.rates[0]!.perKm++;
 if(change==='total')p.cost!.total++;
 if(change==='trip')p.vehicles[0]!.trips[0]!.costFt!++;
 if(change==='duplicate')p.cost!.perVehicle.push({...p.cost!.perVehicle[0]!});
 const before=structuredClone(p),r=costReview(p,{currentTariff:tariff});assert.equal(r.status,'inconsistent');assert.ok(r.vehicles.every(v=>v.rates===null));assert.deepEqual(p,before);
});
test('captured evidence excludes unrelated confidential fields and unused rate-card rows',()=>{
 const p=pricedPlan(tariff),snapshot=captureCosting(p,{...tariff,credentials:'must not be persisted'} as Tariff);
 assert.ok(!JSON.stringify(snapshot).includes('must not'));assert.ok(!JSON.stringify(snapshot).includes('TRAILER":500'));
});

test('unknown vehicles and omitted rate metadata cannot masquerade as a complete snapshot',()=>{
 const p=pricedPlan(tariff),rate=p.provenance.costing!.rates[0]!;rate.vehicleId=999;Reflect.deleteProperty(rate,'vehicleClass');Reflect.deleteProperty(rate,'isSubcontractor');
 const r=costReview(p);assert.equal(r.status,'inconsistent');assert.ok(r.issues.includes('invalid_snapshot'));assert.ok(r.vehicles.every(v=>v.rates===null));
});
