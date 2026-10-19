import type { OrderInfo, VehicleInfo } from '../data/dataset.js';
import type { Plan, SurgeRequest, SurgeRequestVehicle } from '../types.js';

/** Upgrade old advisory-only validation on read without rewriting stored plans. */
export function withHardAccessValidation(plan: Plan): Plan {
  const validation = plan.provenance?.validation;
  if (!validation?.violations.some(v => (v as { type?: string }).type === 'VEHICLE_SIZE')) return plan;
  return { ...plan, provenance: { ...plan.provenance, validation: { ...validation, valid: false,
    violations: validation.violations.map(v => (v as {type?: string}).type === 'VEHICLE_SIZE'
      ? { ...(v as Record<string, unknown>), soft: false } : v) } } };
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
export function applyAccessLimits(request: SurgeRequest, orders: Map<string, OrderInfo>, vehicles: Map<string, VehicleInfo>): void {
  const taskRefs = new Map(request.tasks.map(t => [t.id, String(t.ref)]));
  for (const order of request.requests) {
    const limit = orders.get(taskRefs.get(order.delivery_task_id) ?? '')?.maxTonnage;
    if (limit == null) continue;
    if (!Number.isFinite(limit) || limit <= 0) throw new Error('invalid destination gross-weight access limit');
    const forbidden = new Set(order.forbidden_vehicles ?? []);
    for (const vehicle of request.vehicles) {
      const tonnes = grossTonnage(vehicle, vehicles);
      if (tonnes === null || tonnes > limit) forbidden.add(vehicle.id);
    }
    if (forbidden.size) order.forbidden_vehicles = [...forbidden];
  }
}
