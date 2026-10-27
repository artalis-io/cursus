import type { Plan, SurgeRequest, SurgeSolution } from '../types.js';
import type { Scenario } from '../store.js';
import { assertManualLayout, type ManualLayout } from './manual.js';
import { isDeepStrictEqual } from 'node:util';

export const datasetAllowances = (request: SurgeRequest): Map<number, number[] | undefined> =>
  new Map(request.requests.map(order => [order.id, order.allowed_vehicles ? [...order.allowed_vehicles] : undefined]));
function need(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`retained assignments: ${message}`);
}

/** Called AFTER existing pins, sequences and safety exclusions. Never encode an
 * impossible assignment as an empty allowlist (native means unrestricted). */
export function applyRetainedDecisions(request: SurgeRequest, scenario: Scenario, datasetSha256: string | undefined,
  baseline: ReturnType<typeof datasetAllowances>): void {
  const retained = scenario.manualDecisions;
  if (!retained) {
    need(!scenario.manualPlanId, 'manual state is incomplete');
    return;
  }
  need(typeof scenario.manualPlanId === 'string' && !!scenario.manualPlanId, 'manual parent identity is missing');
  need(/^[a-f0-9]{64}$/.test(retained.datasetSha256) && retained.datasetSha256 === datasetSha256, 'dataset identity changed');
  const requests = new Map(request.requests.map(order => [order.id, order]));
  const available = new Set(request.vehicles.map(vehicle => vehicle.id));
  for (const [key, decision] of Object.entries(retained.decisions)) {
    const id = Number(key), order = requests.get(id);
    need(Number.isSafeInteger(id) && id >= 0 && String(id) === key && order, 'unknown decision identity');
    need(baseline.has(id), 'missing dataset assignment evidence');
    need(decision && (decision.kind === 'unassigned' || decision.kind === 'vehicle' && Number.isSafeInteger(decision.vehicleId) && decision.vehicleId >= 0), 'invalid decision');
    const forbidden = new Set(order.forbidden_vehicles ?? []);
    if (decision.kind === 'unassigned' || !available.has(decision.vehicleId)) {
      for (const vehicleId of available) forbidden.add(vehicleId);
    } else {
      const datasetAllowed = baseline.get(id);
      if (datasetAllowed?.length && !datasetAllowed.includes(decision.vehicleId)) forbidden.add(decision.vehicleId);
      order.allowed_vehicles = [decision.vehicleId];
    }
    order.forbidden_vehicles = [...forbidden];
  }
  // Old seeds/frozen flags must not reinstate a manually deassigned request or
  // force a pinned request into its old vehicle before construction starts.
  const extra = request as SurgeRequest & { initial_routes?: { vehicle_id: number; request_ids: number[] }[];
    frozen_requests?: number[]; committed_requests?: number[] };
  if (extra.initial_routes) extra.initial_routes = extra.initial_routes.map(route => ({ ...route,
    request_ids: route.request_ids.filter(id => {
      const order = requests.get(id);
      return order && !order.forbidden_vehicles?.includes(route.vehicle_id) &&
        (!order.allowed_vehicles?.length || order.allowed_vehicles.includes(route.vehicle_id));
    }) }));
  for (const key of ['frozen_requests','committed_requests'] as const)
    if (extra[key]) extra[key] = extra[key]!.filter(id => !retained.decisions[String(id)]);
}

/** Independent native output boundary: complete identity partition and retained
 * restrictions must hold even if a native regression returns a plausible plan. */
export function verifyRetainedSolution(request: SurgeRequest, scenario: Scenario, solution: SurgeSolution): void {
  if (!scenario.manualDecisions) return;
  const orders = new Map(request.requests.map(order => [order.id, order]));
  const seen = new Set<number>(), vehicles = new Set(request.vehicles.map(vehicle => vehicle.id));
  for (const route of solution.routes) {
    need(vehicles.has(route.vehicle_id), 'native returned unknown vehicle');
    for (const stop of route.stops) {
      const order = orders.get(stop.request_id), decision = scenario.manualDecisions.decisions[String(stop.request_id)];
      need(order && !seen.has(order.id) && order.delivery_task_id === stop.task_id, 'native returned invalid or duplicate delivery');
      need(!order.allowed_vehicles?.length || order.allowed_vehicles.includes(route.vehicle_id), 'native violated allowed vehicle');
      need(!order.forbidden_vehicles?.includes(route.vehicle_id), 'native violated forbidden vehicle');
      need(!decision || decision.kind === 'vehicle' && decision.vehicleId === route.vehicle_id, 'native ignored manual decision');
      seen.add(order.id);
    }
  }
  for (const id of solution.unassigned) { need(orders.has(id) && !seen.has(id), 'native returned invalid unassigned partition'); seen.add(id); }
  need(seen.size === orders.size, 'native omitted deliveries');
}

/** Fresh layout over solver output; history/ownership survives without copying
 * the parent's manual evaluator certificate into a new optimized plan. */
export function withRetainedProvenance(plan: Plan, scenario: Scenario, datasetVehicles: number[]): Plan {
  const retained = scenario.manualDecisions;
  if (!retained) return plan;
  need(plan.provenance.datasetSha256 === retained.datasetSha256, 'mapped dataset identity changed');
  const layout: ManualLayout = { datasetSha256: retained.datasetSha256,
    requestIds: [...plan.vehicles.flatMap(v => v.trips.flatMap(t => t.stops.map(s => s.requestId!))), ...plan.unassigned.map(o => o.requestId!)],
    vehicleIds: datasetVehicles, excludedVehicleIds: [...new Set([...scenario.removedVehicleIds,...(retained.unavailableVehicleIds??[])])],
    lockedVehicleIds: scenario.sequences.filter(sequence => sequence.locked).map(sequence => sequence.vehicleId),
    routes: plan.vehicles.flatMap(v => v.trips.map(t => ({ vehicleId: v.id, tripId: `trip-${t.index}`, requestIds: t.stops.map(s => s.requestId!) }))),
    unassigned: plan.unassigned.map(o => o.requestId!), decisions: structuredClone(retained.decisions),
    origins: structuredClone(retained.origins ?? {}), history: structuredClone(retained.history ?? []) };
  for (const id of layout.requestIds) layout.origins[String(id)] ??= 'historical';
  assertManualLayout(layout);
  const result: Plan = { ...plan, assignments: { version: 1, parentPlanId: scenario.manualPlanId ?? '', layout },
    unassigned: plan.unassigned.map(order => retained.decisions[String(order.requestId)]?.kind === 'unassigned'
      ? { ...order, reason: 'Manually unassigned', reasonCode: 'MANUAL_UNASSIGNED' }
      :retained.decisions[String(order.requestId)]?.kind==='vehicle'
        ?{...order,reason:'Retained vehicle assignment was not served by the solver',reasonCode:'PINNED_INFEASIBLE'}:order) };
  delete result.manual;
  return result;
}

/** Write-boundary validation, not just a pre-publication worker-side assertion. */
export function assertRetainedPlan(plan: Plan, scenario: Scenario): void {
  const retained = scenario.manualDecisions;
  if (!retained) return;
  need(plan.scenarioId === scenario.id && plan.scenarioRevision === scenario.revision, 'publication scenario identity changed');
  const assignments = plan.assignments;
  if(retained.tariffSha256)need(plan.provenance.tariffSha256===retained.tariffSha256,'publication changed tariff identity');
  need(assignments?.version === 1 && assignments.layout.datasetSha256 === retained.datasetSha256 &&
    plan.provenance?.datasetSha256 === retained.datasetSha256, 'publication missing dataset/provenance evidence');
  assertManualLayout(assignments.layout);
  need(plan.vehicles.every(v=>!retained.unavailableVehicleIds?.includes(v.id)), 'publication used an unavailable vehicle');
  need((retained.unavailableVehicleIds??[]).every(id=>assignments.layout.excludedVehicleIds.includes(id)), 'publication erased vehicle availability policy');
  need(Array.isArray(retained.requestIds) && isDeepStrictEqual([...retained.requestIds].sort((a,b)=>a-b),
    [...assignments.layout.requestIds].sort((a,b)=>a-b)), 'publication changed request inventory');
  need(isDeepStrictEqual(assignments.layout.history, retained.history ?? []) &&
    Object.entries(retained.origins ?? {}).every(([key, origin]) => assignments.layout.origins[key] === origin), 'publication erased manual provenance');
  for (const [key, decision] of Object.entries(retained.decisions)) {
    const recorded = assignments.layout.decisions[key];
    need(recorded?.kind === decision.kind && (decision.kind !== 'vehicle' || recorded.kind === 'vehicle' && recorded.vehicleId === decision.vehicleId), 'publication changed retained decisions');
    for (const vehicle of plan.vehicles) for (const trip of vehicle.trips) for (const stop of trip.stops) {
      if (stop.requestId === Number(key)) need(decision.kind === 'vehicle' && decision.vehicleId === vehicle.id, 'publication violates retained decision');
    }
  }
  const actual = plan.vehicles.flatMap(vehicle => vehicle.trips.map(trip => ({ vehicleId: vehicle.id,
    tripId: `trip-${trip.index}`, requestIds: trip.stops.map(stop => stop.requestId!) })));
  need(JSON.stringify(actual) === JSON.stringify(assignments.layout.routes) &&
    JSON.stringify(plan.unassigned.map(order => order.requestId)) === JSON.stringify(assignments.layout.unassigned), 'publication layout does not match plan');
  const served = actual.reduce((count, route) => count+route.requestIds.length, 0);
  need(Array.isArray(retained.reloadSeconds),'publication missing reload evidence');
  const reload=new Map(retained.reloadSeconds);
  for(const vehicle of plan.vehicles){const seconds=reload.get(vehicle.id);
    for(let i=1;i<vehicle.trips.length;i++)need(typeof seconds==='number'&&
      vehicle.trips[i]!.startSec>=vehicle.trips[i-1]!.endSec+seconds-1,'publication violated depot reload time');
  }
  need(plan.stats.totalOrders === assignments.layout.requestIds.length && plan.stats.servedOrders === served &&
    plan.stats.deliveryStops === served && plan.stats.trips === actual.length && plan.stats.vehiclesUsed === plan.vehicles.length,
    'publication coverage/KPIs do not match request inventory');
  need(Object.keys(assignments.layout.decisions).length === Object.keys(retained.decisions).length, 'publication added retained decisions');
}
