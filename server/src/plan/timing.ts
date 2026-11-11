/** Shared timing kernel. Callers validate their own evidence/inputs. No routing,
 * clock rounding, traffic assumptions or constraint-policy changes live here. */
export const tripDeparture=(anchor:number,previousEnd:number,reloadSec:number)=>Math.max(anchor,previousEnd+reloadSec);
export function stopTiming(arrivalSec:number,openingSec:number,serviceSec:number){
  const serviceStartSec=Math.max(arrivalSec,openingSec);
  return {serviceStartSec,departureSec:serviceStartSec+serviceSec,waitSec:serviceStartSec-arrivalSec};
}
