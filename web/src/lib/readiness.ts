import type { Plan, Scenario } from '../types';

export type CheckState = 'passed' | 'failed' | 'unknown' | 'notApplicable';
export interface ReadinessCheck { key: 'gvw' | 'tailLift' | 'capacity' | 'timeWindows' | 'lockedRoutes'; state: CheckState; failures: number; checked: number }
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** Read-only review of the immutable displayed snapshot, never a solver or
 * dispatch authorization. Missing evidence must not be interpreted as a pass.
 * References/order numbers can repeat; authoritative task counts stay intact. */
export function reviewReadiness(plan: Plan, scenario: Scenario, pending = false) {
  const validation = plan.provenance?.validation;
  const fresh = !pending && plan.scenarioId === scenario.id && plan.scenarioRevision === scenario.revision;
  const checks: ReadinessCheck[] = [];
  for (const [key, type] of [['gvw', 'VEHICLE_SIZE'], ['tailLift', 'TAIL_LIFT'], ['capacity', 'CAPACITY'], ['timeWindows', 'HARD_TW']] as const) {
    let failures = 0, checked = 0, unknown = !validation || !Array.isArray(validation.violations);
    for (const vehicle of plan.vehicles) for (const trip of vehicle.trips) {
      if (key === 'capacity') {
        checked++;
        if (![trip.loadKg, trip.loadPallets, vehicle.capacityKg, vehicle.capacityPallets].every(finite)) unknown = true;
        else if (trip.loadKg > vehicle.capacityKg + 1 || trip.loadPallets > vehicle.capacityPallets + 1e-6) failures++;
      }
      for (const stop of trip.stops) {
        if (key === 'gvw') {
          if (stop.maxTonnage === undefined) unknown = true;
          else if (stop.maxTonnage !== null) {
            checked++;
            if (!finite(stop.maxTonnage) || !finite(vehicle.tonnage)) unknown = true;
            else if (vehicle.tonnage > stop.maxTonnage) failures++;
          }
        }
        if (key === 'tailLift') {
          if (typeof stop.requiresTailLift !== 'boolean') unknown = true;
          else if (stop.requiresTailLift) {
            checked++;
            if (typeof vehicle.hasTailLift !== 'boolean') unknown = true;
            else if (!vehicle.hasTailLift) failures++;
          }
        }
        if (key === 'timeWindows') {
          checked++;
          if (![stop.arrivalSec, stop.serviceStartSec, stop.twStartSec, stop.twEndSec].every(finite)) unknown = true;
          // Arrival before opening is allowed: service waits until opening.
          else if (stop.serviceStartSec < stop.twStartSec - 1 || (stop.twEndSec > 0 && Math.max(stop.arrivalSec, stop.serviceStartSec) > stop.twEndSec + 1)) failures++;
        }
      }
    }
    // Preserve authoritative violations even if the mapped snapshot appears OK.
    failures = Math.max(failures, validation?.violations?.filter(v => v.type === type).length ?? 0);
    checks.push({ key, failures, checked, state: failures ? 'failed' : unknown ? 'unknown' : checked ? 'passed' : 'notApplicable' });
  }
  const locks = scenario.sequences.filter(s => s.locked);
  let lockFailures = 0;
  for (const lock of locks) {
    const actual = plan.vehicles.find(v => v.id === lock.vehicleId)?.trips.flatMap(trip => trip.stops.map(stop => stop.orderNo)) ?? [];
    if (actual.length !== lock.orderNos.length || actual.some((order, i) => order !== lock.orderNos[i])) lockFailures++;
  }
  checks.push({ key: 'lockedRoutes', failures: fresh ? lockFailures : 0, checked: locks.length,
    state: !locks.length ? 'notApplicable' : !fresh ? 'unknown' : lockFailures ? 'failed' : 'passed' });
  const s = plan.stats;
  const stops = plan.vehicles.flatMap(v => v.trips.flatMap(t => t.stops));
  const coverageConsistent = [s.servedOrders, s.totalOrders].every(n => Number.isInteger(n) && n >= 0)
    && s.servedOrders + plan.unassigned.length === s.totalOrders
    && s.deliveryStops === stops.length && (s.servedOrders === 0 || stops.length > 0);
  const hard = validation?.violations?.filter(v => !v.soft || ['VEHICLE_SIZE', 'TAIL_LIFT', 'HARD_TW', 'CAPACITY'].includes(v.type)) ?? [];
  const exceptions = plan.provenance?.planningPolicy?.exceptions ?? [];
  const blocked = !fresh || !coverageConsistent || plan.unassigned.length > 0 || hard.length > 0 || checks.some(c => c.state === 'failed');
  const uncertain = s.totalOrders === 0 || validation?.valid !== true || checks.some(c => c.state === 'unknown') || (validation?.violations?.length ?? 0) > 0;
  return { fresh, coverageConsistent, checks, exceptions, hardViolations: hard.length,
    status: blocked ? 'blocked' as const : uncertain || exceptions.length ? 'review' as const : 'passed' as const };
}

export function reviewComparison(base: Plan, revised: Plan) {
  const scope = (p: Plan) => new Set([...p.vehicles.flatMap(v => v.trips.flatMap(t => t.stops.map(s => s.orderNo))), ...p.unassigned.map(o => o.orderNo)]);
  const baseScope = scope(base), revisedScope = scope(revised);
  const sameScope = base.day === revised.day && base.stats.totalOrders === revised.stats.totalOrders
    && baseScope.size > 0 && baseScope.size === revisedScope.size && [...baseScope].every(order => revisedScope.has(order))
    && !!base.provenance?.inputSha256 && !!revised.provenance?.inputSha256;
  const comparableCost = sameScope && base.cost != null && revised.cost != null
    && base.cost.source === revised.cost.source && base.cost.currency === revised.cost.currency
    && finite(base.cost.total) && finite(revised.cost.total);
  // Equal served counts can hide dropped orders replaced by other orders.
  const served = (p: Plan) => new Set(p.vehicles.flatMap(v => v.trips.flatMap(t => t.stops.map(s => s.orderNo))));
  const before = served(base), after = served(revised);
  const lostService = revised.stats.servedOrders < base.stats.servedOrders || [...before].some(order => !after.has(order));
  return { sameScope, comparableCost, lostService };
}
