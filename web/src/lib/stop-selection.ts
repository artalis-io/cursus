import type {Stop,Selection} from '../types';
/** Positional sequence numbers are display attributes. Prefer the immutable
 * delivery identity and reject events originating from another plan snapshot. */
export function selectedStop(stops:Stop[],selection:Extract<Selection,{kind:'stop'}>,planId:string):Stop|undefined{
 if(selection.planId!==undefined&&selection.planId!==planId)return undefined;
 return selection.requestId!==undefined?stops.find(stop=>stop.requestId===selection.requestId):stops.find(stop=>stop.seq===selection.seq);
}
