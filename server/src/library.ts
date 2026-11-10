import type {Plan} from './types.js';
import type {Scenario} from './store.js';
import type {PlanIdentity} from './library-contract.js';
/** Legacy has no authoritative approval ledger. Never infer approval from validity. */
export function legacyLibraryPlan(p:Plan,scenario:Scenario|undefined,latestId:string|undefined){
 const identity:PlanIdentity={version:1,planId:p.id,scenarioId:p.scenarioId,planRevision:p.scenarioRevision,scenarioRevision:scenario?.revision??-1,
   selected:!!scenario&&(scenario.selectedPlanId??scenario.manualPlanId)===p.id,latest:latestId===p.id,
   approval:'unknown',freshness:'unknown',checkedAt:new Date().toISOString(),planSha256:null};
 return {id:p.id,scenarioId:p.scenarioId,day:scenario?.day??null,label:scenario?.label??p.scenarioId,source:p.source,createdAt:p.createdAt,
   termination:p.provenance.termination,servedOrders:p.stats.servedOrders,totalOrders:p.stats.totalOrders,vehiclesUsed:p.stats.vehiclesUsed,totalDistanceKm:p.stats.totalDistanceKm,identity};
}
