// Browser-safe pure projection of an immutable saved plan. No current settings,
// matrix loading, native calls, mutations, or guesses about consolidation.
import type {FleetFact,FleetSnapshot} from './fleet-contract.js';
interface Stop {type:string;weightKg:number;pallets:number;arrivalSec:number;serviceStartSec:number;departureSec:number;waitSec:number;travelToSec:number}
interface Trip {index:number;startSec:number;endSec:number;loadKg:number;loadPallets:number;stops:Stop[]}
interface Vehicle {id:number;ref:string;capacityKg:number;capacityPallets:number;peakKg:number;peakPallets:number;distanceKm:number;trips:Trip[]}
export interface FleetPlan {
  id:string;scenarioId:string;scenarioRevision:number;
  provenance:{inputSha256:string;fleet?:FleetSnapshot;validation:{violations:unknown[]}};
  stats:{vehiclesUsed:number;trips:number};vehicles:Vehicle[];
}
export interface LoadUse {peak:number;capacity:number|null;percent:number|null;remaining:number|null}
export interface TimeUse {elapsed:number;driving:number;service:number;waiting:number}
export interface FleetTripUse {index:number;kg:LoadUse|null;pallets:LoadUse|null;time:TimeUse|null}
export interface FleetVehicleUse {
  id:number;ref:string;used:boolean;availability:FleetFact['availability']|'unknown';
  kg:LoadUse|null;pallets:LoadUse|null;trips:FleetTripUse[];
  time:(TimeUse&{betweenTrips:number})|null;limits:FleetFact|null;
  remainingShiftSec:number|null;remainingDurationSec:number|null;remainingDistanceKm:number|null;remainingTrips:number|null;
  issues:('load'|'schedule'|'availability')[];violations:string[];
}
export interface FleetUse {inventory:'complete'|'eligible_only'|'missing'|'invalid';kpisMatch:boolean;vehicles:FleetVehicleUse[];unusedAvailable:number|null;excluded:number|null;unavailable:number|null}
const finite=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n);
const nonnegative=(n:unknown):n is number=>finite(n)&&n>=0;
const positive=(n:unknown):n is number=>finite(n)&&n>0;
const close=(a:number,b:number,tolerance=1e-6)=>Math.abs(a-b)<=tolerance;
const nullable=(n:unknown)=>n===null||nonnegative(n);
function validSnapshot(s:FleetSnapshot,p:FleetPlan):boolean {
  return s.version===1&&s.planId===p.id&&s.scenarioId===p.scenarioId&&s.scenarioRevision===p.scenarioRevision&&s.inputSha256===p.provenance.inputSha256&&
    /^[a-f0-9]{64}$/.test(s.inputSha256)&&['complete','eligible_only'].includes(s.scope)&&Array.isArray(s.vehicles)&&
    new Set(s.vehicles.map(v=>v?.id)).size===s.vehicles.length&&s.vehicles.every(v=>v&&Number.isSafeInteger(v.id)&&v.id>=0&&typeof v.ref==='string'&&v.ref.length>0&&
      ['available','excluded','unavailable'].includes(v.availability)&&[v.capacityKg,v.capacityPallets,v.shiftStartSec,v.shiftEndSec,v.maxDurationSec,v.maxDistanceKm,v.maxTrips,v.reloadSec].every(nullable)&&
      (v.capacityKg===null||positive(v.capacityKg))&&(v.capacityPallets===null||positive(v.capacityPallets))&&
      (v.shiftStartSec===null||v.shiftEndSec===null||v.shiftStartSec<=v.shiftEndSec)&&
      [v.shiftEndSec,v.maxDurationSec,v.maxDistanceKm].every(n=>n===null||positive(n))&&
      (v.maxTrips===null||Number.isSafeInteger(v.maxTrips)&&v.maxTrips>0))&&
    new Set(p.vehicles.map(v=>v.id)).size===p.vehicles.length&&
    p.vehicles.every(v=>s.vehicles.some(f=>f.id===v.id&&f.ref===v.ref&&f.capacityKg===(positive(v.capacityKg)?v.capacityKg:null)&&f.capacityPallets===(positive(v.capacityPallets)?v.capacityPallets:null)));
}
function use(peak:number,capacity:number|null):LoadUse {
  const percent=capacity===null?null:peak/capacity*100;
  return {peak,capacity,percent:percent!==null&&finite(percent)?percent:null,remaining:capacity===null?null:capacity-peak};
}
function load(t:Trip,dimension:'kg'|'pallets',capacity:number|null):LoadUse|null {
  const field=dimension==='kg'?'weightKg':'pallets',recorded=dimension==='kg'?t.loadKg:t.loadPallets;
  // Cursus currently maps delivery demands. Summing mixed pickup/delivery tasks
  // is NOT a peak-load simulation; withhold it rather than invent cargo state.
  if(!t.stops.length||!t.stops.every(s=>s.type==='delivery'&&nonnegative(s[field])))return null;
  const peak=t.stops.reduce((sum,s)=>sum+s[field],0);
  if(!nonnegative(peak)||!nonnegative(recorded)||!close(peak,recorded))return null;
  return use(peak,capacity);
}
function timing(t:Trip):TimeUse|null {
  if(!t.stops.length||![t.startSec,t.endSec].every(nonnegative)||t.endSec<t.startSec)return null;
  let previous=t.startSec,driving=0,service=0,waiting=0;
  for(const s of t.stops){
    if(![s.arrivalSec,s.serviceStartSec,s.departureSec,s.waitSec,s.travelToSec].every(nonnegative)||s.arrivalSec<previous||s.serviceStartSec<s.arrivalSec||s.departureSec<s.serviceStartSec||
      !close(s.arrivalSec-previous,s.travelToSec,1)||!close(s.serviceStartSec-s.arrivalSec,s.waitSec,1))return null;
    driving+=s.travelToSec;service+=s.departureSec-s.serviceStartSec;waiting+=s.serviceStartSec-s.arrivalSec;previous=s.departureSec;
  }
  if(previous>t.endSec)return null;
  driving+=t.endSec-previous; // includes the depot-return leg, not only stop legs
  const elapsed=t.endSec-t.startSec;
  return close(driving+service+waiting,elapsed,1)?{elapsed,driving,service,waiting}:null;
}
function peak(trips:FleetTripUse[],field:'kg'|'pallets',recorded:number):LoadUse|null {
  if(!trips.length||trips.some(t=>!t[field])||!nonnegative(recorded))return null;
  const max=Math.max(...trips.map(t=>t[field]!.peak));if(!close(max,recorded))return null;
  const capacity=trips[0]![field]!.capacity;
  return use(max,capacity);
}
export function fleetUtilization(p:FleetPlan):FleetUse {
  let snapshot:FleetSnapshot|undefined;
  try{if(p.provenance.fleet&&validSnapshot(p.provenance.fleet,p))snapshot=p.provenance.fleet;}catch{/* corrupt historical evidence stays unknown */}
  const facts=new Map(snapshot?.vehicles.map(v=>[v.id,v])??[]),used=new Set(p.vehicles.map(v=>v.id));
  const vehicles:FleetVehicleUse[]=p.vehicles.map(v=>{
    const f=facts.get(v.id)??null,kg=f?f.capacityKg:positive(v.capacityKg)?v.capacityKg:null,pallets=f?f.capacityPallets:positive(v.capacityPallets)?v.capacityPallets:null;
    const trips=v.trips.map(t=>({index:t.index,kg:load(t,'kg',kg),pallets:load(t,'pallets',pallets),time:timing(t)}));
    const chronological=v.trips.length>0&&v.trips.every((t,i)=>i===0||t.startSec>=v.trips[i-1]!.endSec);
    const totals=trips.every(t=>t.time)&&chronological?{
      elapsed:v.trips.at(-1)!.endSec-v.trips[0]!.startSec,
      driving:trips.reduce((s,t)=>s+t.time!.driving,0),service:trips.reduce((s,t)=>s+t.time!.service,0),waiting:trips.reduce((s,t)=>s+t.time!.waiting,0),
      betweenTrips:v.trips.reduce((s,t,i)=>s+(i?t.startSec-v.trips[i-1]!.endSec:0),0)}:null;
    const issues:FleetVehicleUse['issues']=[],peakKg=peak(trips,'kg',v.peakKg),peakPallets=peak(trips,'pallets',v.peakPallets);
    if(!peakKg||!peakPallets)issues.push('load');if(!totals)issues.push('schedule');if(f&&f.availability!=='available')issues.push('availability');
    const violations=p.provenance.validation.violations.filter((x):x is {vehicle_id:number;type:string}=>!!x&&typeof x==='object'&&'vehicle_id' in x&&x.vehicle_id===v.id&&'type' in x&&typeof x.type==='string').map(x=>x.type);
    return {id:v.id,ref:v.ref,used:true,availability:f?.availability??'unknown',kg:peakKg,pallets:peakPallets,trips,time:totals,limits:f,
      remainingShiftSec:totals&&f?.shiftEndSec!=null?f.shiftEndSec-v.trips.at(-1)!.endSec:null,
      remainingDurationSec:totals&&f?.maxDurationSec!=null?f.maxDurationSec-totals.elapsed:null,
      remainingDistanceKm:f?.maxDistanceKm!=null&&nonnegative(v.distanceKm)?f.maxDistanceKm-v.distanceKm:null,
      remainingTrips:f?.maxTrips!=null?f.maxTrips-v.trips.length:null,issues,violations:[...new Set(violations)]};
  });
  for(const f of snapshot?.vehicles??[])if(!used.has(f.id))vehicles.push({id:f.id,ref:f.ref,used:false,availability:f.availability,kg:null,pallets:null,trips:[],time:null,limits:f,
    remainingShiftSec:null,remainingDurationSec:null,remainingDistanceKm:null,remainingTrips:null,issues:[],violations:[]});
  const complete=snapshot?.scope==='complete';
  return {inventory:snapshot?.scope??(p.provenance.fleet?'invalid':'missing'),kpisMatch:new Set(p.vehicles.map(v=>v.id)).size===p.vehicles.length&&p.stats.vehiclesUsed===p.vehicles.length&&p.stats.trips===p.vehicles.reduce((s,v)=>s+v.trips.length,0),vehicles,
    unusedAvailable:complete?vehicles.filter(v=>!v.used&&v.availability==='available').length:null,excluded:complete?vehicles.filter(v=>!v.used&&v.availability==='excluded').length:null,
    unavailable:complete?vehicles.filter(v=>!v.used&&v.availability==='unavailable').length:null};
}
