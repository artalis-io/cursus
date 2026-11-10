import {approvalBlockerCodes,type ApprovalBlockerEvidence,type ApprovalBlockerTarget,type Workflow} from '../../../server/src/workflow-contract';
import type {Plan,Selection,ValidationViolation} from '../types';
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
export function validBlockerTarget(value:unknown):value is ApprovalBlockerTarget{
 if(!value||typeof value!=='object')return false;
 const t=value as Record<string,unknown>;
 if(t.kind==='section')return typeof t.section==='string'&&['issues','changes','constraints','loading'].includes(t.section);
 if(!integer(t.vehicleId))return false;
 if(t.kind==='vehicle')return true;
 if(!integer(t.tripIndex))return false;
 if(t.kind==='trip')return true;
 return t.kind==='stop'&&integer(t.seq)&&typeof t.orderNo==='string'&&t.orderNo.length>0&&(t.requestId===undefined||integer(t.requestId));
}
/** Validate the extension without weakening the legacy string-based gate. */
export function validBlockerEvidence(w:Workflow,planId?:string):boolean{
 const d=w.blockerDetails;if(d===undefined)return true;
 if(!d||d.version!==1||typeof d.planId!=='string'||!d.planId||typeof d.scenarioId!=='string'||!d.scenarioId||
  planId!==undefined&&d.planId!==planId||d.planRevision!==w.scenarioRevision||d.currentRevision!==w.currentRevision||d.planSha256!==w.planSha256||!Array.isArray(d.items))return false;
 if(!d.items.every(i=>i&&approvalBlockerCodes.includes(i.code)&&typeof i.message==='string'&&i.message.length>0&&validBlockerTarget(i.target)))return false;
 const messages=new Set(d.items.map(i=>i.message));
 return w.blockers.every(b=>messages.has(b))&&d.items.every(i=>w.blockers.includes(i.message));
}
/** Equal revision numbers do not identify the same editable scenario. */
export const reviewChangesNeedReload=(planScenarioId:string,workspaceScenarioId:string,serverRevision:number,workspaceRevision:number)=>planScenarioId!==workspaceScenarioId||serverRevision!==workspaceRevision;
export function boundBlockerEvidence(w:Workflow,plan:Plan):ApprovalBlockerEvidence|null{
 const d=w.blockerDetails;
 return validBlockerEvidence(w,plan.id)&&d&&d.scenarioId===plan.scenarioId&&d.planRevision===plan.scenarioRevision?d:null;
}
const deliveries=(plan:Plan)=>[...plan.unassigned,...plan.vehicles.flatMap(v=>v.trips.flatMap(t=>t.stops))];
/** No fallback from a supplied request ID to a display reference. */
export function unassignedReviewSelection(plan:Plan,order:{orderNo:string;requestId?:number}):Selection{
 const all=deliveries(plan),matches=all.filter(s=>order.requestId!==undefined?s.requestId===order.requestId:s.orderNo===order.orderNo);
 if(matches.length!==1||matches[0]!.orderNo!==order.orderNo||!plan.unassigned.some(s=>s===matches[0]))return null;
 return {kind:'unassigned',orderNo:order.orderNo,...(order.requestId!==undefined?{requestId:order.requestId}:{})};
}
export function blockerSelection(plan:Plan,target:ApprovalBlockerTarget):Selection{
 if(target.kind==='section')return null;
 const vehicles=plan.vehicles.filter(v=>v.id===target.vehicleId);if(vehicles.length!==1)return null;
 if(target.kind==='vehicle')return {kind:'vehicle',vehicleId:target.vehicleId};
 const trips=vehicles[0]!.trips.filter(t=>t.index===target.tripIndex);if(trips.length!==1)return null;
 if(target.kind==='trip')return {kind:'trip',vehicleId:target.vehicleId,tripIndex:target.tripIndex};
 const matches=deliveries(plan).filter(s=>target.requestId!==undefined?s.requestId===target.requestId:s.orderNo===target.orderNo);
 const stop=matches[0];
 if(matches.length!==1||!stop||stop.orderNo!==target.orderNo||!trips[0]!.stops.some(s=>s===stop)||!('seq' in stop)||stop.seq!==target.seq)return null;
 return {kind:'stop',vehicleId:target.vehicleId,tripIndex:target.tripIndex,seq:target.seq,...(target.requestId!==undefined?{requestId:target.requestId}:{}),planId:plan.id};
}
export function violationSelection(plan:Plan,violation:ValidationViolation):Selection{
 const matches=plan.vehicles.flatMap(v=>v.trips.flatMap(t=>t.stops.map(s=>({v,t,s})))).filter(({v,t,s})=>
  (violation.vehicle_id===undefined||v.id===violation.vehicle_id)&&(violation.trip===undefined||t.index===violation.trip)&&
  (violation.request_id!==undefined?s.requestId===violation.request_id:!!violation.orderNo&&s.orderNo===violation.orderNo)&&
  (violation.orderNo===undefined||s.orderNo===violation.orderNo));
 if(matches.length===1){const {v,t,s}=matches[0]!;return blockerSelection(plan,{kind:'stop',vehicleId:v.id,tripIndex:t.index,seq:s.seq,orderNo:s.orderNo,requestId:s.requestId});}
 if(violation.request_id!==undefined)return null;
 // A constraint explicitly tied to a vehicle can still open that vehicle.
 if(violation.vehicle_id!==undefined)return blockerSelection(plan,{kind:'vehicle',vehicleId:violation.vehicle_id});
 return null;
}
