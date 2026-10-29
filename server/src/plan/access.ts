import type { OrderInfo, VehicleInfo } from '../data/dataset.js';
import type { Plan, SurgeRequest, SurgeRequestVehicle } from '../types.js';

/** Upgrade old advisory-only validation on read without rewriting stored plans. */
export function withHardAccessValidation(plan: Plan): Plan {
  const validation = plan.provenance?.validation;
  if (!validation?.violations.some(v => ['VEHICLE_SIZE', 'TAIL_LIFT'].includes((v as { type?: string }).type ?? ''))) return plan;
  return { ...plan, provenance: { ...plan.provenance, validation: { ...validation, valid: false,
    violations: validation.violations.map(v => ['VEHICLE_SIZE', 'TAIL_LIFT'].includes((v as {type?: string}).type ?? '')
      ? { ...(v as Record<string, unknown>), soft: false } : v) } } };
}

/** Explicit admitted capability wins; unknown equipment fails closed. */
export function hasTailLift(vehicle: SurgeRequestVehicle, info: Map<string, VehicleInfo>): boolean {
  if (vehicle.has_tail_lift !== undefined) return vehicle.has_tail_lift === true;
  return info.get(vehicle.ref.replace(/[^a-z0-9]/gi, '').toUpperCase())?.hasTailLift === true;
}

/** GVW is not payload capacity. Unknown GVW cannot establish access eligibility.
 * Use exact normalized fleet identifiers, never a substring/partial-plate match. */
export function grossTonnage(vehicle: SurgeRequestVehicle, info: Map<string, VehicleInfo>): number | null {
  const kg = vehicle.gross_weight_kg;
  if (kg !== undefined) return Number.isFinite(kg) && kg > 0 ? kg / 1000 : null;
  const key = vehicle.ref.replace(/[^a-z0-9]/gi, '').toUpperCase();
  const tonnes = info.get(key)?.tonnage;
  return typeof tonnes === 'number' && Number.isFinite(tonnes) && tonnes > 0 ? tonnes : null;
}

/** Run AFTER pins, route locks and vehicle edits. Add immutable safety exclusions
 * rather than an empty allowlist (which Surge interprets as unrestricted).
 * A conflicting pin must remain infeasible, not silently become unrestricted. */
export function applyAccessLimits(request: SurgeRequest, orders: Map<string, OrderInfo>, vehicles: Map<string, VehicleInfo>, deliveries?:Map<number,OrderInfo>): void {
  const taskRefs = new Map(request.tasks.map(t => [t.id, String(t.ref)]));
  for (const order of request.requests) {
    const requirements = deliveries?.get(order.id) ?? orders.get(taskRefs.get(order.delivery_task_id) ?? '');
    const limit = requirements?.maxTonnage;
    if (limit == null && !requirements?.requiresTailLift) continue;
    if (limit != null && (!Number.isFinite(limit) || limit <= 0)) throw new Error('invalid destination gross-weight access limit');
    const forbidden = new Set(order.forbidden_vehicles ?? []);
    for (const vehicle of request.vehicles) {
      const tonnes = grossTonnage(vehicle, vehicles);
      if ((limit != null && (tonnes === null || tonnes > limit)) ||
          (requirements?.requiresTailLift && !hasTailLift(vehicle, vehicles))) forbidden.add(vehicle.id);
    }
    if (forbidden.size) order.forbidden_vehicles = [...forbidden];
  }
}
