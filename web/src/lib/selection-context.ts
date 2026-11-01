import type {Plan,Selection,Stop,Vehicle,Trip} from '../types';
import {selectedStop} from './stop-selection';
import {selectedUnassigned} from './unassigned-selection';

export type SelectionContext =
 | {kind:'vehicle';vehicle:Vehicle}
 | {kind:'trip';vehicle:Vehicle;trip:Trip}
 | {kind:'stop';vehicle:Vehicle;trip:Trip;order:Stop}
 | {kind:'unassigned';order:Plan['unassigned'][number]};

/** Presentation context only. Never resolve a delivery by its display label when
 * an immutable request identity (or a different plan identity) was supplied. */
export function selectionContext(plan:Plan,selection:Selection,fleet:Vehicle[]=plan.vehicles):SelectionContext|null{
 if(!selection)return null;
 if(selection.kind==='unassigned'){
  const order=selectedUnassigned(plan.unassigned,selection);
  return order?{kind:'unassigned',order}:null;
 }
 const vehicle=fleet.find(v=>v.id===selection.vehicleId);if(!vehicle)return null;
 if(selection.kind==='vehicle')return {kind:'vehicle',vehicle};
 const trip=vehicle.trips.find(tr=>tr.index===selection.tripIndex);if(!trip)return null;
 if(selection.kind==='trip')return {kind:'trip',vehicle,trip};
 const order=selectedStop(trip.stops,selection,plan.id);
 return order?{kind:'stop',vehicle,trip,order}:null;
}

/** History de-duplicates semantic selection, independent of object key order.
 * Once a request identity is present, its old display position is irrelevant. */
export function sameSelection(a:Selection,b:Selection):boolean{
 if(a===b)return true;if(!a||!b||a.kind!==b.kind)return false;
 if(a.kind==='vehicle'&&b.kind==='vehicle')return a.vehicleId===b.vehicleId;
 if(a.kind==='trip'&&b.kind==='trip')return a.vehicleId===b.vehicleId&&a.tripIndex===b.tripIndex;
 if(a.kind==='unassigned'&&b.kind==='unassigned')return a.orderNo===b.orderNo&&a.requestId===b.requestId;
 if(a.kind==='stop'&&b.kind==='stop')return a.vehicleId===b.vehicleId&&a.tripIndex===b.tripIndex&&a.planId===b.planId&&
  (a.requestId!==undefined||b.requestId!==undefined?a.requestId===b.requestId:a.seq===b.seq);
 return false;
}
