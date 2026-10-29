import type { Plan,SurgeRequest } from '../types.js';
import type {Scenario} from '../store.js';
import {prepareManualInput,evaluateManualInput,type ManualDatasetContext} from './manual-adapter.js';
/** Existing native initial_routes are hints, never a claim that the incumbent
 * is retained verbatim. UI candidate adoption remains explicit either way. */
export function warmStart(request:SurgeRequest,plan:Plan|undefined,scenario:Scenario,context:ManualDatasetContext):boolean {
 if(!plan||plan.scenarioId!==scenario.id||plan.scenarioRevision!==scenario.revision)return false;
 try{
  const input=prepareManualInput(plan,scenario,context),checked=evaluateManualInput(input,input.layout,scenario);
  if(!checked.validation.valid)return false;
  const available=new Set(request.vehicles.map(v=>v.id));
  if(plan.vehicles.some(v=>!available.has(v.id)))return false;
  const routes=plan.vehicles.map(v=>({vehicle_id:v.id,request_ids:v.trips.flatMap(t=>t.stops.map(s=>s.requestId!))}));
  if(routes.some(r=>r.request_ids.some(id=>!Number.isSafeInteger(id))))return false;
  (request as SurgeRequest&{initial_routes:typeof routes}).initial_routes=routes;return true;
 }catch{return false;}
}
