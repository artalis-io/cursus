import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { applyFleetSettings } from '../state/manual-settings.js';
import { metersToKm } from '../units.js';
import type { LoadedDay, VehicleInfo } from '../data/dataset.js';
import type { Tariff } from '../cost.js';
import { vehicleCostFor, tariffIdentity } from '../cost.js';
import type { Plan, PlanStop, PlanUnassigned } from '../types.js';
import type { Scenario } from '../store.js';
import { applyOverrides, applyVehicleOverrides } from '../solve.js';
import { grossTonnage, hasTailLift } from './access.js';
import { assertManualLayout, type ManualLayout } from './manual.js';
import { evaluateManualLayout, manualTripKey, type ManualEvaluation, type ManualEvaluationInput } from './manual-evaluate.js';

export interface ManualDatasetContext {
  datasetSha256?: string;
  unavailableVehicleIds?: number[];
  day: LoadedDay;
  vehicleInfo: Map<string, VehicleInfo>;
  tariff: Tariff;
  /** Trusted explicit handling time; missing values are not guessed. */
  reloadSeconds: Map<number, number>;
}
export class ManualAdapterError extends Error {}
const requireThat = (condition: unknown, message: string): void => { if (!condition) throw new ManualAdapterError(message); };
export function prepareManualInput(parent: Plan, scenario: Scenario, context: ManualDatasetContext): ManualEvaluationInput {
  const { day, vehicleInfo, tariff } = context;
  requireThat(!context.datasetSha256 || context.datasetSha256===day.datasetRequestSha256, 'fleet settings dataset mismatch');
  const unavailable=context.unavailableVehicleIds??[];
  requireThat(new Set(unavailable).size===unavailable.length && unavailable.every(id=>day.request.vehicles.some(v=>v.id===id)), 'unknown unavailable vehicle');
  if (scenario.manualDecisions) {
    const snapshot=scenario.manualDecisions;
    requireThat(snapshot.tariff && snapshot.tariffSha256 === tariffIdentity(snapshot.tariff) &&
      snapshot.tariffSha256 === tariffIdentity(tariff) && snapshot.fleetInfo && snapshot.reloadSeconds &&
      isDeepStrictEqual(new Map(snapshot.fleetInfo),vehicleInfo) &&
      isDeepStrictEqual(new Map(snapshot.reloadSeconds),context.reloadSeconds),
      'manual tariff, fleet or reload settings changed; reconcile settings before editing');
    requireThat(isDeepStrictEqual([...(snapshot.unavailableVehicleIds??[])].sort((a,b)=>a-b),[...unavailable].sort((a,b)=>a-b)), 'manual vehicle availability policy changed');
  }
  requireThat(parent.scenarioId === scenario.id && parent.scenarioRevision === scenario.revision, 'parent plan is stale');
  requireThat(day.def.id === scenario.day && parent.day === day.def.isoDate, 'dataset day mismatch');
  const sha = day.datasetRequestSha256;
  requireThat(sha && /^[a-f0-9]{64}$/.test(sha), 'immutable dataset identity required');
  const previousAssignments = parent.manual ?? parent.assignments;
  const recorded = previousAssignments?.layout.datasetSha256 ?? parent.provenance.datasetSha256 ?? parent.provenance.planningPolicy?.datasetRequestSha256;
  requireThat(recorded === sha, 'parent dataset identity unavailable or mismatched');
  requireThat(JSON.stringify(day.planningPolicy ?? null) === JSON.stringify(scenario.planningPolicy ?? null), 'effective policy does not match scenario');
  const { travel, ...rest } = day.request;
  const request = structuredClone(rest); // matrix is immutable, avoid N² copy
  const full = { ...request, travel };
  requireThat(applyFleetSettings(full,sha,context), 'fleet settings dataset mismatch');
  full.requests = full.requests.filter(order => day.scopeTaskIds.has(order.delivery_task_id));
  applyVehicleOverrides(full, scenario);
  applyOverrides(full, scenario, new Set(full.vehicles.map(vehicle => vehicle.id)));
  const tasks = new Map(full.tasks.map(task => [task.id, task]));
  const requests = new Map(full.requests.map(order => [order.id, order]));
  const refs = new Map<string, number[]>();
  for (const order of full.requests) {
    const task = tasks.get(order.delivery_task_id);
    requireThat(task, 'dataset delivery task missing');
    const ids = refs.get(task!.ref) ?? []; ids.push(order.id); refs.set(task!.ref, ids);
  }
  const identify = (stop: PlanStop | PlanUnassigned): number => {
    const candidates = refs.get(stop.orderNo) ?? [];
    const id = stop.requestId ?? (candidates.length === 1 ? candidates[0] : undefined);
    requireThat(id !== undefined && candidates.includes(id) && requests.has(id), 'ambiguous or unknown parent delivery identity');
    return id!;
  };
  const routes = parent.vehicles.flatMap(vehicle => vehicle.trips.map(trip => ({ vehicleId: vehicle.id,
    tripId: trip.manualTripId ?? `trip-${trip.index}`, requestIds: trip.stops.map(identify) })));
  const layout: ManualLayout = { datasetSha256: sha!, requestIds: full.requests.map(order => order.id),
    vehicleIds: full.vehicles.map(vehicle => vehicle.id), excludedVehicleIds: [...new Set([...scenario.removedVehicleIds,...unavailable])],
    lockedVehicleIds: scenario.sequences.filter(seq => seq.locked).map(seq => seq.vehicleId),
    routes, unassigned: parent.unassigned.map(identify), decisions: structuredClone(previousAssignments?.layout.decisions ?? {}),
    origins: structuredClone(previousAssignments?.layout.origins ?? {}), history: structuredClone(previousAssignments?.layout.history ?? []) };
  if (!previousAssignments) for (const id of layout.requestIds) layout.origins[String(id)] = parent.source === 'live' ? 'optimizer' : 'historical';
  assertManualLayout(layout);
  const requirements: ManualEvaluationInput['requirements'] = new Map();
  for (const order of full.requests) {
    const task = tasks.get(order.delivery_task_id)!, info = day.enrichment.get(task.ref);
    // Shared label metadata is usable only with the loader's independent
    // agreement proof; each delivery still needs its stable request identity.
    requireThat(info && (refs.get(task.ref)?.length === 1||day.verifiedSharedAccessRefs?.has(task.ref)), 'unambiguous access evidence required');
    requirements.set(order.id, { maxTonnage: info!.maxTonnage, requiresTailLift: info!.requiresTailLift });
  }
  const fleet: ManualEvaluationInput['fleet'] = new Map();
  for (const vehicle of full.vehicles) {
    const info = vehicleInfo.get(vehicle.ref.replace(/[^a-z0-9]/gi, '').toUpperCase());
    const reloadSec = context.reloadSeconds.get(vehicle.id);
    requireThat(info && typeof reloadSec === 'number' && Number.isSafeInteger(reloadSec) && reloadSec >= 0 && reloadSec <= 2147483647 &&
      (vehicle.trip_reload_seconds===undefined||vehicle.trip_reload_seconds===reloadSec), 'trusted fleet/reload evidence required');
    fleet.set(vehicle.id, { vehicleClass: info!.vehicleClass, isSubcontractor: info!.isSubcontractor,
      grossTonnage: grossTonnage(vehicle, vehicleInfo), hasTailLift: hasTailLift(vehicle, vehicleInfo), reloadSec: reloadSec! });
  }
  const departures = new Map<string, number>();
  for (const vehicle of parent.vehicles) for (const trip of vehicle.trips)
    departures.set(manualTripKey(vehicle.id, trip.manualTripId ?? `trip-${trip.index}`), trip.startSec);
  // Explicit new-trip IDs are scheduled no earlier than shift start and all
  // preceding trips, using server-owned reload data; clients cannot submit times.
  return { layout, datasetSha256: sha!, request: full, requirements, fleet, departures, tariff,
    tariffSha256: tariffIdentity(tariff) };
}

/** Check parent locks and scenario sequences before issuing validation evidence. */
export function evaluateManualInput(input: ManualEvaluationInput, parent: ManualLayout, scenario: Scenario): ManualEvaluation {
  for (const vehicleId of parent.lockedVehicleIds) {
    requireThat(JSON.stringify(input.layout.routes.filter(r => r.vehicleId === vehicleId)) ===
      JSON.stringify(parent.routes.filter(r => r.vehicleId === vehicleId)), 'locked parent route changed');
  }
  const unlocked = { ...input.layout, lockedVehicleIds: [] };
  const evaluation = evaluateManualLayout({ ...input, layout: unlocked, request: { ...input.request, precedences: undefined } });
  const assigned = new Map(input.layout.routes.flatMap(route => route.requestIds.map(id => [id, route.vehicleId] as const)));
  const taskRef = new Map(input.request.tasks.map(task => [task.id, task.ref]));
  const idRef = new Map(input.request.requests.map(order => [order.id, taskRef.get(order.delivery_task_id)]));
  for (const sequence of scenario.sequences) {
    const ids = input.layout.routes.filter(route => route.vehicleId === sequence.vehicleId).flatMap(route => route.requestIds);
    const actual = sequence.requestIds ? ids : ids.map(id => idRef.get(id));
    const expected = sequence.requestIds ?? sequence.orderNos;
    if (!sequence.requestIds) {
      for (const ref of expected) requireThat([...idRef.values()].filter(value => value === ref).length === 1,
        'ambiguous legacy sequence; use delivery identities');
    }
    const filtered = actual.filter(value => (expected as (string | number | undefined)[]).includes(value));
    requireThat(JSON.stringify(filtered) === JSON.stringify(expected), 'scenario sequence changed; clear it explicitly first');
    if (sequence.locked) requireThat(JSON.stringify(actual) === JSON.stringify(expected), 'scenario locked route changed');
  }
  for (const edge of input.request.precedences ?? []) {
    requireThat(input.layout.requestIds.includes(edge.before) && input.layout.requestIds.includes(edge.after), 'precedence references an out-of-scope request');
    const before = assigned.get(edge.before), after = assigned.get(edge.after);
    const starts = evaluation.vehicles.flatMap(v => v.trips.flatMap(t => t.stops));
    const a = starts.find(stop => stop.requestId === edge.before), b = starts.find(stop => stop.requestId === edge.after);
    if (b && (!a || before !== after || a.departureSec > b.serviceStartSec))
      evaluation.validation.violations.push({ type: 'ASSIGNMENT', vehicleId: after!, requestId: edge.after, soft: false });
  }
  evaluation.validation.valid = evaluation.validation.violations.length === 0;
  return evaluation;
}

export function materializeManualPlan(parent: Plan, scenario: Scenario, input: ManualEvaluationInput,
  evaluation: ManualEvaluation, context: ManualDatasetContext, id: string, createdAt: string): Plan {
  const reqs = new Map(input.request.requests.map(order => [order.id, order]));
  const tasks = new Map(input.request.tasks.map(task => [task.id, task]));
  const taskFor = (requestId: number) => tasks.get(reqs.get(requestId)!.delivery_task_id)!;
  const rowFor = (requestId: number) => context.day.enrichment.get(taskFor(requestId).ref)!;
  const vehicles = evaluation.vehicles.map(v => {
    const source = input.request.vehicles.find(vehicle => vehicle.id === v.vehicleId)!, info = input.fleet.get(v.vehicleId)!;
    const trips = v.trips.map((trip, index) => ({ index, manualTripId: trip.tripId, startSec: trip.startSec, endSec: trip.endSec,
      distanceKm: trip.distanceKm, loadKg: trip.loadKg, loadPallets: trip.loadPallets, costFt: trip.cost,
      reloadSecAfter: v.trips[index+1] ? v.trips[index+1]!.startSec-trip.endSec : 0, geometry: null,
      stops: trip.stops.map((stop, i) => {
        const task = taskFor(stop.requestId), row = rowFor(stop.requestId), loc = input.request.locations[task.location_id]!;
        const access = input.requirements.get(stop.requestId)!;
        const previous = i ? taskFor(trip.stops[i-1]!.requestId).location_id : 0;
        return { requestId: stop.requestId, orderId: row.id, orderNo: task.ref, customer: row.customer, city: row.city,
          lon: loc.x, lat: loc.y, seq: i+1, type: task.type, arrivalSec: stop.arrivalSec, serviceStartSec: stop.serviceStartSec,
          departureSec: stop.departureSec, twStartSec: task.tw_early, twEndSec: task.tw_late, pallets: task.demand[1]!,
          weightKg: task.demand[0]!, serviceMin: Math.round(task.service_seconds/60), waitSec: stop.waitSec,
          travelToSec: input.request.travel.durations[previous*input.request.travel.location_count+task.location_id]!,
          lateBySec: stop.lateSec, requiresTailLift: access.requiresTailLift, maxTonnage: access.maxTonnage };
      }) }));
    return { id: v.vehicleId, ref: source.ref, vehicleClass: info.vehicleClass, isSubcontractor: info.isSubcontractor,
      tonnage: info.grossTonnage, hasTailLift: info.hasTailLift,
      color: parent.vehicles.find(old => old.id === v.vehicleId)?.color ?? '#2d7b55', capacityKg: source.capacity[0]!,
      capacityPallets: source.capacity[1]!, tripCount: trips.length, finishTimeSec: trips.at(-1)!.endSec,
      peakKg: Math.max(...trips.map(t => t.loadKg)), peakPallets: Math.max(...trips.map(t => t.loadPallets)), distanceKm: v.distanceKm, trips };
  });
  const plan: Plan = { ...parent, id, scenarioId: scenario.id, scenarioRevision: scenario.revision, createdAt, source: 'live',
    manual: { version: 1, parentPlanId: parent.id, layout: structuredClone(input.layout), evaluation: structuredClone(evaluation) },
    provenance: { ...parent.provenance, datasetSha256: input.datasetSha256,tariffSha256:input.tariffSha256,
      inputSha256: createHash('sha256').update(JSON.stringify({ dataset: input.datasetSha256, layout: input.layout, tariff: input.tariffSha256,
        vehicles:input.request.vehicles,fleet:[...input.fleet],requirements:[...input.requirements],restrictions:input.request.requests })).digest('hex'),
      termination: 'MANUAL', solverConfig: { evaluator: 'manual-v1' }, validation: {
        valid: evaluation.validation.valid, violations: evaluation.validation.violations.map(violation => ({ ...violation,
          vehicle_id: violation.vehicleId, ...(violation.requestId === undefined ? {} : {
            request_id: violation.requestId, orderNo: taskFor(violation.requestId).ref }) })) } },
    stats: { totalOrders: evaluation.stats.totalOrders, servedOrders: evaluation.stats.servedOrders,
      deliveryStops: evaluation.stats.servedOrders, vehiclesUsed: evaluation.stats.vehiclesUsed, trips: evaluation.stats.trips,
      totalDistanceKm: evaluation.stats.totalDistanceKm, solveElapsedSeconds: null }, vehicles,
    unassigned: input.layout.unassigned.map(requestId => { const row=rowFor(requestId), task=taskFor(requestId), loc=input.request.locations[task.location_id]!;
      return { requestId, orderId: row.id, orderNo: task.ref, customer: row.customer, city: row.city, lon: loc.x, lat: loc.y,
        reason: input.layout.decisions[String(requestId)]?.kind === 'unassigned' ? 'Manually unassigned' : null,
        reasonCode: input.layout.decisions[String(requestId)]?.kind === 'unassigned' ? 'MANUAL_UNASSIGNED' as const : null }; }),
    cost: { ...evaluation.cost, perVehicle: vehicles.map(vehicle => {
      const cost = vehicleCostFor(input.tariff, { ...vehicle,distanceKm:metersToKm(vehicle.distanceKm*1000),
        trips: vehicle.trips.map(trip => ({ distanceKm:metersToKm(trip.distanceKm*1000), drops: trip.stops.length })) });
      return { vehicleId: vehicle.id, ref: vehicle.ref, vehicleClass: vehicle.vehicleClass, distanceKm: vehicle.distanceKm,
        fixedCost: cost.fixed, variableCost: cost.variable, totalCost: cost.total };
    }) } };
  delete plan.assignments;
  return plan;
}
