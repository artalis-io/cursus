import test from 'node:test';
import assert from 'node:assert/strict';
import {manualFixture} from './state/manual-fixture.js';
import {prepareManualInput,evaluateManualInput,materializeManualPlan} from './plan/manual-adapter.js';
import {manualTripKey} from './plan/manual-evaluate.js';
import {deadlineSlack,scheduleReview,departureDelay} from './schedule-review.js';
function fixture(){
 const f=manualFixture();for(const v of f.context.day.request.vehicles){v.max_trips=0;v.shift_early=0;v.shift_late=2000;v.max_duration=2000;}
 f.context.day.request.tasks[0]!.tw_late=1000;f.context.day.request.tasks[1]!.tw_late=1800;
 const input=prepareManualInput(f.parent,f.scenario,f.context);input.layout.routes=[{vehicleId:7,tripId:'first',requestIds:[91]},{vehicleId:7,tripId:'second',requestIds:[92]}];
 input.departures=new Map([['7:first',0],['7:second',0]]);
 const evaluation=evaluateManualInput(input,input.layout,f.scenario);
 const plan=materializeManualPlan(f.parent,f.scenario,input,evaluation,f.context,'schedule','2026-11-11T00:00:00Z');
 return {...f,input,plan,evaluation};
}
const first=(p:ReturnType<typeof fixture>['plan'])=>p.vehicles[0]!.trips[0]!.stops[0]!;
test('closing slack uses service start, not arrival, opening or completion; equality is on time',()=>{
 const s={...first(fixture().plan),arrivalSec:100,serviceStartSec:1000,departureSec:2000,twStartSec:1000,twEndSec:1000};
 assert.deepEqual(deadlineSlack(s),{state:'within30',seconds:0,waitingSec:900});
 assert.equal(deadlineSlack({...s,serviceStartSec:1001}).state,'late');assert.equal(deadlineSlack({...s,twEndSec:2800}).state,'within30');assert.equal(deadlineSlack({...s,twEndSec:2801}).state,'over30');
});
test('missing/zero bounds, malformed windows, unsupported stops and impossible times are Unknown, not unlimited',()=>{
 const s=first(fixture().plan);
 for(const change of [{twEndSec:0},{twEndSec:NaN},{twStartSec:2001,twEndSec:2000},{serviceStartSec:0},{departureSec:0},{type:'pickup'},{twEndSec:undefined}])assert.equal(deadlineSlack({...s,...change} as typeof s).state,'unknown');
});
test('rank negative and tight slack before unknown without merging repeated references or changing KPIs',()=>{
 const {plan}=fixture();for(const t of plan.vehicles[0]!.trips)t.stops[0]!.orderNo='REPEATED';
 const a=first(plan),b=plan.vehicles[0]!.trips[1]!.stops[0]!;a.twEndSec=a.serviceStartSec-1;b.twEndSec=b.serviceStartSec+1;
 const before=structuredClone(plan),r=scheduleReview(plan);assert.deepEqual(r.rows.map(s=>s.requestId),[91,92]);assert.equal(r.late,1);assert.equal(r.within30,1);assert.deepEqual(plan,before);
 b.twEndSec=0;assert.equal(scheduleReview(plan).unknown,1);
});
for(const delay of [900,1800] as const)test(`${delay}s replay matches whole-plan matrix evaluator, reload, shifts and unchanged assignment/cost`,()=>{
 const f=fixture(),before=structuredClone(f.plan),v=f.plan.vehicles[0]!;
 assert.deepEqual(v.trips.map(t=>[t.startSec,t.endSec]),[[0,260],[380,840]]);
 const departures=new Map(f.input.departures);v.trips.forEach((t,i)=>departures.set(manualTripKey(v.id,t.manualTripId!),t.startSec+(i?0:delay)));
 const oracle=evaluateManualInput({...f.input,departures},f.input.layout,f.scenario),r=departureDelay(f.plan,delay),actual=r.vehicles[0]!;
 assert.equal(actual.reason,null);assert.equal(actual.finishSec,oracle.vehicles[0]!.trips.at(-1)!.endSec);
 assert.deepEqual(actual.stops.map(s=>s.serviceStartSec),oracle.vehicles[0]!.trips.flatMap(t=>t.stops.map(s=>s.serviceStartSec)));
 assert.equal(r.late,oracle.validation.violations.filter(v=>v.type==='HARD_TW').length);assert.equal(r.shiftBreaches,new Set(oracle.validation.violations.filter(v=>v.type==='SHIFT').map(v=>v.vehicleId)).size);
 assert.equal(r.durationBreaches,oracle.validation.violations.filter(v=>v.type==='MAX_DURATION').length);assert.deepEqual(f.plan,before);assert.deepEqual(oracle.stats,f.evaluation.stats);assert.deepEqual(oracle.cost,f.evaluation.cost);
});
test('early waiting absorbs first-departure delay instead of shifting every ETA by fifteen minutes',()=>{
 const f=fixture();f.input.request.tasks[0]!.tw_early=1100;f.input.request.tasks[0]!.tw_late=1300;f.input.request.tasks[1]!.tw_late=3000;
 const base=evaluateManualInput(f.input,f.input.layout,f.scenario),p=materializeManualPlan(f.parent,f.scenario,f.input,base,f.context,'waiting',f.plan.createdAt);
 const r=departureDelay(p,900);assert.equal(r.unknownVehicles,0);assert.equal(r.vehicles[0]!.stops[0]!.serviceStartSec,1100);assert.equal(r.vehicles[0]!.finishSec,p.vehicles[0]!.trips.at(-1)!.endSec);assert.equal(r.newlyLate,0);
});
test('inter-trip spare time absorbs delay only after required reload is retained',()=>{
 const f=fixture();f.input.departures.set('7:second',2000);f.input.request.tasks[1]!.tw_late=3000;
 const p=materializeManualPlan(f.parent,f.scenario,f.input,evaluateManualInput(f.input,f.input.layout,f.scenario),f.context,'gap',f.plan.createdAt),r=departureDelay(p,900);
 assert.equal(r.vehicles[0]!.stops[1]!.serviceStartSec,p.vehicles[0]!.trips[1]!.stops[0]!.serviceStartSec);assert.equal(r.vehicles[0]!.finishSec,p.vehicles[0]!.trips[1]!.endSec);
});
test('later trips propagate delay and distinguish existing versus newly missed deadlines',()=>{
 const f=fixture(),r=departureDelay(f.plan,1800);assert.equal(r.newlyLate,2);assert.equal(r.vehicles[0]!.stops[1]!.serviceStartSec,2380);assert.equal(r.shiftBreaches,1);
 first(f.plan).twEndSec=90;const old=departureDelay(f.plan,1800);assert.equal(old.late,2);assert.equal(old.newlyLate,1);
});
test('missing multi-trip reload stays Unknown; a single trip can check windows without inventing shift bounds',()=>{
 const {plan}=fixture();delete plan.provenance.fleet;assert.equal(departureDelay(plan,900).vehicles[0]!.reason,'reload');
 plan.vehicles[0]!.trips.pop();plan.stats.trips=1;plan.vehicles[0]!.peakKg=100;plan.vehicles[0]!.peakPallets=1;
 const r=departureDelay(plan,900).vehicles[0]!;assert.equal(r.reason,null);assert.equal(r.shift,null);assert.equal(r.duration,null);
});
test('unexplained waiting cannot be replayed optimistically',()=>{
 const {plan}=fixture(),s=first(plan);s.serviceStartSec+=10;s.departureSec+=10;s.waitSec+=10;plan.vehicles[0]!.trips[0]!.endSec+=10;
 assert.equal(departureDelay(plan,900).vehicles[0]!.reason,'schedule');
});
test('borrowed snapshot identity and unknown windows withhold replay, never borrow current settings',()=>{
 const {plan}=fixture();plan.provenance.fleet!.planId='foreign';assert.notEqual(departureDelay(plan,900).vehicles[0]!.reason,null);
 const f=fixture();first(f.plan).twEndSec=0;assert.equal(departureDelay(f.plan,900).vehicles[0]!.reason,'window');
});
test('duration limit measures departure to final return, not added delay itself',()=>{
 const f=fixture();f.input.request.vehicles[0]!.max_duration=800;
 const p=materializeManualPlan(f.parent,f.scenario,f.input,evaluateManualInput(f.input,f.input.layout,f.scenario),f.context,'duration',f.plan.createdAt),r=departureDelay(p,900);
 assert.deepEqual(r.vehicles[0]!.duration,{baseline:840,delayed:840,limit:800});assert.equal(r.durationBreaches,1);
});
test('no arbitrary budgets or delay modes; empty plans create no phantom vehicles',()=>{
 const {plan}=fixture();for(const n of [0,-1,60,901,Infinity])assert.throws(()=>departureDelay(plan,n as 900));
 plan.vehicles=[];plan.stats.vehiclesUsed=0;plan.stats.trips=0;delete plan.provenance.fleet;assert.equal(scheduleReview(plan).rows.length,0);
 assert.deepEqual(departureDelay(plan,900),{seconds:900,vehicles:[],newlyLate:0,late:0,unknownVehicles:0,shiftBreaches:0,durationBreaches:0});
});
test('seeded timing regression: replay matches the matrix evaluator across windows, reloads, anchors and service durations',()=>{
 let state=71;const draw=(max:number)=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state%max;};
 for(let iteration=0;iteration<60;iteration++){
  const f=fixture(),reload=draw(601);f.input.fleet.get(7)!.reloadSec=reload;f.input.request.vehicles[0]!.trip_reload_seconds=reload;
  f.input.request.vehicles[0]!.shift_early=draw(700);f.input.request.vehicles[0]!.shift_late=2000+draw(4000);f.input.request.vehicles[0]!.max_duration=100+draw(4000);
  for(const task of f.input.request.tasks){task.tw_early=draw(2000);task.tw_late=task.tw_early+1+draw(2000);task.service_seconds=draw(181);}
  f.input.departures.set('7:first',draw(1000));f.input.departures.set('7:second',draw(3000));
  const base=evaluateManualInput(f.input,f.input.layout,f.scenario),p=materializeManualPlan(f.parent,f.scenario,f.input,base,f.context,'generated',f.plan.createdAt),before=structuredClone(p);
  const cases=[900,1800].map(delay=>{
   const departures=new Map(f.input.departures);p.vehicles[0]!.trips.forEach((t,i)=>departures.set(manualTripKey(7,t.manualTripId!),t.startSec+(i?0:delay)));
   const expected=evaluateManualInput({...f.input,departures},f.input.layout,f.scenario),actual=departureDelay(p,delay as 900|1800);
   assert.equal(actual.unknownVehicles,0);assert.equal(actual.vehicles[0]!.finishSec,expected.vehicles[0]!.trips.at(-1)!.endSec);
   assert.deepEqual(actual.vehicles[0]!.stops.map(s=>s.serviceStartSec),expected.vehicles[0]!.trips.flatMap(t=>t.stops.map(s=>s.serviceStartSec)));
   assert.equal(actual.late,expected.validation.violations.filter(v=>v.type==='HARD_TW').length);
   assert.equal(actual.shiftBreaches,new Set(expected.validation.violations.filter(v=>v.type==='SHIFT').map(v=>v.vehicleId)).size);
   assert.equal(actual.durationBreaches,expected.validation.violations.filter(v=>v.type==='MAX_DURATION').length);
   return actual;
  });
  assert.ok(cases[1]!.vehicles[0]!.finishSec!>=cases[0]!.vehicles[0]!.finishSec!);assert.ok(cases[1]!.late>=cases[0]!.late);assert.deepEqual(p,before);
 }
});

test('a saved departure substantially before its recorded shift start cannot establish zero-delay replay parity',()=>{
 const {plan}=fixture();plan.provenance.fleet!.vehicles[0]!.shiftStartSec=1000;assert.equal(departureDelay(plan,900).vehicles[0]!.reason,'schedule');
});
