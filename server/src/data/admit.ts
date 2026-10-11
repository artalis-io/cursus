import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { buildSchema, sampleUpload, type Mapping } from './onboard.js';
import { buildFleetFromUpload } from './fleet.js';
import { minimalEnv } from '../util/childenv.js';
import { buildMatrix, type MatrixLoc } from '../geometry/matrix.js';
import { loadDay } from './dataset.js';
import { registerDataset, datasetDir, isRoutableOrder, type Dataset, type RegDay } from './registry.js';
import type { SurgeRequest, SurgeTask, SurgeRequestDef } from '../types.js';

const pExecFile = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const INGEST_NX = resolve(config.nexusDir, 'nx_pipeline');
const GEOCODE_PY = resolve(config.nexusDir, 'scripts/geocode_verify.py');

/* seconds-from-midnight from "H:MM"/"HH:MM"; null on empty/bad. */
export function hhmmToSec(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(s.trim());
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 : null;
}
function envHasKeys(): boolean {
  if (config.geocodeForceOffline) return false;
  try { return /\b(GOOGLE\w*KEY|HERE\w*KEY|GOOGLE_API_KEY|HERE_API_KEY)\s*=\s*\S+/i.test(readFileSync(config.geocodeEnv, 'utf8')); } catch { return false; }
}
export function dateToIso(tok: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(tok.trim());
  if (m) { const yy = Number(m[3]); const y = yy < 100 ? 2000 + yy : yy; return `${y}-${String(Number(m[1])).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`; }
  const d = new Date(tok); return Number.isNaN(d.getTime()) ? tok : d.toISOString().slice(0, 10);
}

export interface AdmitResult {
  ok: boolean; error?: string;
  datasetId?: string; label?: string;
  days?: { dayId: string; isoDate: string; label: string; orders: number }[];
  routable?: number; excluded?: number; unresolved?: number; snapWarnings?: number;
  fleet?: { count: number; defaulted: number; custom: boolean };
}

/** An uploaded + mapped vehicles file to use as the fleet instead of the built-in one. */
export interface FleetSource { path: string; mapping: Mapping }

/** Admit an onboarded orders upload as a dataset: geocode -> matrix -> Surge
 * request -> register days by delivery date. The fleet is the built-in template
 * unless `fleetSource` provides an uploaded vehicles file. */
export async function admitDataset(uploadPath: string, mapping: Mapping, label: string, onStage?: (stage: string) => void, fleetSource?: FleetSource): Promise<AdmitResult> {
  if (mapping.city == null) return { ok: false, error: 'map the City column' };
  if (mapping.delivery_date == null) return { ok: false, error: 'map the Delivery date column (days are split by it)' };
  if (!existsSync(INGEST_NX)) return { ok: false, error: 'nx_pipeline not built (make -C nexus tools)' };

  const datasetId = `ds_${randomUUID().slice(0, 10)}`;
  const dir = datasetDir(datasetId);
  mkdirSync(dir, { recursive: true });
  const schemaPath = resolve(dir, 'schema.json');
  const canonPath = resolve(dir, 'canonical.json');
  const geoPath = resolve(dir, 'orders.geocoded.json');

  // 1. canonical (with address_geocode) + geocode
  onStage?.('geocoding');
  try {
    const rawCols = (await sampleUpload(uploadPath, 1)).headers.length;
    writeFileSync(schemaPath, JSON.stringify(buildSchema('orders', mapping, rawCols)));
    await pExecFile(INGEST_NX, [uploadPath, '--schema', schemaPath, '-o', canonPath], { timeout: config.ingestTimeoutSec * 1000, maxBuffer: 32 * 1024 * 1024 });
    const args = [GEOCODE_PY, '--orders', canonPath, '--out', geoPath, '--cache-dir', config.geocodeCacheDir, '--env', config.geocodeEnv];
    if (existsSync(config.geocodePbf)) args.push('--pbf', config.geocodePbf);
    const env = minimalEnv(envHasKeys() ? {} : { GEOCODE_OFFLINE: '1' });
    await pExecFile('python3', args, { timeout: config.geocodeTimeoutSec * 1000, maxBuffer: 64 * 1024 * 1024, env });
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    const err = e as { killed?: boolean; stderr?: string };
    return { ok: false, error: err.killed ? 'pipeline timed out' : (err.stderr || (e as Error).message).trim().slice(0, 300) };
  }
  rmSync(schemaPath, { force: true }); rmSync(canonPath, { force: true });

  // 2. routable orders (GREEN/YELLOW with coords)
  const geo = JSON.parse(readFileSync(geoPath, 'utf8')) as { records?: Record<string, unknown>[] };
  const recs = (Array.isArray(geo) ? geo : geo.records) ?? [];
  const routable = recs.filter(isRoutableOrder);
  const unresolved = recs.filter((o) => typeof o.lat !== 'number').length;
  if (routable.length < 1) { rmSync(dir, { recursive: true, force: true }); return { ok: false, error: 'no routable orders (need GREEN/YELLOW geocode on the Hungary graph)' }; }

  // 2b. optional custom fleet from an uploaded vehicles file (fail fast, before
  // the ~1 min matrix). When absent, the built-in template fleet is used.
  let customFleet: Awaited<ReturnType<typeof buildFleetFromUpload>> | null = null;
  if (fleetSource) {
    onStage?.('fleet');
    customFleet = await buildFleetFromUpload(fleetSource.path, fleetSource.mapping);
    if (!customFleet.ok) { rmSync(dir, { recursive: true, force: true }); return { ok: false, error: `fleet: ${customFleet.error}` }; }
  }

  // 3. template (depot, fleet, config, depots) from the built-in day-1 request
  const template = loadDay('day1').request;
  const depotLoc = template.locations[0]!;
  const locs: MatrixLoc[] = [{ id: 'depot', lat: depotLoc.y, lon: depotLoc.x }, ...routable.map((o, i) => ({ id: `o${i}`, lat: o.lat as number, lon: o.lon as number }))];
  onStage?.('matrix');
  const matrix = await buildMatrix(locs);

  // 4. Surge request: clone the template, swap the order-dependent parts.
  onStage?.('request');
  const req = structuredClone(template) as SurgeRequest;
  const fleetInfo = customFleet?.ok
    ? { count: customFleet.fleet.count, defaulted: customFleet.fleet.defaulted, custom: true }
    : { count: req.vehicles.length, defaulted: 0, custom: false };
  if (customFleet?.ok) req.vehicles = customFleet.fleet.vehicles;
  req.locations = [depotLoc, ...routable.map((o) => ({ x: o.lon as number, y: o.lat as number }))];
  // Task/request ids are 0-indexed and contiguous (Surge uses them as indices);
  // location 0 is the depot, so order i is at location i+1.
  const tasks: SurgeTask[] = routable.map((o, i) => ({
    id: i, type: 'delivery', location_id: i + 1,
    tw_early: hhmmToSec(o.tw_start) ?? 0, tw_late: hhmmToSec(o.tw_end) ?? 86_400,
    service_seconds: (typeof o.service_min === 'number' ? o.service_min : 0) * 60,
    demand: [Math.round(typeof o.weight_kg === 'number' ? o.weight_kg : 0), typeof o.pallets === 'number' ? o.pallets : 0],
    ref: String(o.order_no ?? i),
  }));
  const requests: SurgeRequestDef[] = tasks.map((t) => ({ id: t.id, delivery_task_id: t.id, unassigned_penalty: 1_000_000 }));
  req.tasks = tasks;
  req.requests = requests;
  req.travel = { location_count: locs.length, distances: matrix.distances, durations: matrix.durations };
  writeFileSync(resolve(dir, 'request.json'), JSON.stringify(req));

  // 5. days by delivery_date
  const byDate = new Map<string, number>();
  for (const o of routable) { const d = String(o.delivery_date ?? '').trim() || 'unknown'; byDate.set(d, (byDate.get(d) ?? 0) + 1); }
  const days: RegDay[] = [...byDate.entries()].sort().map(([date, orders]) => ({
    dayId: `${datasetId}__${date.replace(/[^a-z0-9]/gi, '')}`, date, isoDate: dateToIso(date),
    label: dateToIso(date), orders,
  }));

  const dataset: Dataset = {
    id: datasetId, label: label || 'Uploaded dataset', createdAt: new Date().toISOString(),
    depot: { name: 'Depot', lon: depotLoc.x, lat: depotLoc.y },
    requestPath: resolve(dir, 'request.json'), geocodedPath: geoPath, days,
  };
  onStage?.('registering');
  registerDataset(dataset);

  return {
    ok: true, datasetId, label: dataset.label,
    days: days.map((d) => ({ dayId: d.dayId, isoDate: d.isoDate, label: d.label, orders: d.orders })),
    routable: routable.length, excluded: recs.length - routable.length, unresolved, snapWarnings: matrix.snapWarnings.length,
    fleet: fleetInfo,
  };
}

export { here };
