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
    config: populationConfig({...request.config,...(request.vehicles.some(v=>v.approved_operating?.maxDurationSec.state==='configured')?{hard_max_duration:true}:{})}),
    vehicles: request.vehicles.map((v, id) => {
      const {approved_operating,operating_limits,approved_capacity,...nativeVehicle}=v;
      void approved_operating;void operating_limits;void approved_capacity;
      return {...nativeVehicle,id};
    }),
    tasks: request.tasks.map((t, id) => {
      // Native add_time_window promotes an existing scalar window. Sending
      // both creates an overlapping envelope; send the intervals alone.
      if(t.time_windows){const {tw_early,tw_late,...rest}=t;void tw_early;void tw_late;return {...rest,id} as typeof t;}
      return {...t,id};
    }),
    requests: request.requests.map((r, id) => ({ ...r, id, delivery_task_id: tasks.get(r.delivery_task_id)!,
      ...(r.allowed_vehicles ? { allowed_vehicles: r.allowed_vehicles.filter(v => vehicles.has(v)).map(v => vehicles.get(v)!) } : {}),
      ...(r.forbidden_vehicles ? { forbidden_vehicles: r.forbidden_vehicles.filter(v => vehicles.has(v)).map(v => vehicles.get(v)!) } : {}),
    })),
    ...(request.loading?{loading:{...request.loading,
      vehicles:request.loading.vehicles.map(v=>({...v,vehicle_id:vehicles.get(v.vehicle_id)!})),
      requests:request.loading.requests.map(r=>({...r,request_id:requests.get(r.request_id)!})),
    }}:{}),
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
    for (const sequence of sequences) if (!sequence.requestIds) for (const ref of sequence.orderNos)
      if (request.requests.filter(r => taskRefs.get(r.delivery_task_id) === ref).length > 1)
        throw new Error('Ambiguous sequence delivery reference');
    const seeds = sequences.filter(s => vehicles.has(s.vehicleId)).map(s => ({ vehicle_id: s.vehicleId,
      request_ids: [...new Set(s.requestIds??s.orderNos.map(o => requestRefs.get(o)).filter((id): id is number => id !== undefined))] }));
    const seededVehicles = new Set(seeds.map(s => s.vehicle_id));
    const seededRequests = new Set(seeds.flatMap(s => s.request_ids));
    extra.initial_routes = [...(extra.initial_routes ?? []).filter(r => !seededVehicles.has(r.vehicle_id))
      .map(r => ({ ...r, request_ids: r.request_ids.filter(id => !seededRequests.has(id)) })), ...seeds];
  }
  if (extra.initial_routes) extra.initial_routes = extra.initial_routes.filter(r => vehicles.has(r.vehicle_id))
    .map(r => ({ ...r, vehicle_id: vehicles.get(r.vehicle_id)!, request_ids: r.request_ids.filter(id => {
      const index = requests.get(id), order = index === undefined ? undefined : request.requests[index];
      return order && !order.forbidden_vehicles?.includes(r.vehicle_id) &&
        (!order.allowed_vehicles?.length || order.allowed_vehicles.includes(r.vehicle_id));
    }).map(id => requests.get(id)!) })).filter(route => route.request_ids.length > 0);
  for (const key of ['committed_requests', 'frozen_requests'] as const)
    if (extra[key]) extra[key] = extra[key]!.filter(id => requests.has(id)).map(id => requests.get(id)!);
  const stable=(index:number,items:{id:number}[])=>{if(!Number.isSafeInteger(index)||!items[index])throw new Error('Physical loading: invalid native loading identity');return items[index]!.id;};
  return { request: native, restore: solution => {
    if(solution.loading&&(!Array.isArray(solution.loading.rounds)||!Array.isArray(solution.loading.unassigned_checks)||solution.loading.rounds.some(r=>!Array.isArray(r.placements))))throw new Error('Physical loading: malformed native certificate; no plan published');
    if(solution.loading?.version===2&&solution.loading.rounds.some(r=>!Array.isArray(r.operations)||!Array.isArray(r.stops)||!Array.isArray(r.axle_states)))throw new Error('Physical loading: malformed native V2 evidence');
    return ({ ...solution,
    ...(solution.loading?{loading:{...solution.loading,
      rounds:solution.loading.rounds.map(round=>({...round,vehicle_id:stable(round.vehicle_id,request.vehicles),
        placements:round.placements.map(p=>({...p,request_id:stable(p.request_id,request.requests)})),
        ...(solution.loading!.version===2?{operations:round.operations?.map(op=>({...op,request_id:stable(op.request_id,request.requests)})),stops:round.stops?.map(stop=>({...stop,task_id:stable(stop.task_id,request.tasks)}))}:{})})),
      unassigned_checks:solution.loading.unassigned_checks.map(d=>({...d,request_id:stable(d.request_id,request.requests)})),
    }}:{}),
    unassigned: solution.unassigned.map(id => request.requests[id]!.id),
    routes: solution.routes.map(route => ({ ...route, vehicle_id: request.vehicles[route.vehicle_id]!.id,
      stops: route.stops.map(stop => ({ ...stop, request_id: request.requests[stop.request_id]!.id, task_id: request.tasks[stop.task_id]!.id })) })),
  }); } };
}
