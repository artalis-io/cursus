import type {Plan,SurgeRequest} from './types.js';
import type {LoadedDay} from './data/dataset.js';
import {evidenceCodes,type PlanningIssue,type PlanningEvidence} from './planning-evidence-contract.js';
export type {PlanningIssue,PlanningEvidence} from './planning-evidence-contract.js';
export function parsePlanningEvidence(value:unknown,request?:SurgeRequest):PlanningEvidence{
 const v=value as PlanningEvidence;
 const need=(ok:unknown):void=>{if(!ok)throw Error('Invalid preliminary planning evidence');};
 need(v&&v.version===1&&/^[a-f0-9]{64}$/.test(v.sourceSha256)&&v.pricing==='unverified'&&Array.isArray(v.issues)&&v.issues.length>0&&v.issues.length<=20000);
 need(v.datasetSha256===undefined||/^[a-f0-9]{64}$/.test(v.datasetSha256!));
 const reqs=request&&new Set(request.requests.map(r=>r.id)),vehicles=request&&new Set(request.vehicles.map(v=>v.id)),seen=new Set<string>();
 for(const i of v.issues){
  need(i&&evidenceCodes.includes(i.code)&&typeof i.message==='string'&&i.message.trim().length>0&&i.message.length<=1000);
  for(const [id,scope] of [[i.requestId,reqs],[i.vehicleId,vehicles]] as const)need(id===undefined||Number.isSafeInteger(id)&&id>=0&&(!scope||scope.has(id)));
  const key=JSON.stringify([i.code,i.requestId,i.vehicleId]);need(!seen.has(key));seen.add(key);
 }
 need(v.issues.some(i=>i.code==='tariff'&&i.requestId===undefined&&i.vehicleId===undefined));
 return structuredClone(v);
}
export function hasPlanningIssue(e:PlanningEvidence|undefined,code:PlanningIssue['code'],requestId?:number,vehicleId?:number){return e?.issues.some(i=>i.code===code&&i.requestId===requestId&&i.vehicleId===vehicleId)===true;}
export function withPlanningEvidence(plan:Plan,day:LoadedDay):Plan{
 if(!day.planningEvidence)return plan;
 const ids=new Set(day.request.requests.map(r=>r.id));
 const evidence={...structuredClone(day.planningEvidence),datasetSha256:day.datasetRequestSha256,issues:day.planningEvidence.issues.filter(i=>i.requestId===undefined||ids.has(i.requestId))};
 plan.provenance.planningEvidence=evidence;
 plan.cost=null;delete plan.provenance.costing;
 for(const v of plan.vehicles){
  v.unknownFacts=evidence.issues.filter(i=>i.vehicleId===v.id).map(i=>i.code);
  for(const t of v.trips){t.costFt=null;for(const s of t.stops)s.unknownFacts=evidence.issues.filter(i=>i.requestId===s.requestId&&i.requestId!==undefined).map(i=>i.code);}
 }
 return plan;
}
