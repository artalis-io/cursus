import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';

/*
 * Plan cost estimation under a carrier tariff.
 *
 * Real carrier rate cards are confidential and live outside the repo (per
 * provider, zone-based). If a resolved tariff is present at
 * `${DATASET_ROOT}/rates/tariff.json` we use it (source 'external'); otherwise
 * we fall back to an illustrative in-repo demo tariff (source 'demo') so the
 * economics view is always populated without committing anything confidential.
 *
 * The model is deliberately simple and transparent: each used vehicle incurs a
 * fixed standing cost plus a per-km rate (both optionally overridable per
 * vehicle class), with a multiplier for subcontracted vehicles.
 */

export interface Tariff {
  currency: string;
  source: 'demo' | 'external';
  /* 'per_vehicle': fixed per used vehicle + per-km (the demo model).
   * 'per_trip': base per trip + per round-trip km + per extra drop (the real
   * carrier rate card, which prices each truck trip to a destination zone). */
  model: 'per_vehicle' | 'per_trip';
  // per_vehicle model
  perKmDefault: number;
  fixedPerVehicle: number;
  perKmByClass: Record<string, number>;   // keyed by UPPERCASED class token
  fixedByClass: Record<string, number>;
  // per_trip model (round-trip km basis)
  perTripBase: number;
  perKm: number;
  perDrop: number;
  includedDrops: number;
  // multipliers
  subcontractorMultiplier: number;
  ownFleetMultiplier: number;
}

/* Illustrative tariff (Hungarian forint). NOT a real rate card - replace by
 * dropping a rates/tariff.json into the dataset dir. Values are round numbers
 * chosen to be plausible for regional truck haulage, not sourced from any
 * carrier. */
const DEMO_TARIFF: Tariff = {
  currency: 'HUF',
  source: 'demo',
  model: 'per_vehicle',
  perKmDefault: 260,
  fixedPerVehicle: 38000,
  perKmByClass: { SOLO: 210, RIGID: 230, SEMI: 300, TRAILER: 300, PONYVA: 260 },
  fixedByClass: { SOLO: 28000, SEMI: 52000, TRAILER: 52000 },
  perTripBase: 49000,
  perKm: 337,
  perDrop: 7200,
  includedDrops: 2,
  subcontractorMultiplier: 1.0,
  ownFleetMultiplier: 1.0,
};

let cached: Tariff | null = null;

/** Load the tariff once: external rate card if resolved, else the demo tariff. */
export function loadTariff(): Tariff {
  if (cached) return cached;
  const path = resolve(config.datasetRoot, 'rates/tariff.json');
  if (existsSync(path)) {
    try {
      const ext = JSON.parse(readFileSync(path, 'utf8')) as Partial<Tariff>;
      cached = {
        currency: ext.currency ?? 'HUF',
        source: 'external',
        model: ext.model === 'per_trip' ? 'per_trip' : 'per_vehicle',
        perKmDefault: ext.perKmDefault ?? DEMO_TARIFF.perKmDefault,
        fixedPerVehicle: ext.fixedPerVehicle ?? DEMO_TARIFF.fixedPerVehicle,
        perKmByClass: upperKeys(ext.perKmByClass ?? {}),
        fixedByClass: upperKeys(ext.fixedByClass ?? {}),
        perTripBase: ext.perTripBase ?? DEMO_TARIFF.perTripBase,
        perKm: ext.perKm ?? DEMO_TARIFF.perKm,
        perDrop: ext.perDrop ?? DEMO_TARIFF.perDrop,
        includedDrops: ext.includedDrops ?? DEMO_TARIFF.includedDrops,
        subcontractorMultiplier: ext.subcontractorMultiplier ?? 1,
        ownFleetMultiplier: ext.ownFleetMultiplier ?? 1,
      };
      return cached;
    } catch { /* fall through to demo */ }
  }
  cached = DEMO_TARIFF;
  return cached;
}

function upperKeys(o: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(o)) out[k.toUpperCase()] = v;
  return out;
}

function rateForClass(table: Record<string, number>, vehicleClass: string | null, fallback: number): number {
  if (!vehicleClass) return fallback;
  const key = vehicleClass.toUpperCase();
  if (table[key] != null) return table[key];
  for (const [k, v] of Object.entries(table)) if (key.includes(k) || k.includes(key)) return v;
  return fallback;
}

export interface VehicleCost { fixed: number; variable: number; total: number }
export interface TripShape { distanceKm: number; drops: number } // drops = delivery stops on the trip

/** Cost of one used vehicle given its class, subcontractor flag, and route km
 * (per_vehicle model only). */
export function vehicleCost(
  tariff: Tariff, vehicleClass: string | null, isSubcontractor: boolean, distanceKm: number,
): VehicleCost {
  const perKm = rateForClass(tariff.perKmByClass, vehicleClass, tariff.perKmDefault);
  const fixedBase = rateForClass(tariff.fixedByClass, vehicleClass, tariff.fixedPerVehicle);
  const mult = isSubcontractor ? tariff.subcontractorMultiplier : 1;
  const fixed = Math.round(fixedBase * mult);
  const variable = Math.round(perKm * distanceKm * mult);
  return { fixed, variable, total: fixed + variable };
}

/** Cost of one vehicle under whichever model the tariff declares. The per_trip
 * model charges each trip a base + per round-trip km + a surcharge per drop
 * beyond those included, with a multiplier for own fleet vs subcontractor. */
export function vehicleCostFor(
  tariff: Tariff,
  v: { vehicleClass: string | null; isSubcontractor: boolean; distanceKm: number; trips: TripShape[] },
): VehicleCost {
  if (tariff.model !== 'per_trip') return vehicleCost(tariff, v.vehicleClass, v.isSubcontractor, v.distanceKm);
  const mult = v.isSubcontractor ? tariff.subcontractorMultiplier : tariff.ownFleetMultiplier;
  let fixed = 0, variable = 0;
  for (const t of v.trips) {
    fixed += tariff.perTripBase;
    variable += tariff.perKm * t.distanceKm + tariff.perDrop * Math.max(0, t.drops - tariff.includedDrops);
  }
  fixed = Math.round(fixed * mult);
  variable = Math.round(variable * mult);
  return { fixed, variable, total: fixed + variable };
}

/** Estimated cost of a single trip (for the trip inspector). Under per_trip this
 * is base + per-km + per-drop; under per_vehicle it is the per-km variable plus
 * an even share of the vehicle's fixed cost across its trips. */
export function tripCost(
  tariff: Tariff,
  v: { vehicleClass: string | null; isSubcontractor: boolean },
  trip: { distanceKm: number; drops: number },
  tripsOnVehicle: number,
): number {
  if (tariff.model === 'per_trip') {
    const mult = v.isSubcontractor ? tariff.subcontractorMultiplier : tariff.ownFleetMultiplier;
    const extra = Math.max(0, trip.drops - tariff.includedDrops);
    return Math.round((tariff.perTripBase + tariff.perKm * trip.distanceKm + tariff.perDrop * extra) * mult);
  }
  const perKm = rateForClass(tariff.perKmByClass, v.vehicleClass, tariff.perKmDefault);
  const fixedBase = rateForClass(tariff.fixedByClass, v.vehicleClass, tariff.fixedPerVehicle);
  const mult = v.isSubcontractor ? tariff.subcontractorMultiplier : 1;
  return Math.round((perKm * trip.distanceKm + fixedBase / Math.max(1, tripsOnVehicle)) * mult);
}
