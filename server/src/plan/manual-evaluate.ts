import { vehicleCostFor, tripCost, type Tariff } from '../cost.js';
import type { SurgeRequest, SurgeTask } from '../types.js';
import { assertManualLayout, type ManualLayout } from './manual.js';

/** Internal, server-owned inputs only. Policy exceptions must already have been
 * applied/verified by the dataset adapter. No client-supplied feasibility facts. */
export interface ManualEvaluationInput {
  layout: ManualLayout;
  datasetSha256: string;
  request: SurgeRequest;
  requirements: Map<number, { maxTonnage: number | null; requiresTailLift: boolean }>;
  fleet: Map<number, { grossTonnage: number | null; hasTailLift: boolean;
    vehicleClass: string | null; isSubcontractor: boolean; reloadSec: number }>;
  /** Departure anchors keyed by vehicle/trip; new trips require explicit anchors. */
  departures: Map<string, number>;
  tariff: Tariff;
  tariffSha256: string;
}
export interface ManualViolation {
  actual?: number;
  limit?: number;
  dimension?: string;
  type: 'CAPACITY' | 'HARD_TW' | 'VEHICLE_SIZE' | 'TAIL_LIFT' | 'SHIFT' | 'MAX_TRIPS'
    | 'MAX_DISTANCE' | 'MAX_DURATION' | 'EXCLUDED' | 'ASSIGNMENT';
  vehicleId: number;
  requestId?: number;
  soft: false;
}
export interface ManualEvaluatedTrip {
  tripId: string; startSec: number; endSec: number; distanceKm: number;
  loadKg: number; loadPallets: number; cost: number;
  stops: { requestId: number; taskId: number; arrivalSec: number; serviceStartSec: number;
    departureSec: number; waitSec: number; lateSec: number }[];
}
export interface ManualEvaluation {
  version: 1; datasetSha256: string; tariffSha256: string;
  validation: { valid: boolean; violations: ManualViolation[] };
  vehicles: { vehicleId: number; trips: ManualEvaluatedTrip[]; distanceKm: number; cost: number }[];
  stats: { totalOrders: number; servedOrders: number; unassignedOrders: number;
    vehiclesUsed: number; trips: number; totalDistanceKm: number };
  cost: { total: number; fixed: number; variable: number; currency: string; source: Tariff['source'] };
}
function need(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`manual evaluation: ${message}`);
}
function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
export const manualTripKey = (vehicleId: number, tripId: string): string => `${vehicleId}:${tripId}`;

/** Deterministic delivery-only evaluation. Unsupported models fail closed rather
 * than returning an optimistic certificate. This does not publish/approve a plan. */
export function evaluateManualLayout(input: ManualEvaluationInput): ManualEvaluation {
  const { layout, request, tariff } = input;
  assertManualLayout(layout);
  need(layout.datasetSha256 === input.datasetSha256, 'dataset identity mismatch');
  need(/^[a-f0-9]{64}$/.test(input.tariffSha256), 'tariff identity missing');
  need(request.dimension_count === 2 && request.demand_sign_convention === 1, 'unsupported demand model');
  need(!request.precedences?.length, 'precedence validation requires the dataset adapter');
  need(!layout.lockedVehicleIds.length, 'locked-route validation requires the parent-plan adapter');
  const N = request.travel.location_count;
  need(Number.isSafeInteger(N) && N > 0 && N === request.locations.length, 'invalid matrix dimensions');
  const tasks = new Map(request.tasks.map(task => [task.id, task]));
  const requests = new Map(request.requests.map(order => [order.id, order]));
  const vehicles = new Map(request.vehicles.map(vehicle => [vehicle.id, vehicle]));
  need(tasks.size === request.tasks.length && requests.size === request.requests.length && vehicles.size === request.vehicles.length, 'duplicate dataset identities');
  need(layout.requestIds.every(id => requests.has(id)) && layout.vehicleIds.every(id => vehicles.has(id)), 'layout references unknown dataset identity');
  const taskFor = (id: number): SurgeTask => {
    const task = tasks.get(requests.get(id)!.delivery_task_id);
    need(task && task.type === 'delivery', 'unsupported or missing delivery task');
    need(Number.isSafeInteger(task.location_id) && task.location_id >= 0 && task.location_id < N, 'invalid task location');
    need(task.demand.length === 2 && task.demand.every(nonnegative), 'invalid demand');
    need([task.tw_early, task.tw_late, task.service_seconds].every(nonnegative), 'invalid task timing');
    return task;
  };
  layout.requestIds.forEach(taskFor);
  const leg = (a: number, b: number) => {
    const distance = request.travel.distances[a*N+b], duration = request.travel.durations[a*N+b];
    need(nonnegative(distance) && nonnegative(duration), 'missing or invalid travel leg');
    return { distance, duration };
  };
  need(request.travel.distances.length === N*N && request.travel.durations.length === N*N, 'incomplete matrix');
  need(tariff.model === 'per_vehicle' || tariff.model === 'per_trip', 'unsupported tariff model');
  need([tariff.perKmDefault, tariff.fixedPerVehicle, tariff.perTripBase, tariff.perKm, tariff.perDrop,
    tariff.includedDrops, tariff.subcontractorMultiplier, tariff.ownFleetMultiplier,
    ...Object.values(tariff.perKmByClass), ...Object.values(tariff.fixedByClass)].every(nonnegative), 'invalid tariff');
  const violations: ManualViolation[] = [];
  const result: ManualEvaluation = { version: 1, datasetSha256: input.datasetSha256, tariffSha256: input.tariffSha256,
    validation: { valid: false, violations }, vehicles: [],
    stats: { totalOrders: layout.requestIds.length, servedOrders: layout.requestIds.length-layout.unassigned.length,
      unassignedOrders: layout.unassigned.length, vehiclesUsed: 0, trips: 0, totalDistanceKm: 0 },
    cost: { total: 0, fixed: 0, variable: 0, currency: tariff.currency, source: tariff.source } };
  for (const vehicleId of layout.vehicleIds) {
    const routes = layout.routes.filter(route => route.vehicleId === vehicleId && route.requestIds.length);
    if (!routes.length) continue; // available vehicles incur no standing charge
    const vehicle = vehicles.get(vehicleId)!, info = input.fleet.get(vehicleId);
    need(info && nonnegative(info.reloadSec) && typeof info.hasTailLift === 'boolean', 'missing fleet metadata');
    need(info.grossTonnage === null || nonnegative(info.grossTonnage) && info.grossTonnage > 0, 'invalid vehicle GVW');
    need(vehicle.capacity.length === 2 && vehicle.capacity.every(nonnegative), 'invalid capacity');
    need(vehicle.start_depot_id === 0 && vehicle.end_depot_id === 0 &&
      (request.depots[0] as { location_id?: number } | undefined)?.location_id === 0, 'unsupported depot model');
    for (const value of [vehicle.shift_early, vehicle.shift_late, vehicle.max_trips, vehicle.max_distance, vehicle.max_duration])
      need(value === undefined || nonnegative(value), 'invalid vehicle limit');
    const issue = (type: ManualViolation['type'], requestId?: number, evidence: Pick<ManualViolation, 'actual'|'limit'|'dimension'> = {}) => violations.push({ type, vehicleId, ...(requestId === undefined ? {} : { requestId }), ...evidence, soft: false });
    if (layout.excludedVehicleIds.includes(vehicleId)) issue('EXCLUDED');
    if (vehicle.max_trips !== undefined && routes.length > vehicle.max_trips) issue('MAX_TRIPS');
    const trips: ManualEvaluatedTrip[] = [];
    let previousEnd = vehicle.shift_early ?? 0;
    for (const route of routes) {
      const anchor = input.departures.get(manualTripKey(vehicleId, route.tripId));
      need(nonnegative(anchor), 'departure anchor missing');
      const startSec = Math.max(anchor, previousEnd + (trips.length ? info.reloadSec : 0));
      let time = startSec, position = 0, distance = 0, loadKg = 0, loadPallets = 0;
      const stops: ManualEvaluatedTrip['stops'] = [];
      for (const requestId of route.requestIds) {
        const task = taskFor(requestId), order = requests.get(requestId)!;
        const requirements = input.requirements.get(requestId);
        need(requirements && typeof requirements.requiresTailLift === 'boolean' &&
          (requirements.maxTonnage === null || nonnegative(requirements.maxTonnage) && requirements.maxTonnage > 0), 'missing access evidence');
        const edge = leg(position, task.location_id);
        distance += edge.distance;
        const arrivalSec = time + edge.duration, serviceStartSec = Math.max(arrivalSec, task.tw_early);
        const departureSec = serviceStartSec + task.service_seconds;
        stops.push({ requestId, taskId: task.id, arrivalSec, serviceStartSec, departureSec,
          waitSec: serviceStartSec-arrivalSec, lateSec: task.tw_late > 0 ? Math.max(0, serviceStartSec-task.tw_late) : 0 });
        loadKg += task.demand[0]!; loadPallets += task.demand[1]!;
        if (task.tw_late > 0 && serviceStartSec > task.tw_late) issue('HARD_TW', requestId, { actual: serviceStartSec, limit: task.tw_late });
        if (requirements.maxTonnage !== null && (info.grossTonnage === null || info.grossTonnage > requirements.maxTonnage)) issue('VEHICLE_SIZE', requestId, { ...(info.grossTonnage === null ? {} : { actual: info.grossTonnage }), limit: requirements.maxTonnage });
        if (requirements.requiresTailLift && !info.hasTailLift) issue('TAIL_LIFT', requestId);
        const retained = layout.decisions[String(requestId)];
        if (order.allowed_vehicles?.length && !order.allowed_vehicles.includes(vehicleId) || order.forbidden_vehicles?.includes(vehicleId)
          || retained?.kind === 'unassigned' || retained?.kind === 'vehicle' && retained.vehicleId !== vehicleId) issue('ASSIGNMENT', requestId);
        time = departureSec; position = task.location_id;
      }
      const home = leg(position, 0); distance += home.distance; time += home.duration;
      need([loadKg, loadPallets, distance, time].every(nonnegative), 'non-finite trip result');
      if (loadKg > vehicle.capacity[0]!) issue('CAPACITY', undefined, { actual: loadKg, limit: vehicle.capacity[0], dimension: 'kg' });
      if (loadPallets > vehicle.capacity[1]!) issue('CAPACITY', undefined, { actual: loadPallets, limit: vehicle.capacity[1], dimension: 'pallets' });
      if (vehicle.shift_late !== undefined && time > vehicle.shift_late) issue('SHIFT');
      trips.push({ tripId: route.tripId, startSec, endSec: time, distanceKm: distance/1000,
        loadKg, loadPallets, cost: 0, stops });
      previousEnd = time;
    }
    const distanceKm = trips.reduce((sum, trip) => sum+trip.distanceKm, 0);
    if (vehicle.max_distance !== undefined && distanceKm*1000 > vehicle.max_distance) issue('MAX_DISTANCE');
    if (vehicle.max_duration !== undefined && previousEnd-trips[0]!.startSec > vehicle.max_duration) issue('MAX_DURATION');
    const cost = vehicleCostFor(tariff, { ...info, distanceKm, trips: trips.map(trip => ({ distanceKm: trip.distanceKm, drops: trip.stops.length })) });
    let allocated = 0;
    for (const [index, trip] of trips.entries()) {
      // Reconcile rounding so displayed trip totals equal authoritative vehicle cost.
      const proposed = tripCost(tariff, info, { distanceKm: trip.distanceKm, drops: trip.stops.length }, trips.length);
      need(nonnegative(proposed), 'non-finite trip cost');
      trip.cost = index === trips.length-1 ? cost.total-allocated : Math.min(cost.total-allocated, proposed);
      allocated += trip.cost;
    }
    need([cost.total, cost.fixed, cost.variable, previousEnd, distanceKm].every(nonnegative), 'non-finite evaluation result');
    result.vehicles.push({ vehicleId, trips, distanceKm, cost: cost.total });
    result.stats.trips += trips.length; result.stats.totalDistanceKm += distanceKm;
    result.cost.total += cost.total; result.cost.fixed += cost.fixed; result.cost.variable += cost.variable;
  }
  result.stats.vehiclesUsed = result.vehicles.length;
  result.validation.valid = violations.length === 0;
  return result;
}
