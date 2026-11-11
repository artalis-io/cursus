import type {OperatingLimits} from '../../../server/src/planning-profile-contract';
const unknownLimits=():OperatingLimits=>({shift:{state:'unknown'},maxTrips:{state:'unknown'},maxDistanceKm:{state:'unknown'},maxDurationSec:{state:'unknown'}});
export function operatingSummary(limits:OperatingLimits|undefined,hu:boolean):string {
 const l=limits??unknownLimits(),state=(v:OperatingLimits['maxTrips'])=>v.state==='configured'?String(v.value):v.state==='unlimited'?(hu?'korlátlan':'unlimited'):(hu?'ismeretlen / forrás':'unknown / source');
 const clock=(n:number)=>`${String(Math.floor(n/3600)).padStart(2,'0')}:${String(Math.floor(n%3600/60)).padStart(2,'0')}${n%60?`:${String(n%60).padStart(2,'0')}`:''}`;
 return `${hu?'Műszak':'Shift'}: ${l.shift.state==='configured'?`${clock(l.shift.startSec)}–${clock(l.shift.endSec)}`:state(l.shift)} · ${hu?'Max. fordulók':'Max trips'}: ${state(l.maxTrips)} · km: ${state(l.maxDistanceKm)} · ${hu?'Időtartam (másodperc)':'Duration (seconds)'}: ${state(l.maxDurationSec)}`;
}
