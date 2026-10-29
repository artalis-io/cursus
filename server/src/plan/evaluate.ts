import type { PlanStop, PlanTrip, SurgeRequest } from '../types.js';
import type { LoadedDay, VehicleInfo } from '../data/dataset.js';
import { vehicleInfoFor } from '../data/dataset.js';
import { metersToKm } from '../units.js';
import { makeLeg, waitSec, lateSec } from './schedule.js';
import { loadTariff, tripCost, type Tariff } from '../cost.js';

/* Re-evaluate one vehicle trip for a proposed stop order WITHOUT re-solving.
 *
 * The browser cannot do this: the all-pairs travel matrix (N^2) and the carrier
 * tariff live only on the server. But recomputing the schedule for a fixed order
 * is cheap and deterministic, it is the same forward pass the mapper runs on a
 * Surge solution (arrival = prev departure + leg; service_start = max(arrival,
 * tw_early); wait and lateness fall out), reusing the exact same matrix and cost
 * model. Anchoring the depot departure to the trip's original startSec means
 * evaluating the UNCHANGED order reproduces the plan's numbers, so a reorder
 * preview differs only by the reorder's own effect. Surge may still shift the
 * departure on the next Replan; this is an honest "same truck, same start, this
 * order" preview, not a re-optimization. */
export interface EvaluateTripInput {
  day: LoadedDay;
  request: SurgeRequest;
  vehicleId: number;
  tripIndex: number;
  startSec: number;          // depot departure to anchor the schedule to
  tripCountOnVehicle: number; // for per-vehicle fixed-cost amortization
  reloadSecAfter: number;    // carried through unchanged (depends on neighbor trips)
  orderNos: string[];        // the proposed visiting order
  requestIds?:number[];
  vehicleInfo: Map<string, VehicleInfo>;
  tariff?: Tariff;
}

export function evaluateTrip(inp: EvaluateTripInput): PlanTrip {
  const { request, day } = inp;
  const leg = makeLeg(request.travel);
  const depotLoc = 0;
  const tariff = inp.tariff ?? loadTariff();

  const taskByRef = new Map<string,typeof request.tasks>();
  for(const t of request.tasks)taskByRef.set(t.ref,[...(taskByRef.get(t.ref)??[]),t]);
  const taskById=new Map(request.tasks.map(t=>[t.id,t])),requests=new Map(request.requests.map(r=>[r.id,r]));
  const veh = request.vehicles.find((v) => v.id === inp.vehicleId);
  const vinfo = vehicleInfoFor(veh?.ref ?? '', inp.vehicleInfo);

  let prevLoc = depotLoc;
  let t = inp.startSec;
  let meters = 0, loadKg = 0, loadPallets = 0;
  const stops: PlanStop[] = inp.orderNos.map((orderNo, i) => {
    const requestId=inp.requestIds?.[i],options=taskByRef.get(orderNo)??[];
    if(requestId===undefined&&options.length>1)throw new Error('Ambiguous delivery reference in preview');
    const task=requestId===undefined?options[0]:taskById.get(requests.get(requestId)?.delivery_task_id??-1);
    if(requestId!==undefined&&(!task||task.ref!==orderNo))throw new Error('Preview delivery identity mismatch');
    const loc = task ? request.locations[task.location_id] : undefined;
    const info = (requestId===undefined?undefined:day.deliveryEnrichment?.get(requestId))??day.enrichment.get(orderNo) ?? null;
    const weightKg = task?.demand[0] ?? 0;
    const pallets = task?.demand[1] ?? 0;
    loadKg += weightKg; loadPallets += pallets;
    const travelToSec = task ? leg.durSec(prevLoc, task.location_id) : 0;
    meters += task ? leg.distM(prevLoc, task.location_id) : 0;
    const arrival = t + travelToSec;
    const twEarly = task?.tw_early ?? 0;
    const twLate = task?.tw_late ?? 0;
    const serviceStart = Math.max(arrival, twEarly);
    const serviceSec = task?.service_seconds ?? 0;
    const departure = serviceStart + serviceSec;
    if (task) { prevLoc = task.location_id; t = departure; }
    return {
      ...(requestId===undefined?{}:{requestId}),
      orderId: info?.id ?? null,
      orderNo,
      customer: info?.customer ?? null,
      city: info?.city ?? null,
      lon: loc?.x ?? 0, lat: loc?.y ?? 0, seq: i + 1,
      type: task?.type ?? 'delivery',
      arrivalSec: arrival,
      serviceStartSec: serviceStart,
      departureSec: departure,
      twStartSec: twEarly,
      twEndSec: twLate,
      pallets, weightKg,
      serviceMin: Math.round(serviceSec / 60),
      waitSec: waitSec(arrival, serviceStart),
      travelToSec,
      lateBySec: lateSec(arrival, twLate),
      requiresTailLift: Boolean(info?.requiresTailLift),
      maxTonnage: info?.maxTonnage ?? null,
    };
  });
  meters += prevLoc !== depotLoc ? leg.distM(prevLoc, depotLoc) : 0;
  const endSec = prevLoc !== depotLoc ? t + leg.durSec(prevLoc, depotLoc) : inp.startSec;
  const distanceKm = metersToKm(meters);
  return {
    index: inp.tripIndex,
    startSec: inp.startSec,
    endSec,
    distanceKm,
    reloadSecAfter: Math.max(0, inp.reloadSecAfter),
    loadKg, loadPallets,
    costFt: tripCost(tariff, { vehicleClass: vinfo?.vehicleClass ?? null, isSubcontractor: Boolean(vinfo?.isSubcontractor) }, { distanceKm, drops: stops.length }, Math.max(1, inp.tripCountOnVehicle)),
    stops,
    geometry: null,
  };
}
