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
