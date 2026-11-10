import {effectiveCostRates,vehicleCostFor,tripCost,reconcileTripCosts,tariffIdentity,type Tariff} from './cost.js';
import {metersToKm} from './units.js';
import type {Plan} from './types.js';
import type {CostingSnapshot,CostRates,CostReview,CostIssue} from './cost-review-contract.js';
const nonnegative=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
const amount=(n:unknown):n is number=>nonnegative(n)&&Number.isSafeInteger(n);
const hash=(s:unknown):s is string=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const priced=(km:number)=>metersToKm(km*1000);

export function captureCosting(plan:Plan,tariff:Tariff):CostingSnapshot {
  return {version:1,planId:plan.id,scenarioId:plan.scenarioId,scenarioRevision:plan.scenarioRevision,inputSha256:plan.provenance.inputSha256,
    tariffSha256:tariffIdentity(tariff),currency:tariff.currency,source:tariff.source,model:tariff.model,
    rates:plan.vehicles.map(v=>({vehicleId:v.id,vehicleClass:v.vehicleClass,isSubcontractor:v.isSubcontractor,...effectiveCostRates(tariff,v)}))};
}
function validSnapshot(value:unknown,p:Plan):value is CostingSnapshot {
  if(!value||typeof value!=='object')return false;
  const s=value as CostingSnapshot,vehicles=new Map(p.vehicles.map(v=>[v.id,v]));
  return s.version===1&&hash(s.inputSha256)&&s.planId===p.id&&s.scenarioId===p.scenarioId&&s.scenarioRevision===p.scenarioRevision&&s.inputSha256===p.provenance.inputSha256&&
    hash(s.tariffSha256)&&(!p.provenance.tariffSha256||s.tariffSha256===p.provenance.tariffSha256)&&s.currency===p.cost?.currency&&s.source===p.cost?.source&&
    ['per_vehicle','per_trip'].includes(s.model)&&Array.isArray(s.rates)&&s.rates.length===p.vehicles.length&&new Set(s.rates.map(r=>r?.vehicleId)).size===s.rates.length&&
    s.rates.every(r=>r&&Number.isSafeInteger(r.vehicleId)&&r.vehicleId>=0&&typeof r.isSubcontractor==='boolean'&&(r.vehicleClass===null||typeof r.vehicleClass==='string')&&[r.fixedBase,r.perKm,r.perDrop,r.includedDrops,r.multiplier].every(nonnegative)&&
      vehicles.has(r.vehicleId)&&vehicles.get(r.vehicleId)?.vehicleClass===r.vehicleClass&&vehicles.get(r.vehicleId)?.isSubcontractor===r.isSubcontractor);
}
function ambiguous(t:Tariff,p:Plan):boolean {
  if(t.model!=='per_vehicle')return false;
  return p.vehicles.some(v=>[t.fixedByClass,t.perKmByClass].some(table=>{
    if(!v.vehicleClass)return false;const key=v.vehicleClass.toUpperCase();if(table[key]!=null)return false;
    return new Set(Object.entries(table).filter(([k])=>key.includes(k)||k.includes(key)).map(([,value])=>value)).size>1;
  }));
}
function tariffFor(s:CostingSnapshot,r:CostRates):Tariff {
  return {currency:s.currency,source:s.source,model:s.model,fixedPerVehicle:r.fixedBase,perKmDefault:r.perKm,
    fixedByClass:{},perKmByClass:{},perTripBase:r.fixedBase,perKm:r.perKm,perDrop:r.perDrop,includedDrops:r.includedDrops,
    ownFleetMultiplier:r.multiplier,subcontractorMultiplier:r.multiplier};
}
/** Read-only explanation: never reprice a saved result or repair its numbers. */
export function costReview(plan:Plan,context:{savedTariff?:Tariff;currentTariff?:Tariff;currentScenarioRevision?:number}={}):CostReview {
  const c=plan.cost,issues=new Set<CostIssue>();
  const r:CostReview={version:1,planId:plan.id,scenarioId:plan.scenarioId,scenarioRevision:plan.scenarioRevision,inputSha256:plan.provenance.inputSha256,
    createdAt:plan.createdAt,currentScenarioRevision:context.currentScenarioRevision??null,status:'unavailable',issues:[],total:c?.total??null,fixed:c?.fixed??null,
    variable:c?.variable??null,currency:c?.currency??null,source:c?.source??null,tariffSha256:plan.provenance.tariffSha256??null,model:null,evidence:'missing',
    tariffFreshness:'unknown',currentTariffSha256:context.currentTariff?tariffIdentity(context.currentTariff):null,vehicles:[]};
  if(!c){r.issues=['missing_cost'];return r;}
  if(!Array.isArray(c.perVehicle)){r.status='inconsistent';r.issues=['amount_mismatch'];return r;}
  let snapshot:CostingSnapshot|undefined;
  if(plan.provenance.costing!==undefined){
    if(validSnapshot(plan.provenance.costing,plan)){snapshot=plan.provenance.costing;r.evidence='saved_rates';}
    else{issues.add('invalid_snapshot');r.evidence='invalid';}
  }else{
    const t=context.savedTariff??context.currentTariff;
    if(t&&hash(plan.provenance.tariffSha256)&&tariffIdentity(t)===plan.provenance.tariffSha256&&t.currency===c.currency&&t.source===c.source){
      if(ambiguous(t,plan))issues.add('ambiguous_class_rates');
      else{snapshot=captureCosting(plan,t);r.evidence='matched_tariff';if(!validSnapshot(snapshot,plan)){snapshot=undefined;issues.add('invalid_snapshot');r.evidence='invalid';}}
    }
  }
  if(snapshot){r.tariffSha256=snapshot.tariffSha256;r.model=snapshot.model;}
  else issues.add('missing_rates');
  if(hash(r.tariffSha256)&&r.currentTariffSha256){
    if(r.tariffSha256!==r.currentTariffSha256)r.tariffFreshness='changed';
    else if(snapshot&&context.currentTariff)r.tariffFreshness=snapshot.rates.every(rate=>{
      const actual=effectiveCostRates(context.currentTariff!,rate);
      return (['fixedBase','perKm','perDrop','includedDrops','multiplier'] as const).every(key=>actual[key]===rate[key]);
    })?'current':'changed';
  }
  const amounts=[c.total,c.fixed,c.variable,...c.perVehicle.flatMap(v=>[v.fixedCost,v.variableCost,v.totalCost])];
  if(!amounts.every(amount)||c.fixed+c.variable!==c.total||
    c.perVehicle.reduce((sum,v)=>sum+v.fixedCost,0)!==c.fixed||c.perVehicle.reduce((sum,v)=>sum+v.variableCost,0)!==c.variable||
    c.perVehicle.reduce((sum,v)=>sum+v.totalCost,0)!==c.total||c.perVehicle.length!==plan.vehicles.length||
    new Set(c.perVehicle.map(v=>v.vehicleId)).size!==c.perVehicle.length||new Set(plan.vehicles.map(v=>v.id)).size!==plan.vehicles.length)issues.add('amount_mismatch');
  const costs=new Map(c.perVehicle.map(v=>[v.vehicleId,v])),ratesById=new Map(snapshot?.rates.map(r=>[r.vehicleId,r])??[]);
  for(const v of plan.vehicles){
    const saved=costs.get(v.id);
    if(!saved||saved.ref!==v.ref||saved.vehicleClass!==v.vehicleClass||saved.distanceKm!==v.distanceKm||saved.fixedCost+saved.variableCost!==saved.totalCost){issues.add('amount_mismatch');continue;}
    const rates=ratesById.get(v.id)??null;
    const tariff=snapshot&&rates?tariffFor(snapshot,rates):undefined;
    const shape={vehicleClass:null,isSubcontractor:true,distanceKm:priced(v.distanceKm),trips:v.trips.map(t=>({distanceKm:priced(t.distanceKm),drops:t.stops.length}))};
    const estimates=tariff?v.trips.map(t=>tripCost(tariff,shape,{distanceKm:priced(t.distanceKm),drops:t.stops.length},v.trips.length)):null;
    if(tariff){
      const expected=vehicleCostFor(tariff,shape);
      if(expected.fixed!==saved.fixedCost||expected.variable!==saved.variableCost||expected.total!==saved.totalCost)issues.add('amount_mismatch');
    }
    if(v.trips.some(t=>!amount(t.costFt))||v.trips.reduce((sum,t)=>sum+(t.costFt??0),0)!==saved.totalCost)issues.add('trip_allocation_missing');
    const allocated=estimates&&amount(saved.totalCost)&&estimates.every(amount)&&v.trips.length?reconcileTripCosts(saved.totalCost,estimates):null;
    r.vehicles.push({vehicleId:v.id,ref:v.ref,distanceKm:v.distanceKm,pricedDistanceKm:priced(v.distanceKm),fixed:saved.fixedCost,variable:saved.variableCost,total:saved.totalCost,rates,
      trips:v.trips.map((t,index)=>{
        if(allocated&&allocated[index]!==t.costFt)issues.add('amount_mismatch');
        return {index:t.index,distanceKm:t.distanceKm,pricedDistanceKm:priced(t.distanceKm),drops:t.stops.length,
          extraDrops:rates&&snapshot?.model==='per_trip'?Math.max(0,t.stops.length-rates.includedDrops):null,allocatedTotal:amount(t.costFt)?t.costFt:null,
          referenceEstimate:estimates?.[index]??null,allocationAdjustment:estimates&&amount(t.costFt)?t.costFt-estimates[index]!:null};
      })});
  }
  r.issues=[...issues];r.status=issues.has('invalid_snapshot')||issues.has('amount_mismatch')?'inconsistent':issues.size?'partial':'verified';
  // Contradictory evidence cannot provide formulas, including on otherwise valid rows.
  if(r.status!=='verified')for(const v of r.vehicles){v.rates=null;for(const t of v.trips){t.referenceEstimate=null;t.allocationAdjustment=null;t.extraDrops=null;}}
  return r;
}
