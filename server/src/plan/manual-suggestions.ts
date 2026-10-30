import { setImmediate } from 'node:timers/promises';
import { applyManualBatch, type ManualCommand } from './manual.js';
import { evaluateManualInput } from './manual-adapter.js';
import { manualTripKey, type ManualEvaluationInput, type ManualViolation } from './manual-evaluate.js';
import type { Scenario } from '../store.js';

export interface PlacementSuggestion {
  vehicleId:number; tripId:string; position:number; newTrip:boolean;
  delta:{distanceKm:number;cost:number;vehicles:number;trips:number;finishSec:number|null};
  serviceStartSec:number; tripEndSec:number;
}
export interface PlacementSuggestions {
  parentPlanId:string; revision:number; datasetSha256:string; requestId:number;
  currency:string; checked:number; complete:boolean; feasiblePositions:number;
  baseline:{distanceKm:number;cost:number;served:number;vehicles:number;trips:number};
  suggestions:PlacementSuggestion[];
  vehicles:{vehicleId:number;checked:number;feasible:number;skipped?:'excluded'|'locked';blockers:ManualViolation[]}[];
}

/** Bounded local insertion search, not another optimizer or a proof that an
 * unassigned delivery is impossible. Every returned placement validates the
 * COMPLETE draft, including downstream trips and all existing constraints. */
export async function suggestPlacements(input:ManualEvaluationInput,scenario:Scenario,requestId:number,
  identity:{parentPlanId:string;newTripId:string}, limits={candidates:750,milliseconds:1500}):Promise<PlacementSuggestions>{
  if(!input.layout.unassigned.includes(requestId))throw new Error('Delivery is not unassigned.');
  const baseline=evaluateManualInput(input,input.layout,scenario);
  const result:PlacementSuggestions={parentPlanId:identity.parentPlanId,revision:scenario.revision,datasetSha256:input.datasetSha256,
    requestId,currency:baseline.cost.currency,checked:0,complete:true,feasiblePositions:0,
    baseline:{distanceKm:baseline.stats.totalDistanceKm,cost:baseline.cost.total,served:baseline.stats.servedOrders,vehicles:baseline.stats.vehiclesUsed,trips:baseline.stats.trips},suggestions:[],vehicles:[]};
  const started=performance.now(),at=new Date().toISOString();
  const best=new Map<number,PlacementSuggestion>();
  const compare=(a:PlacementSuggestion,b:PlacementSuggestion)=>a.delta.cost-b.delta.cost||a.delta.distanceKm-b.delta.distanceKm||
    (a.delta.finishSec??Infinity)-(b.delta.finishSec??Infinity)||a.vehicleId-b.vehicleId||a.tripId.localeCompare(b.tripId)||a.position-b.position;
  for(const vehicleId of input.layout.vehicleIds){
    const row:PlacementSuggestions['vehicles'][number]={vehicleId,checked:0,feasible:0,blockers:[]};result.vehicles.push(row);
    if(input.layout.excludedVehicleIds.includes(vehicleId)){row.skipped='excluded';continue;}
    if(input.layout.lockedVehicleIds.includes(vehicleId)){row.skipped='locked';continue;}
    const routes=input.layout.routes.filter(route=>route.vehicleId===vehicleId);
    const positions=routes.flatMap(route=>Array.from({length:route.requestIds.length+1},(_,position)=>({tripId:route.tripId,position,newTrip:false})));
    positions.push({tripId:identity.newTripId,position:0,newTrip:true});
    for(const target of positions){
      if(result.checked>=limits.candidates||performance.now()-started>=limits.milliseconds){result.complete=false;return finish();}
      // Yield to health checks and other HTTP requests during CPU work.
      if(result.checked%8===0)await setImmediate();
      const command:ManualCommand={op:'assign',requestId,vehicleId,tripId:target.tripId,position:target.position};
      const layout=applyManualBatch(input.layout,{operationId:identity.newTripId,datasetSha256:input.datasetSha256,commands:[command]},
        {actorId:'placement-preview',at}); // ephemeral evaluation only; never published
      const departures=new Map(input.departures);
      if(target.newTrip)departures.set(manualTripKey(vehicleId,target.tripId),input.request.vehicles.find(v=>v.id===vehicleId)!.shift_early??0);
      const evaluated=evaluateManualInput({...input,layout,departures},input.layout,scenario);
      result.checked++;row.checked++;
      if(!evaluated.validation.valid){
        for(const violation of evaluated.validation.violations)if(!row.blockers.some(v=>v.type===violation.type&&v.dimension===violation.dimension))row.blockers.push(violation);
        continue;
      }
      row.feasible++;result.feasiblePositions++;
      const route=evaluated.vehicles.find(v=>v.vehicleId===vehicleId)!.trips.find(t=>t.tripId===target.tripId)!;
      const end=(vs:typeof evaluated.vehicles)=>Math.max(0,...vs.find(v=>v.vehicleId===vehicleId)?.trips.map(t=>t.endSec)??[]);
      const suggestion:PlacementSuggestion={vehicleId,...target,serviceStartSec:route.stops.find(s=>s.requestId===requestId)!.serviceStartSec,tripEndSec:route.endSec,
        delta:{distanceKm:evaluated.stats.totalDistanceKm-baseline.stats.totalDistanceKm,cost:evaluated.cost.total-baseline.cost.total,
          vehicles:evaluated.stats.vehiclesUsed-baseline.stats.vehiclesUsed,trips:evaluated.stats.trips-baseline.stats.trips,
          finishSec:baseline.vehicles.some(v=>v.vehicleId===vehicleId)?end(evaluated.vehicles)-end(baseline.vehicles):null}};
      if(!best.has(vehicleId)||compare(suggestion,best.get(vehicleId)!)<0)best.set(vehicleId,suggestion);
    }
  }
  return finish();
  function finish(){result.suggestions=[...best.values()].sort(compare).slice(0,5);return result;}
}
