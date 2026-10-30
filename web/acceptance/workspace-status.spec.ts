import {test,expect} from '@playwright/test';
import {workspaceFreshness,approvalSummary,isWorkflowEvidence} from '../src/lib/workspace-status';
import type {Workflow} from '../../server/src/workflow-contract';
const approved:Workflow={state:'approved',version:2,currentRevision:3,scenarioRevision:3,planSha256:'a'.repeat(64),actor:'user',at:'2026-10-30T12:00:00Z',blockers:[]};
const clean={loading:false,saving:false,running:false,candidate:false,revalidate:false,archived:false,conflict:false,fresh:true};

test('compact status: only the exact current approval evidence receives confirmed styling',()=>{
 expect(approvalSummary(approved,'ready',3,false)).toEqual({state:'approved',confirmed:true,savedSnapshot:false});
 for(const phase of ['loading','error','unavailable'] as const){
  const status=approvalSummary(approved,phase,3,false);
  expect(status.confirmed).toBe(false);expect(status.state).not.toBe('approved');
 }
 const uncertain:[Workflow,number,boolean][]=[[approved,3,true],[approved,4,false],[{...approved,currentRevision:4},3,false],[{...approved,blockers:['Changed policy']},3,false]];
 for(const [workflow,revision,pending] of uncertain){
  const status=approvalSummary(workflow,'ready',revision,pending);expect(status.confirmed).toBe(false);expect(status.savedSnapshot).toBe(true);
 }
 expect(approvalSummary(null,'ready',3,false).state).toBe('unknown');
 for(const state of ['draft','reviewed','superseded'] as const)expect(approvalSummary({...approved,state},'ready',3,false)).toEqual({state,confirmed:false,savedSnapshot:false});
});

test('compact status: every pending or uncertain workspace state prevents Current',()=>{
 expect(workspaceFreshness(clean)).toBe('current');
 for(let mask=0;mask<256;mask++){
  const input={...clean};const keys=['loading','saving','running','candidate','revalidate','archived','conflict'] as const;
  keys.forEach((key,i)=>{input[key]=!!(mask&(1<<i));});input.fresh=!(mask&128);
  expect(workspaceFreshness(input)==='current').toBe(keys.every(key=>!input[key])&&input.fresh);
 }
 expect(workspaceFreshness({...clean,saving:true})).toBe('saving');
 expect(workspaceFreshness({...clean,running:true})).toBe('running');
 expect(workspaceFreshness({...clean,candidate:true})).toBe('candidate');
 expect(workspaceFreshness({...clean,conflict:true})).toBe('stale');
 expect(workspaceFreshness({...clean,archived:true})).toBe('archived');
 expect(workspaceFreshness({...clean,revalidate:true})).toBe('revalidate');
});

test('compact status: malformed or missing approval evidence fails closed',()=>{
 expect(isWorkflowEvidence(approved)).toBe(true);
 for(const value of [null,undefined,{},[],{...approved,state:'ready'},{...approved,version:-1},{...approved,version:Infinity},
  {...approved,currentRevision:'3'},{...approved,blockers:null},{...approved,blockers:[1]},{...approved,planSha256:'x'},
  {...approved,at:'not a date'},{...approved,actor:{id:'user'}}])expect(isWorkflowEvidence(value)).toBe(false);
});
