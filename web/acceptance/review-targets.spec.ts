import {test,expect} from '@playwright/test';
import type {Plan} from '../src/types';
import type {Workflow} from '../../server/src/workflow-contract';
import {blockerSelection,unassignedReviewSelection,violationSelection,reviewChangesNeedReload} from '../src/lib/review-targets';
import {isWorkflowEvidence} from '../src/lib/workspace-status';
const plan={id:'p',scenarioId:'s',scenarioRevision:1,vehicles:[{id:10,trips:[{index:0,stops:[{orderNo:'SAME',requestId:1,seq:1},{orderNo:'SAME',requestId:2,seq:2}]}]}],unassigned:[{orderNo:'SAME',requestId:3},{orderNo:'SAME',requestId:4}]} as unknown as Plan;
const target={kind:'stop' as const,vehicleId:10,tripIndex:0,seq:2,orderNo:'SAME',requestId:2};
test('review navigation resolves stable delivery identities and never guesses duplicate or conflicting references',()=>{
 expect(reviewChangesNeedReload('source','edited-copy',2,2),'different scenarios with equal revisions must not open each other’s changes').toBe(true);
 expect(reviewChangesNeedReload('source','source',2,1)).toBe(true);expect(reviewChangesNeedReload('source','source',2,2)).toBe(false);
 expect(blockerSelection(plan,target)).toMatchObject({kind:'stop',requestId:2,seq:2,planId:'p'});
 for(const patch of [{requestId:99},{seq:1},{orderNo:'OTHER'},{tripIndex:1},{vehicleId:99},{requestId:undefined}])expect(blockerSelection(plan,{...target,...patch})).toBeNull();
 expect(unassignedReviewSelection(plan,{orderNo:'SAME',requestId:4})).toEqual({kind:'unassigned',orderNo:'SAME',requestId:4});
 expect(unassignedReviewSelection(plan,{orderNo:'SAME'})).toBeNull();expect(unassignedReviewSelection(plan,{orderNo:'SAME',requestId:1})).toBeNull();
 expect(violationSelection(plan,{type:'GVW',request_id:2,orderNo:'SAME'})).toMatchObject({requestId:2});
 expect(violationSelection(plan,{type:'GVW',orderNo:'SAME'})).toBeNull();
 expect(violationSelection(plan,{type:'GVW',request_id:999,vehicle_id:10})).toBeNull();
 expect(violationSelection(plan,{type:'GVW',request_id:2,orderNo:'OTHER'})).toBeNull();
});
test('structured review evidence is bound to the plan, revisions and hash and cannot omit blockers',()=>{
 const workflow:Workflow={state:'draft',version:0,scenarioRevision:1,currentRevision:1,planSha256:'a'.repeat(64),actor:null,at:null,blockers:['GVW'],blockerDetails:{version:1,planId:'p',scenarioId:'s',planRevision:1,currentRevision:1,planSha256:'a'.repeat(64),items:[{code:'gvw',message:'GVW',target}]}};
 expect(isWorkflowEvidence(workflow,'p',plan)).toBe(true);
 for(const patch of [{planId:'foreign'},{scenarioId:'foreign'},{planRevision:2},{currentRevision:2},{planSha256:'b'.repeat(64)},{version:2},{items:[]},{items:[{code:'gvw',message:'GVW',target:{...target,vehicleId:-1}}]},{items:[{code:'gvw',message:'GVW',target:{kind:'section',section:{toString:null,valueOf:null}}}]}])expect(isWorkflowEvidence({...workflow,blockerDetails:{...workflow.blockerDetails,...patch}},'p',plan)).toBe(false);
 expect(isWorkflowEvidence({...workflow,blockerDetails:undefined},'p',plan),'older server remains compatible and blocked').toBe(true);
 expect(isWorkflowEvidence({...workflow,blockers:[]},'p',plan)).toBe(false);
});
