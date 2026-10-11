/* Canonical fields the onboarding mapping UI maps raw columns to. `aliases` are
 * lowercase header substrings used to auto-suggest a mapping. Types mirror the
 * nx_schema column types (string | double | int | bool). */

export type FieldType = 'string' | 'double' | 'int' | 'bool';
export interface CanonicalField {
  field: string;
  type: FieldType;
  required: boolean;
  label: string;
  hint?: string;
  aliases: string[];
}
export type Entity = 'orders' | 'vehicles' | 'routes';

const ORDERS: CanonicalField[] = [
  { field: 'order_no', type: 'string', required: true, label: 'Order no', aliases: ['megrendelés száma', 'megrendelés', 'order no', 'order', 'rendelés'] },
  { field: 'customer', type: 'string', required: true, label: 'Customer', aliases: ['megnevezés', 'customer', 'ügyfél', 'partner', 'név'] },
  { field: 'city', type: 'string', required: true, label: 'City', aliases: ['település', 'city', 'város'] },
  { field: 'zip', type: 'string', required: false, label: 'Postcode', aliases: ['irányítószám', 'irsz', 'zip', 'postal'] },
  { field: 'street', type: 'string', required: false, label: 'Street', aliases: ['utca', 'házszám', 'street', 'cím'] },
  { field: 'delivery_date', type: 'string', required: false, label: 'Delivery date', hint: 'Splits a dataset into days', aliases: ['dátum', 'date', 'nap'] },
  { field: 'weight_kg', type: 'double', required: false, label: 'Weight (kg)', aliases: ['súly', 'tömeg', 'weight', 'kg'] },
  { field: 'pallets', type: 'double', required: false, label: 'Pallets', hint: 'Fractional allowed', aliases: ['raklap', 'pallet', 'plt'] },
  { field: 'service_min', type: 'int', required: false, label: 'Service (min)', aliases: ['kirakás', 'szolgáltatás', 'service', 'perc'] },
  { field: 'time_window_raw', type: 'string', required: false, label: 'Time window', hint: 'e.g. 08:00 - 12:00', aliases: ['időablak', 'időkapu', 'window', 'idő'] },
  { field: 'special_req', type: 'string', required: false, label: 'Special req.', aliases: ['megjegyzés', 'követelmény', 'igény', 'special', 'note'] },
  { field: 'fuvar_no', type: 'string', required: false, label: 'Fuvar no', aliases: ['fuvarszám', 'fuvar'] },
  { field: 'ship_addr_id', type: 'string', required: false, label: 'Address id', aliases: ['cím azonosító', 'addr id'] },
  { field: 'gps_raw', type: 'string', required: false, label: 'GPS', aliases: ['gps', 'koordináta', 'koor'] },
  { field: 'start_depot', type: 'string', required: false, label: 'Depot', aliases: ['depó', 'depot', 'telephely'] },
];

const VEHICLES: CanonicalField[] = [
  { field: 'id', type: 'string', required: true, label: 'Vehicle id', aliases: ['azonosító', 'id', 'rendszám', 'plate'] },
  { field: 'plate', type: 'string', required: false, label: 'Plate', aliases: ['rendszám', 'plate'] },
  { field: 'vehicle_class', type: 'string', required: false, label: 'Class', aliases: ['típus', 'kategória', 'class', 'type'] },
  { field: 'capacity_kg', type: 'double', required: false, label: 'Capacity (kg)', aliases: ['kapacitás', 'teherbírás', 'capacity', 'kg'] },
  { field: 'capacity_pallets', type: 'double', required: false, label: 'Capacity (plt)', aliases: ['raklap', 'pallet', 'plt'] },
  { field: 'gross_weight_kg', type: 'double', required: false, label: 'GVW (kg)', aliases: ['össztömeg', 'gvw', 'gross'] },
  { field: 'special_req', type: 'string', required: false, label: 'Equipment', aliases: ['felszereltség', 'emelőhátfal', 'special', 'equipment'] },
  { field: 'is_subcontractor', type: 'bool', required: false, label: 'Subcontractor', aliases: ['alvállalkozó', 'bérfuvaros', 'subcontractor'] },
  { field: 'operator', type: 'string', required: false, label: 'Operator', aliases: ['üzemeltető', 'operator'] },
  { field: 'depot', type: 'string', required: false, label: 'Depot', aliases: ['depó', 'depot', 'telephely'] },
];

const ROUTES: CanonicalField[] = [
  { field: 'order_no', type: 'string', required: true, label: 'Order no', aliases: ['megrendelés', 'order'] },
  { field: 'vehicle', type: 'string', required: true, label: 'Vehicle', aliases: ['jármű', 'rendszám', 'vehicle', 'plate'] },
  { field: 'sequence', type: 'int', required: false, label: 'Stop sequence', aliases: ['sorrend', 'sequence', 'stop'] },
  { field: 'date', type: 'string', required: false, label: 'Date', aliases: ['dátum', 'date', 'nap'] },
];

export const CATALOG: Record<Entity, CanonicalField[]> = { orders: ORDERS, vehicles: VEHICLES, routes: ROUTES };

/** Suggest a column index for each canonical field by alias/header match. */
export function suggestMapping(entity: Entity, headers: string[]): Record<string, number> {
  const norm = headers.map((h) => (h ?? '').toLowerCase().trim());
  const out: Record<string, number> = {};
  const used = new Set<number>();
  for (const f of CATALOG[entity]) {
    let best = -1;
    for (const a of f.aliases) {
      const i = norm.findIndex((h, idx) => !used.has(idx) && h.length > 0 && (h === a || h.includes(a) || a.includes(h)));
      if (i >= 0) { best = i; break; }
    }
    if (best >= 0) { out[f.field] = best; used.add(best); }
  }
  return out;
}
