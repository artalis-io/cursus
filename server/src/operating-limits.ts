import type {OperatingLimits} from './planning-profile-contract.js';
interface SurgeRequestVehicle {shift_early?:number;shift_late?:number;max_trips?:number;max_distance?:number;max_duration?:number;approved_operating?:OperatingLimits;operating_limits?:OperatingLimits}
export function parseOperatingLimits(value:unknown):OperatingLimits {
 const obj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
 const exact=(v:Record<string,unknown>,fields:string[])=>Object.keys(v).length===fields.length&&fields.every(k=>k in v);
 const number=(n:unknown,max:number,integer=false)=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=max&&(!integer||Number.isSafeInteger(n));
 if(!obj(value)||!exact(value,['shift','maxTrips','maxDistanceKm','maxDurationSec']))throw new Error('Invalid fleet operating limits');
 for(const key of ['shift','maxTrips','maxDistanceKm','maxDurationSec'] as const){
  const v=value[key];if(!obj(v))throw new Error('Invalid fleet operating limit');
  if(v.state==='unknown'||v.state==='unlimited'){if(!exact(v,['state']))throw new Error('Unexpected operating limit value');continue;}
  if(v.state!=='configured')throw new Error('Invalid operating limit state');
  if(key==='shift'){
   if(!exact(v,['state','startSec','endSec'])||!number(v.startSec,172800,true)||!number(v.endSec,172800,true)||Number(v.endSec)<Number(v.startSec))throw new Error('Invalid operating shift');
  }else if(!exact(v,['state','value'])||!number(v.value,key==='maxTrips'?10000:key==='maxDistanceKm'?1000000:172800,key!=='maxDistanceKm')||Number(v.value)<=0)throw new Error('Invalid configured operating limit');
 }
 return structuredClone(value) as unknown as OperatingLimits;
}
export const unknownOperatingLimits=():OperatingLimits=>({shift:{state:'unknown'},maxTrips:{state:'unknown'},maxDistanceKm:{state:'unknown'},maxDurationSec:{state:'unknown'}});
/** Source facts remain intact for unknown fields. Zero native maxima mean unlimited;
 * shifts must be paired: Surge ignores shift_late without shift_early. */
export function applyOperatingLimits(v:SurgeRequestVehicle,limits:OperatingLimits):void {
 const l=parseOperatingLimits(limits);
 if(l.shift.state==='configured'){v.shift_early=l.shift.startSec;v.shift_late=l.shift.endSec;}
 if(l.shift.state==='unlimited'){delete v.shift_early;delete v.shift_late;}
 for(const [key,field,factor] of [['maxTrips','max_trips',1],['maxDistanceKm','max_distance',1000],['maxDurationSec','max_duration',1]] as const){
  const limit=l[key];if(limit.state!=='unknown')v[field]=limit.state==='unlimited'?0:limit.value*factor;
 }
 v.approved_operating=l;v.operating_limits=effectiveOperatingLimits(v,l);
}
export function effectiveOperatingLimits(v:SurgeRequestVehicle,policy:OperatingLimits):OperatingLimits {
 const result=structuredClone(policy);
 if(v.shift_early!==undefined&&v.shift_late!==undefined)result.shift={state:'configured',startSec:v.shift_early,endSec:v.shift_late};
 for(const [key,field,factor] of [['maxTrips','max_trips',1],['maxDistanceKm','max_distance',1000],['maxDurationSec','max_duration',1]] as const){
  const n=v[field];if(n!==undefined)result[key]=n===0?{state:'unlimited'}:{state:'configured',value:n/factor};
 }
 return result;
}
export function assertOperatingBounds(v:SurgeRequestVehicle):void {
 const l=v.approved_operating;if(!l)return;
 if(l.shift.state==='configured'&&(v.shift_early===undefined||v.shift_late===undefined||v.shift_early<l.shift.startSec||v.shift_late>l.shift.endSec||v.shift_early>v.shift_late))throw new Error('Scenario shift exceeds the approved fleet profile.');
 for(const [key,field,factor] of [['maxTrips','max_trips',1],['maxDistanceKm','max_distance',1000],['maxDurationSec','max_duration',1]] as const){
  const limit=l[key],n=v[field];if(limit.state==='configured'&&(n===undefined||n<=0||n>limit.value*factor))throw new Error('Scenario operating limit exceeds the approved fleet profile.');
 }
 v.operating_limits=effectiveOperatingLimits(v,l);
}

/** Independent saved-result boundary: native heuristics cannot publish work
 * outside a configured approved operating envelope. No solver-status guess. */
export function operatingViolations(vehicle:{trips:{startSec:number;endSec:number}[];distanceKm:number},limits:OperatingLimits):string[] {
 const trips=vehicle.trips;if(!trips.length)return [];
 if(Object.values(limits).some(l=>l.state==='configured')&&(!Number.isFinite(vehicle.distanceKm)||vehicle.distanceKm<0||trips.some((t,i)=>!Number.isFinite(t.startSec)||!Number.isFinite(t.endSec)||t.startSec<0||t.endSec<t.startSec||i>0&&t.startSec<trips[i-1]!.endSec)))return ['evidence'];
 const first=trips[0]!.startSec,last=trips[trips.length-1]!.endSec,issues:string[]=[];
 const shift=limits.shift;
 if(shift.state==='configured'&&trips.some(t=>t.startSec<shift.startSec||t.endSec>shift.endSec))issues.push('shift');
 if(limits.maxTrips.state==='configured'&&trips.length>limits.maxTrips.value)issues.push('trips');
 if(limits.maxDistanceKm.state==='configured'&&vehicle.distanceKm>limits.maxDistanceKm.value+0.000001)issues.push('distance');
 if(limits.maxDurationSec.state==='configured'&&last-first>limits.maxDurationSec.value+1)issues.push('duration');
 return issues;
}
