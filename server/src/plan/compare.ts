import type { Plan } from '../types.js';
import { comparisonEvidence } from './identity.js';

/* Compare two plans using dataset-scoped delivery identities. Historical
 * display references are used only when unique; ambiguity stays explicit.
 * Used by GET /api/compare so the diff is computed once, authoritatively. */

export interface OrderPlacement { orderNo: string; requestId?: number; vehicleRef: string; customer: string | null; city: string | null }

function placements(plan: Plan, key: (s: {orderNo:string;requestId?:number})=>string): Map<string, OrderPlacement> {
  const m = new Map<string, OrderPlacement>();
  for (const v of plan.vehicles)
    for (const t of v.trips)
      for (const s of t.stops)
        m.set(key(s), { orderNo:s.orderNo,...(s.requestId===undefined?{}:{requestId:s.requestId}),vehicleRef: v.ref, customer: s.customer, city: s.city });
  return m;
}

export interface Comparison {
  identityAmbiguous: boolean;
  improvementEligible: boolean;
  sameScope: boolean;
  samePolicy: boolean;
  base: { planId: string; stats: Plan['stats']; cost: Plan['cost'] };
  revised: { planId: string; stats: Plan['stats']; cost: Plan['cost'] };
  deltas: { servedOrders: number; vehiclesUsed: number; trips: number; totalDistanceKm: number; unassigned: number; costTotal: number | null };
  costComparison: 'comparable' | 'different_tariff' | 'unavailable';
  newlyUnassigned: { requestId?:number;orderNo: string; customer: string | null; city: string | null; fromVehicleRef: string }[];
  nowServed: { requestId?:number;orderNo: string; customer: string | null; city: string | null; toVehicleRef: string }[];
  movedOrders: { requestId?:number;orderNo: string; customer: string | null; fromVehicleRef: string; toVehicleRef: string }[];
  removedVehicles: string[];
  addedVehicles: string[];
}

export function comparePlans(base: Plan, revised: Plan): Comparison {
  const evidence = comparisonEvidence(base,revised);
  const pb = evidence.comparablePlacements ? placements(base,evidence.key) : new Map<string,OrderPlacement>();
  const pr = evidence.comparablePlacements ? placements(revised,evidence.key) : new Map<string,OrderPlacement>();

  const newlyUnassigned: Comparison['newlyUnassigned'] = [];
  const movedOrders: Comparison['movedOrders'] = [];
  for (const [orderNo, b] of pb) {
    const r = pr.get(orderNo);
    if (!r) newlyUnassigned.push({ orderNo:b.orderNo,...(b.requestId===undefined?{}:{requestId:b.requestId}),customer: b.customer, city: b.city, fromVehicleRef: b.vehicleRef });
    else if (r.vehicleRef !== b.vehicleRef) movedOrders.push({ orderNo:b.orderNo,...(b.requestId===undefined?{}:{requestId:b.requestId}),customer: b.customer, fromVehicleRef: b.vehicleRef, toVehicleRef: r.vehicleRef });
  }
  const nowServed: Comparison['nowServed'] = [];
  for (const [orderNo, r] of pr) if (!pb.has(orderNo)) nowServed.push({ orderNo:r.orderNo,...(r.requestId===undefined?{}:{requestId:r.requestId}),customer: r.customer, city: r.city, toVehicleRef: r.vehicleRef });

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
      || base.provenance?.tariffSha256 && revised.provenance?.tariffSha256 && base.provenance.tariffSha256 !== revised.provenance.tariffSha256 ? 'different_tariff'
      : 'comparable';
  const costTotal = costComparison === 'comparable' ? revised.cost!.total - base.cost!.total : null;

  return {
    identityAmbiguous:!evidence.comparablePlacements,improvementEligible:evidence.improvementEligible,sameScope:evidence.sameScope,samePolicy:evidence.samePolicy,
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
