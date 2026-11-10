import type {CostReview,CostRates} from '../../../server/src/cost-review-contract';
import type {Plan} from '../types';
const number=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
const amount=(n:unknown):n is number=>number(n)&&Number.isSafeInteger(n);
const sha=(s:unknown)=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
function rates(v:unknown):v is CostRates {
  if(!v||typeof v!=='object')return false;const r=v as CostRates;
  return Number.isSafeInteger(r.vehicleId)&&r.vehicleId>=0&&(r.vehicleClass===null||typeof r.vehicleClass==='string')&&typeof r.isSubcontractor==='boolean'&&
    [r.fixedBase,r.perKm,r.perDrop,r.includedDrops,r.multiplier].every(number);
}
/** Cost formulas must belong to the exact viewed immutable plan, never a late response. */
export function validCostReview(value:unknown,p:Plan):value is CostReview {
  try{return checkCostReview(value,p);}catch{return false;}
}
function checkCostReview(value:unknown,p:Plan):value is CostReview {
  if(!value||typeof value!=='object')return false;const r=value as CostReview,c=p.cost;
  if(r.version!==1||r.planId!==p.id||r.scenarioId!==p.scenarioId||r.scenarioRevision!==p.scenarioRevision||r.inputSha256!==p.provenance.inputSha256||r.createdAt!==p.createdAt||
    !['verified','partial','inconsistent','unavailable'].includes(r.status)||!['saved_rates','matched_tariff','missing','invalid'].includes(r.evidence)||!['current','changed','unknown'].includes(r.tariffFreshness)||
    !Array.isArray(r.issues)||!r.issues.every(x=>['missing_cost','missing_rates','invalid_snapshot','ambiguous_class_rates','amount_mismatch','trip_allocation_missing'].includes(x))||
    r.total!==(c?.total??null)||r.fixed!==(c?.fixed??null)||r.variable!==(c?.variable??null)||r.currency!==(c?.currency??null)||r.source!==(c?.source??null)||
    !(r.model===null||r.model==='per_vehicle'||r.model==='per_trip')||!(r.tariffSha256===null||sha(r.tariffSha256))||!(r.currentTariffSha256===null||sha(r.currentTariffSha256))||
    !(r.currentScenarioRevision===null||Number.isSafeInteger(r.currentScenarioRevision)&&r.currentScenarioRevision>=0)||!Array.isArray(r.vehicles)||new Set(r.vehicles.map(v=>v?.vehicleId)).size!==r.vehicles.length)return false;
  if(r.status==='unavailable')return !c&&r.vehicles.length===0&&r.issues.includes('missing_cost');
  if(!c)return false;
  if(r.status==='verified'&&(r.issues.length!==0||!sha(r.tariffSha256)||!r.model||!['saved_rates','matched_tariff'].includes(r.evidence)||r.vehicles.length!==p.vehicles.length||
    ![r.total,r.fixed,r.variable].every(amount)||r.fixed!+r.variable! !== r.total))return false;
  if(r.status!=='verified'&&!r.issues.length)return false;
  if(r.tariffFreshness==='current'&&r.tariffSha256!==r.currentTariffSha256)return false;
  const snapshot=p.provenance.costing;
  if(r.status==='verified'&&(p.provenance.tariffSha256&&p.provenance.tariffSha256!==r.tariffSha256||r.evidence==='saved_rates'&&!snapshot))return false;
  if(snapshot&&r.status==='verified'&&(snapshot.version!==1||snapshot.planId!==p.id||snapshot.scenarioId!==p.scenarioId||snapshot.scenarioRevision!==p.scenarioRevision||snapshot.inputSha256!==p.provenance.inputSha256||snapshot.tariffSha256!==r.tariffSha256||snapshot.model!==r.model))return false;
  if(r.tariffFreshness!=='unknown'&&(!sha(r.tariffSha256)||!sha(r.currentTariffSha256)))return false;
  return r.vehicles.every(row=>{
    const v=p.vehicles.find(x=>x.id===row?.vehicleId),saved=c.perVehicle.find(x=>x.vehicleId===row?.vehicleId);
    if(!v||!saved||row.ref!==v.ref||row.distanceKm!==v.distanceKm||row.fixed!==saved.fixedCost||row.variable!==saved.variableCost||row.total!==saved.totalCost||!number(row.pricedDistanceKm)||!Array.isArray(row.trips)||row.trips.length!==v.trips.length)return false;
    if(r.status==='verified'&&(!rates(row.rates)||row.rates.vehicleId!==v.id||row.rates.vehicleClass!==v.vehicleClass||row.rates.isSubcontractor!==v.isSubcontractor||row.fixed+row.variable!==row.total))return false;
    if(snapshot&&r.status==='verified'){
      const expected=snapshot.rates.find(rate=>rate.vehicleId===row.vehicleId);
      if(!expected||(['fixedBase','perKm','perDrop','includedDrops','multiplier','vehicleClass','isSubcontractor'] as const).some(key=>expected[key]!==row.rates![key]))return false;
    }
    if(r.status!=='verified'&&row.rates!==null)return false;
    if(r.status==='verified'&&row.trips.reduce((sum,t)=>sum+(t.allocatedTotal??0),0)!==row.total)return false;
    return row.trips.every((trip,i)=>{
      const t=v.trips[i];return t&&trip.index===t.index&&trip.distanceKm===t.distanceKm&&number(trip.pricedDistanceKm)&&trip.drops===t.stops.length&&
        trip.allocatedTotal===(amount(t.costFt)?t.costFt:null)&&
        (r.status==='verified'?amount(trip.referenceEstimate)&&Number.isSafeInteger(trip.allocationAdjustment)&&trip.referenceEstimate+(trip.allocationAdjustment!) === trip.allocatedTotal:
          trip.referenceEstimate===null&&trip.allocationAdjustment===null)&&
        (trip.extraDrops===null||number(trip.extraDrops));
    });
  })&&(r.status!=='verified'||r.vehicles.reduce((sum,v)=>sum+v.total,0)===r.total&&r.vehicles.reduce((sum,v)=>sum+v.fixed,0)===r.fixed&&r.vehicles.reduce((sum,v)=>sum+v.variable,0)===r.variable);
}
