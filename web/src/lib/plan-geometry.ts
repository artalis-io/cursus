import type {Plan} from '../types';

/** Derived roads cannot replace authoritative plan fields or an in-progress
 * manual intent. Only add valid geometry to the same immutable stop sequence. */
export function addPlanGeometry(current:Plan,enriched:Plan):Plan{
 if(current.id!==enriched.id||current.scenarioId!==enriched.scenarioId||current.scenarioRevision!==enriched.scenarioRevision||
  current.provenance.inputSha256!==enriched.provenance.inputSha256)return current;
 let changed=false;
 const vehicles=current.vehicles.map(vehicle=>{
  const source=enriched.vehicles.find(v=>v.id===vehicle.id);if(!source)return vehicle;
  const trips=vehicle.trips.map(trip=>{
   if((trip.geometry?.coordinates.length??0)>=2)return trip;
   const other=source.trips.find(t=>t.index===trip.index),geometry=other?.geometry;
   if(!other||geometry?.type!=='LineString'||!Array.isArray(geometry.coordinates)||geometry.coordinates.length<2||
    geometry.coordinates.some(p=>!Array.isArray(p)||p.length!==2||!p.every(Number.isFinite))||other.stops.length!==trip.stops.length||
    trip.stops.some((s,i)=>{const t=other.stops[i];return s.requestId!==t.requestId||s.orderNo!==t.orderNo||s.lon!==t.lon||s.lat!==t.lat;}))return trip;
   changed=true;return {...trip,geometry};
  });
  return trips.some((trip,i)=>trip!==vehicle.trips[i])?{...vehicle,trips}:vehicle;
 });
 return changed?{...current,vehicles}:current;
}
