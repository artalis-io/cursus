import {fleetUtilization,type FleetPlan} from './fleet-utilization.js';
import {stopTiming,tripDeparture} from './plan/timing.js';
type BaseVehicle=FleetPlan['vehicles'][number];
type BaseTrip=BaseVehicle['trips'][number];
type BaseStop=BaseTrip['stops'][number];
export interface ScheduleStop extends BaseStop {seq:number;requestId?:number;orderNo:string;customer?:string|null;twStartSec:number;twEndSec:number}
interface ScheduleTrip extends BaseTrip {stops:ScheduleStop[]}
interface ScheduleVehicle extends BaseVehicle {trips:ScheduleTrip[]}
export interface SchedulePlan extends FleetPlan {vehicles:ScheduleVehicle[]}
export type SlackState='late'|'within30'|'over30'|'unknown';
export interface Slack {state:SlackState;seconds:number|null;waitingSec:number|null}
const finite=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n);
const nonnegative=(n:unknown):n is number=>finite(n)&&n>=0;
const near=(a:number,b:number)=>Math.abs(a-b)<=1;
/** Positive recorded closing bound only. Historical zero may mean an omitted
 * bound or a midnight point window; it is NOT inferred to mean unlimited. */
export function deadlineSlack(s:Pick<ScheduleStop,'type'|'arrivalSec'|'serviceStartSec'|'departureSec'|'twStartSec'|'twEndSec'>):Slack {
  const waitingSec=nonnegative(s.arrivalSec)&&nonnegative(s.serviceStartSec)&&s.serviceStartSec>=s.arrivalSec?s.serviceStartSec-s.arrivalSec:null;
  if(s.type!=='delivery'||![s.arrivalSec,s.serviceStartSec,s.departureSec,s.twStartSec,s.twEndSec].every(nonnegative)||
    s.twEndSec<=0||s.twEndSec<s.twStartSec||s.serviceStartSec<s.arrivalSec||s.serviceStartSec<s.twStartSec||s.departureSec<s.serviceStartSec)
    return {state:'unknown',seconds:null,waitingSec};
  const seconds=s.twEndSec-s.serviceStartSec;
  return {state:seconds<0?'late':seconds<=1800?'within30':'over30',seconds,waitingSec};
}
export interface ScheduleTarget {vehicleId:number;tripIndex:number;seq:number;requestId?:number;orderNo:string}
export interface ScheduleRow extends ScheduleTarget,Slack {vehicleRef:string;customer:string|null;arrivalSec:number;serviceStartSec:number;deadlineSec:number}
export function scheduleReview(plan:SchedulePlan){
  const rows:ScheduleRow[]=plan.vehicles.flatMap(v=>v.trips.flatMap(t=>t.stops.map(s=>({vehicleId:v.id,vehicleRef:v.ref,tripIndex:t.index,seq:s.seq,
    ...(s.requestId===undefined?{}:{requestId:s.requestId}),orderNo:s.orderNo,customer:s.customer??null,arrivalSec:s.arrivalSec,serviceStartSec:s.serviceStartSec,deadlineSec:s.twEndSec,...deadlineSlack(s)}))));
  rows.sort((a,b)=>(a.seconds??Infinity)-(b.seconds??Infinity)||a.vehicleId-b.vehicleId||a.tripIndex-b.tripIndex||a.seq-b.seq);
  return {rows,late:rows.filter(r=>r.state==='late').length,within30:rows.filter(r=>r.state==='within30').length,unknown:rows.filter(r=>r.state==='unknown').length,
    waiting:rows.filter(r=>r.waitingSec!==null&&r.waitingSec>0).length};
}
export interface DelayStop extends ScheduleTarget {serviceStartSec:number;baselineServiceStartSec:number;slackSec:number;baselineSlackSec:number;newlyLate:boolean}
export interface TimingLimit {baseline:number;delayed:number;limit:number}
export interface DelayVehicle {
  vehicleId:number;ref:string;reason:'schedule'|'window'|'reload'|'fleet'|null;
  stops:DelayStop[];finishSec:number|null;shift:TimingLimit|null;duration:TimingLimit|null;
}
export interface DelayReview {seconds:900|1800;vehicles:DelayVehicle[];newlyLate:number;late:number;unknownVehicles:number;shiftBreaches:number;durationBreaches:number}
interface Replay {stops:DelayStop[];finish:number;start:number}
/** Fixed-route static-time replay, sharing the manual evaluator's timing kernel.
 * No assignment, route order, approved exception or native solver is changed.
 * This is timing evidence only, never a full feasibility/approval certificate. */
export function departureDelay(plan:SchedulePlan,seconds:900|1800):DelayReview {
  if(seconds!==900&&seconds!==1800)throw Error('Only 15 or 30 minute departure delays are supported');
  const facts=fleetUtilization(plan);
  const vehicles=plan.vehicles.map((v,index):DelayVehicle=>{
    const evidence=facts.vehicles[index]!,limits=evidence.limits;
    const out:DelayVehicle={vehicleId:v.id,ref:v.ref,reason:null,stops:[],finishSec:null,shift:null,duration:null};
    if(!facts.kpisMatch||!evidence.time||new Set(v.trips.map(t=>t.index)).size!==v.trips.length){out.reason='schedule';return out;}
    if(facts.inventory==='invalid'||evidence.issues.includes('availability')){out.reason='fleet';return out;}
    if(v.trips.some(t=>t.stops.some(s=>deadlineSlack(s).state==='unknown'))){out.reason='window';return out;}
    if(v.trips.length>1&&limits?.reloadSec==null){out.reason='reload';return out;}
    const replay=(delay:number):Replay|null=>{
      let previous=0,first=0;const stops:DelayStop[]=[];
      for(const [i,t] of v.trips.entries()){
        const start=i?tripDeparture(t.startSec,previous,limits!.reloadSec!):tripDeparture(t.startSec+delay,limits?.shiftStartSec??t.startSec,0);if(!i)first=start;
        let cursor=start;
        for(const s of t.stops){
          const arrival=cursor+s.travelToSec,clock=stopTiming(arrival,s.twStartSec,s.departureSec-s.serviceStartSec);
          if(delay===0&&(!near(arrival,s.arrivalSec)||!near(clock.serviceStartSec,s.serviceStartSec)||!near(clock.departureSec,s.departureSec)))return null;
          if(![arrival,clock.serviceStartSec,clock.departureSec].every(nonnegative))return null;
          const baselineSlackSec=s.twEndSec-s.serviceStartSec,slackSec=s.twEndSec-clock.serviceStartSec;
          stops.push({vehicleId:v.id,tripIndex:t.index,seq:s.seq,...(s.requestId===undefined?{}:{requestId:s.requestId}),orderNo:s.orderNo,
            serviceStartSec:clock.serviceStartSec,baselineServiceStartSec:s.serviceStartSec,slackSec,baselineSlackSec,newlyLate:slackSec<0&&baselineSlackSec>=0});
          cursor=clock.departureSec;
        }
        // Saved depot-return leg. Never relabel the inter-trip gap as driving.
        previous=cursor+t.endSec-t.stops.at(-1)!.departureSec;
        if(!nonnegative(previous)||delay===0&&!near(start,t.startSec)||delay===0&&!near(previous,t.endSec))return null;
      }
      return {stops,finish:previous,start:first};
    };
    const baseline=replay(0),delayed=baseline?replay(seconds):null;
    if(!baseline||!delayed){out.reason='schedule';return out;}
    out.stops=delayed.stops;out.finishSec=delayed.finish;
    if(limits?.shiftEndSec!=null)out.shift={baseline:baseline.finish,delayed:delayed.finish,limit:limits.shiftEndSec};
    if(limits?.maxDurationSec!=null)out.duration={baseline:baseline.finish-baseline.start,delayed:delayed.finish-delayed.start,limit:limits.maxDurationSec};
    return out;
  });
  return {seconds,vehicles,newlyLate:vehicles.reduce((n,v)=>n+v.stops.filter(s=>s.newlyLate).length,0),late:vehicles.reduce((n,v)=>n+v.stops.filter(s=>s.slackSec<0).length,0),
    unknownVehicles:vehicles.filter(v=>v.reason!==null).length,shiftBreaches:vehicles.filter(v=>v.shift&&v.shift.delayed>v.shift.limit).length,
    durationBreaches:vehicles.filter(v=>v.duration&&v.duration.delayed>v.duration.limit).length};
}
