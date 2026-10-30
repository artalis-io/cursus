import test from 'node:test';
import assert from 'node:assert/strict';
import {manualFixture} from '../state/manual-fixture.js';
import {prepareManualInput} from './manual-adapter.js';
import {reconcileInputs} from './input-update.js';
import type {InputUpdateIntent} from '../input-update-contract.js';

function fixture(){
 const f=manualFixture(),oldLayout=prepareManualInput(f.parent,f.scenario,f.context).layout;
 oldLayout.decisions={'91':{kind:'vehicle',vehicleId:7}};
 f.parent.assignments={version:1,parentPlanId:'earlier',layout:oldLayout};
 const target=structuredClone(f.context);target.day.datasetRequestSha256='b'.repeat(64);target.day.def.id='next-day';
 target.day.request.requests=target.day.request.requests.map(r=>({...r,id:r.id+1000}));
 target.day.solution={status:'OK',routes:[],unassigned:[1091,1092],stats:{}};
 const scenario={...structuredClone(f.scenario),id:'next-scenario',day:'next-day',planningPolicy:undefined,manualDecisions:undefined};
 const intent:InputUpdateIntent={operationId:'update',parentPlanId:f.parent.id,datasetId:'new',dayId:'new-day',reason:'Reviewed revision',identityReviewed:true,carryExceptions:false,acknowledgeInvalid:false,
  matches:[{from:91,to:1091},{from:92,to:1092}],releaseRequestIds:[],unlockVehicleIds:[],profiles:[]};
 return {...f,target,next:scenario,intent};
}
test('reviewed IDs survive reindexing; arrangements, decisions and source attribution are retained without rewriting history',()=>{
 const f=fixture(),before=structuredClone([f.parent,f.scenario,f.context]);
 const out=reconcileInputs(f.parent,f.scenario,f.context,f.target,f.next,f.intent);
 assert.equal(out.diff.unchanged,2);assert.equal(out.diff.retainedDecisions,1);assert.deepEqual(out.diff.conflicts,[]);
 assert.deepEqual(out.plan.vehicles[0]!.trips[0]!.stops.map(s=>s.requestId),[1091,1092]);
 assert.deepEqual(out.scenario.manualDecisions!.decisions,{'1091':{kind:'vehicle',vehicleId:7}});
 assert.equal(out.plan.stats.servedOrders,2);assert.equal(out.plan.provenance.validation.valid,true);
 assert.equal(out.plan.manual?.parentScenario,undefined,'no cross-dataset Undo');
 assert.deepEqual([f.parent,f.scenario,f.context],before);
});
test('changed demand is recalculated and retained choices never become a false feasibility certificate',()=>{
 const f=fixture();f.target.day.request.tasks[0]!.demand[0]=2000;
 const row=f.target.day.enrichment.get('ORDER-1')!;row.weightKg=2000;
 const out=reconcileInputs(f.parent,f.scenario,f.context,f.target,f.next,f.intent);
 assert.deepEqual(out.diff.changed[0]!.fields,['weight']);assert.deepEqual(out.diff.affectedVehicles,[7]);
 assert.equal(out.plan.provenance.validation.valid,false);assert.ok(out.plan.provenance.validation.violations.some(v=>(v as {type:string}).type==='CAPACITY'));
 assert.equal(out.plan.vehicles[0]!.trips[0]!.loadKg,2100);
});
test('cancellation with a retained decision requires an explicit release, while additions remain unassigned',()=>{
 const f=fixture();f.intent.matches=[{from:92,to:1092}];
 let out=reconcileInputs(f.parent,f.scenario,f.context,f.target,f.next,f.intent);
 assert.equal(out.diff.cancelled[0]!.id,91);assert.equal(out.diff.added[0]!.id,1091);
 assert.ok(out.diff.conflicts.some(c=>c.code==='cancelled_decision'&&c.requestId===91));
 f.intent.releaseRequestIds=[91];out=reconcileInputs(f.parent,f.scenario,f.context,f.target,f.next,f.intent);
 assert.deepEqual(out.diff.conflicts,[]);assert.equal(out.plan.unassigned[0]!.requestId,1091);assert.equal(out.plan.stats.totalOrders,2);assert.equal(out.plan.stats.servedOrders,1);
});
test('a changed locked route requires an explicit unlock and preserves unrelated decisions',()=>{
 const f=fixture();f.scenario.sequences=[{vehicleId:7,orderNos:['ORDER-1','ORDER-2'],requestIds:[91,92],locked:true}];
 f.target.day.request.tasks[0]!.tw_late=9000;
 let out=reconcileInputs(f.parent,f.scenario,f.context,f.target,f.next,f.intent);assert.ok(out.diff.conflicts.some(c=>c.code==='changed_lock'));
 f.intent.unlockVehicleIds=[7];out=reconcileInputs(f.parent,f.scenario,f.context,f.target,f.next,f.intent);
 assert.deepEqual(out.scenario.sequences,[]);assert.deepEqual(out.diff.conflicts,[]);assert.deepEqual(out.scenario.manualDecisions!.decisions['1091'],{kind:'vehicle',vehicleId:7});
});
test('ambiguous, duplicated or unknown correspondence is rejected rather than inferred from a label',()=>{
 for(const matches of [[{from:91,to:1091},{from:92,to:1091}],[{from:91,to:1091},{from:91,to:1092}],[{from:999,to:1091}]]){
  const f=fixture();f.intent.matches=matches;assert.throws(()=>reconcileInputs(f.parent,f.scenario,f.context,f.target,f.next,f.intent),/correspondence/);
 }
 const f=fixture();f.scenario.pins=[{orderNo:'ORDER-1',vehicleId:7}];f.context.day.request.tasks[1]!.ref='ORDER-1';
 assert.throws(()=>reconcileInputs(f.parent,f.scenario,f.context,f.target,f.next,f.intent),/identity|identities|restriction|Ambiguous/);
});
