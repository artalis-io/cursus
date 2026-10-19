import type { SurgeRequest, SurgeSolution } from '../types.js';
import type { Scenario } from '../store.js';
import { populationConfig } from '../solver-config.js';

/** Surge's JSON reader assigns IDs by array position, ignoring explicit id
 * fields. Keep application IDs stable while compacting the native boundary. */
export function nativeSolveRequest(request: SurgeRequest, sequences: Scenario['sequences'] = []): { request: SurgeRequest; restore: (solution: SurgeSolution) => SurgeSolution } {
  const vehicles = new Map(request.vehicles.map((v, i) => [v.id, i]));
  const tasks = new Map(request.tasks.map((t, i) => [t.id, i]));
  const requests = new Map(request.requests.map((r, i) => [r.id, i]));
  const native: SurgeRequest = {
    ...request,
    config: populationConfig(request.config),
    vehicles: request.vehicles.map((v, id) => ({ ...v, id })),
    tasks: request.tasks.map((t, id) => ({ ...t, id })),
    requests: request.requests.map((r, id) => ({ ...r, id, delivery_task_id: tasks.get(r.delivery_task_id)!,
      ...(r.allowed_vehicles ? { allowed_vehicles: r.allowed_vehicles.filter(v => vehicles.has(v)).map(v => vehicles.get(v)!) } : {}),
      ...(r.forbidden_vehicles ? { forbidden_vehicles: r.forbidden_vehicles.filter(v => vehicles.has(v)).map(v => vehicles.get(v)!) } : {}),
    })),
    precedences: request.precedences?.filter(p => requests.has(p.before) && requests.has(p.after))
      .map(p => ({ before: requests.get(p.before)!, after: requests.get(p.after)! })),
  };
  const extra = native as SurgeRequest & { initial_routes?: { vehicle_id: number; request_ids: number[] }[]; committed_requests?: number[]; frozen_requests?: number[] };
  // Give the native search the dispatcher's proposed route as a starting
  // point. Precedence/pinning alone can leave construction without a feasible
  // incumbent even when the proposed route is feasible.
  if (sequences.length) {
    const taskRefs = new Map(request.tasks.map(t => [t.id, String(t.ref)]));
    const requestRefs = new Map(request.requests.map(r => [taskRefs.get(r.delivery_task_id), r.id]));
    const seeds = sequences.filter(s => vehicles.has(s.vehicleId)).map(s => ({ vehicle_id: s.vehicleId,
      request_ids: [...new Set(s.orderNos.map(o => requestRefs.get(o)).filter((id): id is number => id !== undefined))] }));
    const seededVehicles = new Set(seeds.map(s => s.vehicle_id));
    const seededRequests = new Set(seeds.flatMap(s => s.request_ids));
    extra.initial_routes = [...(extra.initial_routes ?? []).filter(r => !seededVehicles.has(r.vehicle_id))
      .map(r => ({ ...r, request_ids: r.request_ids.filter(id => !seededRequests.has(id)) })), ...seeds];
  }
  if (extra.initial_routes) extra.initial_routes = extra.initial_routes.filter(r => vehicles.has(r.vehicle_id))
    .map(r => ({ ...r, vehicle_id: vehicles.get(r.vehicle_id)!, request_ids: r.request_ids.filter(id => requests.has(id)).map(id => requests.get(id)!) }));
  for (const key of ['committed_requests', 'frozen_requests'] as const)
    if (extra[key]) extra[key] = extra[key]!.filter(id => requests.has(id)).map(id => requests.get(id)!);
  return { request: native, restore: solution => ({ ...solution,
    unassigned: solution.unassigned.map(id => request.requests[id]!.id),
    routes: solution.routes.map(route => ({ ...route, vehicle_id: request.vehicles[route.vehicle_id]!.id,
      stops: route.stops.map(stop => ({ ...stop, request_id: request.requests[stop.request_id]!.id, task_id: request.tasks[stop.task_id]!.id })) })),
  }) };
}
