import type { Plan } from '../types.js';

/* Compare two plans (baseline vs revised). Orders are keyed by order_no; this
 * matches the display identity (the single duplicate order_no is same-customer).
 * Used by GET /api/compare so the diff is computed once, authoritatively. */

export interface OrderPlacement { vehicleRef: string; customer: string | null; city: string | null }

function placements(plan: Plan): Map<string, OrderPlacement> {
  const m = new Map<string, OrderPlacement>();
  for (const v of plan.vehicles)
    for (const t of v.trips)
      for (const s of t.stops)
        if (!m.has(s.orderNo)) m.set(s.orderNo, { vehicleRef: v.ref, customer: s.customer, city: s.city });
  return m;
}

export interface Comparison {
  base: { planId: string; stats: Plan['stats']; cost: Plan['cost'] };
  revised: { planId: string; stats: Plan['stats']; cost: Plan['cost'] };
  deltas: { servedOrders: number; vehiclesUsed: number; trips: number; totalDistanceKm: number; unassigned: number; costTotal: number | null };
  costComparison: 'comparable' | 'different_tariff' | 'unavailable';
  newlyUnassigned: { orderNo: string; customer: string | null; city: string | null; fromVehicleRef: string }[];
  nowServed: { orderNo: string; customer: string | null; city: string | null; toVehicleRef: string }[];
  movedOrders: { orderNo: string; customer: string | null; fromVehicleRef: string; toVehicleRef: string }[];
  removedVehicles: string[];
  addedVehicles: string[];
}

export function comparePlans(base: Plan, revised: Plan): Comparison {
  const pb = placements(base);
  const pr = placements(revised);

  const newlyUnassigned: Comparison['newlyUnassigned'] = [];
  const movedOrders: Comparison['movedOrders'] = [];
  for (const [orderNo, b] of pb) {
    const r = pr.get(orderNo);
    if (!r) newlyUnassigned.push({ orderNo, customer: b.customer, city: b.city, fromVehicleRef: b.vehicleRef });
    else if (r.vehicleRef !== b.vehicleRef) movedOrders.push({ orderNo, customer: b.customer, fromVehicleRef: b.vehicleRef, toVehicleRef: r.vehicleRef });
  }
  const nowServed: Comparison['nowServed'] = [];
  for (const [orderNo, r] of pr) if (!pb.has(orderNo)) nowServed.push({ orderNo, customer: r.customer, city: r.city, toVehicleRef: r.vehicleRef });

  const baseRefs = new Set([...pb.values()].map((p) => p.vehicleRef));
  const revRefs = new Set([...pr.values()].map((p) => p.vehicleRef));
  const removedVehicles = [...baseRefs].filter((r) => !revRefs.has(r));
  const addedVehicles = [...revRefs].filter((r) => !baseRefs.has(r));

  // A numerical delta is meaningful only when both plans were priced in the
  // same currency using the same tariff class. In particular, never present a
  // fallback demo estimate as a saving against a confidential external rate
  // card: those totals use different models and rates.
  const costComparison = !base.cost || !revised.cost
    ? 'unavailable'
    : base.cost.currency !== revised.cost.currency || base.cost.source !== revised.cost.source
      ? 'different_tariff'
      : 'comparable';
  const costTotal = costComparison === 'comparable' ? revised.cost!.total - base.cost!.total : null;

  return {
    base: { planId: base.id, stats: base.stats, cost: base.cost },
    revised: { planId: revised.id, stats: revised.stats, cost: revised.cost },
    costComparison,
    deltas: {
      servedOrders: revised.stats.servedOrders - base.stats.servedOrders,
      vehiclesUsed: revised.stats.vehiclesUsed - base.stats.vehiclesUsed,
      trips: revised.stats.trips - base.stats.trips,
      totalDistanceKm: Math.round((revised.stats.totalDistanceKm - base.stats.totalDistanceKm) * 10) / 10,
      unassigned: revised.unassigned.length - base.unassigned.length,
      costTotal,
    },
    newlyUnassigned, nowServed, movedOrders, removedVehicles, addedVehicles,
  };
}
