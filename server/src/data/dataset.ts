import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.js';
import { datasetForDay, allDatasets, isRoutableOrder, type Dataset, type RegDay } from './registry.js';
import type { SurgeRequest, SurgeSolution } from '../types.js';

/* The configured dataset is immutable and lives outside the repo. the backend reads it
 * read-only. Each planning day is a separate VRP; the per-day request file
 * carries ALL in-scope locations + the full travel matrix but we scope the
 * served order set to that day's delivery date (verified exact: 117 tasks on
 * 2026-05-06 == the 117 the saved baseline serves). */

export interface DayDef {
  id: string;        // 'day1'
  date: string;      // canonical delivery_date token, e.g. '5/6/26'
  isoDate: string;   // '2026-05-06'
  label: string;
  requestFile: string;
  solutionFile: string;
}

export const DAYS: DayDef[] = [
  { id: 'day1', date: '5/6/26', isoDate: '2026-05-06', label: 'Wednesday 6 May 2026',
    requestFile: 'results/perday/day1_request.json', solutionFile: 'results/perday/day1_solution.json' },
  { id: 'day2', date: '5/7/26', isoDate: '2026-05-07', label: 'Thursday 7 May 2026',
    requestFile: 'results/perday/day2_request.json', solutionFile: 'results/perday/day2_solution.json' },
];

export interface OrderInfo {
  id: string | null;
  orderNo: string;
  customer: string | null;
  city: string | null;
  street: string | null;
  zip: string | null;
  lat: number | null;
  lon: number | null;
  pallets: number | null;    // fractional, from canonical
  weightKg: number | null;
  twStart: string | null;    // HH:MM
  twEnd: string | null;
  serviceMin: number | null;
  requiresTailLift: boolean;
  maxTonnage: number | null; // max vehicle GVW (t) that can access the address
}

export interface VehicleInfo {
  vehicleClass: string | null;
  plate: string | null;
  isSubcontractor: boolean;
  tonnage: number | null;    // vehicle gross weight (t)
  hasTailLift: boolean;
}

/* Parse a Hungarian special_req free-text field: a tail-lift flag ("emelőhátfal")
 * and/or a max access tonnage ("3,5t" / "7,5t" / "18t"). */
function parseTonnage(specialReq: string | null | undefined): number | null {
  if (!specialReq) return null;
  const m = /(\d+(?:[.,]\d+)?)\s*t/i.exec(specialReq);
  return m ? Number(m[1]!.replace(',', '.')) : null;
}
function hasTailLiftReq(specialReq: string | null | undefined): boolean {
  return typeof specialReq === 'string' && /emel[őo]h[áa]tfal/i.test(specialReq);
}

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(resolve(config.datasetRoot, rel), 'utf8')) as T;
}

type RawRow = Record<string, unknown>;

/* Canonical dataset rows: either a JSON array or an object with a `records`
 * array. One asserted boundary (trusted reconcile-pipeline output) so callers
 * read typed `RawRow`s instead of `any`. */
function records(obj: unknown): RawRow[] {
  const arr = Array.isArray(obj) ? obj : (obj as { records?: unknown } | null)?.records;
  return Array.isArray(arr) ? (arr as RawRow[]) : [];
}

/* Read an optional string field from an untrusted row: pass strings through,
 * coerce finite scalars, and null out anything missing/object-shaped. */
function asStr(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v == null || typeof v === 'object') return null;
  return String(v);
}

/** order_no -> set of canonical delivery_date tokens (for day scoping). */
export function loadOrderDates(): Map<string, Set<string>> {
  const recs = records(readJson<unknown>('input/orders.json'));
  const m = new Map<string, Set<string>>();
  for (const r of recs) {
    const no = String(r.order_no);
    const set = m.get(no) ?? new Set<string>();
    set.add(String(r.delivery_date));
    m.set(no, set);
  }
  return m;
}

/* Stable pseudonym for a customer name when anonymizing (same name -> same label). */
function pseudonym(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `Customer ${(h % 900) + 100}`;
}

/** order_no -> OrderInfo (customer/city/coords/tw/pallets), from geocoded canonical. */
export function loadEnrichment(): Map<string, OrderInfo> {
  const recs = records(readJson<unknown>('input/orders.geocoded.json'));
  const m = new Map<string, OrderInfo>();
  for (const r of recs) {
    const no = String(r.order_no);
    if (m.has(no)) continue; // same-date duplicates are identical enough; keep first
    m.set(no, {
      id: asStr(r.id),
      orderNo: no,
      customer: r.customer ? (config.anonymize ? pseudonym(String(r.customer)) : String(r.customer)) : null,
      city: asStr(r.city),
      street: asStr(r.street),
      zip: r.zip != null ? String(r.zip) : null,
      lat: typeof r.lat === 'number' ? r.lat : null,
      lon: typeof r.lon === 'number' ? r.lon : null,
      pallets: typeof r.pallets === 'number' ? r.pallets : null,
      weightKg: typeof r.weight_kg === 'number' ? r.weight_kg : null,
      twStart: asStr(r.tw_start),
      twEnd: asStr(r.tw_end),
      serviceMin: typeof r.service_min === 'number' ? r.service_min : null,
      requiresTailLift: Boolean(r.requires_tail_lift) || hasTailLiftReq(asStr(r.special_req)),
      maxTonnage: parseTonnage(asStr(r.special_req)),
    });
  }
  return m;
}

const normKey = (s: string): string => s.replace(/[^a-z0-9]/gi, '').toUpperCase();

/** request-vehicle ref -> VehicleInfo (class/plate/subcontractor), best-effort join. */
export function loadVehicleInfo(): Map<string, VehicleInfo> {
  const recs = records(readJson<unknown>('input/vehicles.json'));
  const m = new Map<string, VehicleInfo>();
  for (const r of recs) {
    const info: VehicleInfo = {
      vehicleClass: asStr(r.vehicle_class),
      plate: asStr(r.plate),
      isSubcontractor: Boolean(r.is_subcontractor),
      tonnage: typeof r.gross_weight_kg === 'number' && r.gross_weight_kg > 0 ? r.gross_weight_kg / 1000 : null,
      hasTailLift: Boolean(r.requires_tail_lift) || hasTailLiftReq(asStr(r.special_req)),
    };
    for (const k of [r.id, r.plate, r.ref].filter(Boolean)) m.set(normKey(String(k)), info);
  }
  return m;
}

export function vehicleInfoFor(ref: string, table: Map<string, VehicleInfo>): VehicleInfo | null {
  const n = normKey(ref);
  if (table.has(n)) return table.get(n)!;
  for (const [k, v] of table) if (k.includes(n) || n.includes(k)) return v;
  return null;
}

export interface LoadedDay {
  def: DayDef;
  kind: 'builtin' | 'uploaded';
  request: SurgeRequest;
  solution: SurgeSolution;
  scopeTaskIds: Set<number>;   // tasks whose order falls on this day
  depot: { name: string; lon: number; lat: number };
  enrichment: Map<string, OrderInfo>;   // order_no -> OrderInfo for display
}

let _enrichment: Map<string, OrderInfo> | null = null;
function builtinEnrichment(): Map<string, OrderInfo> { return (_enrichment ??= loadEnrichment()); }

export function loadDay(dayId: string): LoadedDay {
  const def = DAYS.find((d) => d.id === dayId);
  if (def) {
    const request = readJson<SurgeRequest>(def.requestFile);
    const solution = readJson<SurgeSolution>(def.solutionFile);
    const dates = loadOrderDates();
    const scopeTaskIds = new Set<number>();
    for (const t of request.tasks) {
      const ds = dates.get(String(t.ref));
      if (ds && ds.size === 1 && ds.has(def.date)) scopeTaskIds.add(t.id);
    }
    const d0 = request.locations[0]!;
    return { def, kind: 'builtin', request, solution, scopeTaskIds, depot: { name: 'Depot', lon: d0.x, lat: d0.y }, enrichment: builtinEnrichment() };
  }
  const up = datasetForDay(dayId);
  if (up) return loadUploadedDay(up.dataset, up.day);
  throw new Error(`unknown day ${dayId}`);
}

/** Load a day of an admitted (uploaded) dataset: the shared request, an empty
 * baseline solution scoped to this day's orders, and display enrichment built
 * from the dataset's geocoded orders. */
function loadUploadedDay(ds: Dataset, day: RegDay): LoadedDay {
  const request = JSON.parse(readFileSync(ds.requestPath, 'utf8')) as SurgeRequest;
  const geo = JSON.parse(readFileSync(ds.geocodedPath, 'utf8')) as { records?: Record<string, unknown>[] };
  const recs = (Array.isArray(geo) ? geo : geo.records) ?? [];
  const routable = recs.filter(isRoutableOrder);

  // task id = routable index (0-indexed, as built on admit); scope by delivery_date
  const scopeTaskIds = new Set<number>();
  const enrichment = new Map<string, OrderInfo>();
  routable.forEach((o, i) => {
    if (String(o.delivery_date ?? '').trim() === day.date) scopeTaskIds.add(i);
    const no = String(o.order_no ?? i + 1);
    if (!enrichment.has(no)) enrichment.set(no, {
      id: (o.id as string) ?? null, orderNo: no,
      customer: o.customer ? (config.anonymize ? pseudonym(String(o.customer)) : String(o.customer)) : null,
      city: (o.city as string) ?? null, street: (o.street as string) ?? null, zip: o.zip != null ? String(o.zip) : null,
      lat: typeof o.lat === 'number' ? o.lat : null, lon: typeof o.lon === 'number' ? o.lon : null,
      pallets: typeof o.pallets === 'number' ? o.pallets : null, weightKg: typeof o.weight_kg === 'number' ? o.weight_kg : null,
      twStart: (o.tw_start as string) ?? null, twEnd: (o.tw_end as string) ?? null,
      serviceMin: typeof o.service_min === 'number' ? o.service_min : null,
      requiresTailLift: Boolean(o.requires_tail_lift) || hasTailLiftReq(o.special_req as string),
      maxTonnage: parseTonnage(o.special_req as string),
    });
  });

  const scopedReqIds = request.requests.filter((r) => scopeTaskIds.has(r.delivery_task_id)).map((r) => r.id);
  const solution: SurgeSolution = {
    status: 'OK', routes: [], unassigned: scopedReqIds,
    stats: { vehicles_used: 0, trips: 0, total_distance: 0, unassigned: scopedReqIds.length },
  };
  const def: DayDef = { id: day.dayId, date: day.date, isoDate: day.isoDate, label: day.label, requestFile: '', solutionFile: '' };
  return { def, kind: 'uploaded', request, solution, scopeTaskIds, depot: ds.depot, enrichment };
}

/** All selectable days: the built-ins plus every admitted dataset's days. */
export function allDayIds(): { id: string; isoDate: string; label: string; datasetLabel?: string }[] {
  const out: { id: string; isoDate: string; label: string; datasetLabel?: string }[] = DAYS.map((d) => ({ id: d.id, isoDate: d.isoDate, label: d.label }));
  for (const ds of allDatasets()) for (const d of ds.days) out.push({ id: d.dayId, isoDate: d.isoDate, label: d.label, datasetLabel: ds.label });
  return out;
}
