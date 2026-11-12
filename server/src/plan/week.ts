import type { Plan } from '../types.js';

/* Cross-day (week) roll-up over each day's baseline plan: combined totals, a
 * per-day breakdown, and per-vehicle two-day utilization (vehicles matched by
 * ref, since each day is a separate VRP with its own vehicle set). */

export interface WeekDayStat {
  dayId: string;
  isoDate: string;
  label: string;
  servedOrders: number;
  totalOrders: number;
  vehiclesUsed: number;
  trips: number;
  totalDistanceKm: number;
  costTotal: number | null;
}

export interface WeekVehicleDay { trips: number; km: number; cost: number | null; finishSec: number }
export interface WeekVehicleRow {
  ref: string;
  vehicleClass: string | null;
  isSubcontractor: boolean;
  perDay: Record<string, WeekVehicleDay | null>;
  totalTrips: number;
  totalKm: number;
  totalCost: number | null;
  daysWorked: number;
}

export interface WeekSummary {
  currency: string;
  days: WeekDayStat[];
  totals: {
    servedOrders: number; totalOrders: number; vehiclesUsed: number;
    trips: number; totalDistanceKm: number; costTotal: number | null;
  };
  vehicles: WeekVehicleRow[];
}

export interface WeekDayInput { dayId: string; isoDate: string; label: string; plan: Plan }

export function weekSummary(days: WeekDayInput[]): WeekSummary {
  const currency = days.find((d) => d.plan.cost)?.plan.cost?.currency ?? 'HUF';

  const dayStats: WeekDayStat[] = days.map((d) => ({
    dayId: d.dayId, isoDate: d.isoDate, label: d.label,
    servedOrders: d.plan.stats.servedOrders, totalOrders: d.plan.stats.totalOrders,
    vehiclesUsed: d.plan.stats.vehiclesUsed, trips: d.plan.stats.trips,
    totalDistanceKm: d.plan.stats.totalDistanceKm, costTotal: d.plan.cost?.currency===currency ? d.plan.cost.total : null,
  }));

  // Per-vehicle rows keyed by ref (stable across days).
  const rows = new Map<string, WeekVehicleRow>();
  const distinctRefs = new Set<string>();
  for (const d of days) {
    for (const v of d.plan.vehicles) {
      distinctRefs.add(v.ref);
      let row = rows.get(v.ref);
      if (!row) {
        row = { ref: v.ref, vehicleClass: v.vehicleClass, isSubcontractor: v.isSubcontractor, perDay: {}, totalTrips: 0, totalKm: 0, totalCost: null, daysWorked: 0 };
        for (const dd of days) row.perDay[dd.dayId] = null;
        rows.set(v.ref, row);
      }
      const cost = d.plan.cost?.currency===currency ? d.plan.cost.perVehicle.find((c) => c.vehicleId === v.id)?.totalCost ?? null : null;
      row.perDay[d.dayId] = { trips: v.tripCount, km: v.distanceKm, cost, finishSec: v.finishTimeSec };
      row.totalTrips += v.tripCount;
      row.totalKm += v.distanceKm;
      if (cost != null) row.totalCost = (row.totalCost ?? 0) + cost;
      row.daysWorked += 1;
    }
  }

  // A partial priced subset is not the cost of the complete displayed work.
  for(const row of rows.values())if(Object.values(row.perDay).some(day=>day&&day.cost===null))row.totalCost=null;
  const vehicles = [...rows.values()].sort((a, b) => b.totalKm - a.totalKm);
  const sum = (f: (s: WeekDayStat) => number) => dayStats.reduce((n, s) => n + f(s), 0);
  const allCost = dayStats.length>0&&dayStats.every((s) => s.costTotal != null&&Number.isFinite(s.costTotal));

  return {
    currency,
    days: dayStats,
    totals: {
      servedOrders: sum((s) => s.servedOrders),
      totalOrders: sum((s) => s.totalOrders),
      vehiclesUsed: distinctRefs.size,
      trips: sum((s) => s.trips),
      totalDistanceKm: Math.round(sum((s) => s.totalDistanceKm) * 10) / 10,
      costTotal: allCost ? sum((s) => s.costTotal ?? 0) : null,
    },
    vehicles,
  };
}
