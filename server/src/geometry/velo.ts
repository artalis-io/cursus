import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.js';
import { writeJsonAtomic } from '../util/jsonfile.js';
import type { Plan, GeoJSONLineString } from '../types.js';

/* Road-following geometry for plan routes, fetched from the Velo route server
 * (truck profile, Hungary graph). Fetched ONCE per plan and cached (in-memory +
 * on disk), never per selection change. If Velo is unreachable, geometry stays
 * null and the UI must not fabricate straight lines. */

type LonLat = [number, number];
const cacheFile = resolve(config.dataDir, 'geocache.json');
const mem = new Map<string, LonLat[]>();
let loaded = false;

function loadCache(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (existsSync(cacheFile)) {
      const obj = JSON.parse(readFileSync(cacheFile, 'utf8')) as Record<string, LonLat[]>;
      for (const [k, v] of Object.entries(obj)) mem.set(k, v);
    }
  } catch { /* cache is best-effort */ }
}
let dirty = false;
function persistCache(): void {
  if (!dirty) return;
  try {
    mkdirSync(config.dataDir, { recursive: true });
    const obj: Record<string, LonLat[]> = {};
    for (const [k, v] of mem) obj[k] = v;
    writeJsonAtomic(cacheFile, obj);
    dirty = false;
  } catch { /* best-effort */ }
}

/* Bound the cache: Map preserves insertion order, so deleting from the front
 * evicts the oldest legs (approx-LRU; good enough for geometry that is cheap to
 * refetch). Keeps the cache file and heap from growing without limit. */
function rememberLeg(key: string, coords: LonLat[]): void {
  mem.set(key, coords);
  dirty = true;
  while (mem.size > config.geocacheMaxLegs) {
    const oldest = mem.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    mem.delete(oldest);
  }
}

const r5 = (n: number): number => Math.round(n * 1e5) / 1e5;
const legKey = (a: LonLat, b: LonLat): string => `${r5(a[0])},${r5(a[1])}>${r5(b[0])},${r5(b[1])}`;

/** Decode a Google-style encoded polyline (precision 5) to [lon,lat] pairs. */
function decodePolyline(str: string, precision = config.polylinePrecision): LonLat[] {
  let index = 0, lat = 0, lng = 0;
  const coords: LonLat[] = [];
  const factor = Math.pow(10, precision);
  while (index < str.length) {
    let result = 1, shift = 0, b: number;
    do { b = str.charCodeAt(index++) - 63 - 1; result += b << shift; shift += 5; } while (b >= 0x1f);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    result = 1; shift = 0;
    do { b = str.charCodeAt(index++) - 63 - 1; result += b << shift; shift += 5; } while (b >= 0x1f);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    coords.push([lng / factor, lat / factor]);
  }
  return coords;
}

/** One raw Velo route request, no caching/surrogates. Returns decoded [lon,lat]. */
async function rawRoute(from: LonLat, to: LonLat): Promise<LonLat[] | null> {
  const url = `${config.veloOrigin}/api/v1/route?from=${from[1]},${from[0]}&to=${to[1]},${to[0]}`
    + `&profile=${config.veloProfile}&mode=fastest&geometry=true`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { status?: string; route?: { geometry?: string } };
    if (j.status !== 'ok' || !j.route?.geometry) return null;
    return decodePolyline(j.route.geometry);
  } catch {
    return null;
  }
}

/* A few geocodes snap to an isolated graph node that Velo cannot route to/from
 * (verified: order 20998 fails by every profile, while points ~300m away route
 * fine). For those, find the nearest routable point by probing a small ring and
 * route via it. The stop keeps its true coordinate on the map; only the route
 * line approaches within a few hundred metres. This is a geometry-visualisation
 * fallback, not a straight-line substitute. */
const surrogate = new Map<string, LonLat | null>();
async function findSurrogate(p: LonLat, ref: LonLat): Promise<LonLat | null> {
  const key = `${r5(p[0])},${r5(p[1])}`;
  if (surrogate.has(key)) return surrogate.get(key)!;
  const cosLat = Math.cos((p[1] * Math.PI) / 180) || 1;
  for (const rad of [0.004, 0.008]) {       // ~300m, ~600m
    for (let k = 0; k < 8; k++) {
      const a = (2 * Math.PI * k) / 8;
      const cand: LonLat = [p[0] + (rad * Math.cos(a)) / cosLat, p[1] + rad * Math.sin(a)];
      if (await rawRoute(ref, cand)) { surrogate.set(key, cand); return cand; }
    }
  }
  surrogate.set(key, null);
  return null;
}

async function fetchLeg(from: LonLat, to: LonLat): Promise<LonLat[] | null> {
  loadCache();
  const key = legKey(from, to);
  const hit = mem.get(key);
  if (hit) return hit;

  let coords = await rawRoute(from, to);
  if (!coords) {
    // Retry via routable surrogates for the failing endpoint(s).
    const tS = await findSurrogate(to, from);
    if (tS) coords = await rawRoute(from, tS);
    if (!coords) {
      const fS = await findSurrogate(from, to);
      if (fS) coords = await rawRoute(fS, to);
      if (!coords && fS && tS) coords = await rawRoute(fS, tS);
    }
  }
  if (!coords) return null;
  rememberLeg(key, coords);
  return coords;
}

/** Run async tasks with bounded concurrency. */
async function pool<T>(items: (() => Promise<T>)[], limit = 8): Promise<T[]> {
  const out: T[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await items[idx]!();
    }
  });
  await Promise.all(workers);
  return out;
}

function stitch(legs: (LonLat[] | null)[]): LonLat[] {
  const coords: LonLat[] = [];
  for (const leg of legs) {
    if (!leg || leg.length === 0) continue;
    const start = coords.length > 0 ? 1 : 0; // drop shared vertex
    for (let k = start; k < leg.length; k++) coords.push(leg[k]!);
  }
  return coords;
}

/** Fill every trip's geometry in-place. Returns true if any geometry was set.
 * Idempotent: trips that already have geometry are skipped. Cached across calls. */
export async function fillPlanGeometry(plan: Plan): Promise<boolean> {
  const depot: LonLat = [plan.depot.lon, plan.depot.lat];
  type Job = { trip: Plan['vehicles'][number]['trips'][number]; pts: LonLat[] };
  const jobs: Job[] = [];
  for (const v of plan.vehicles) {
    for (const t of v.trips) {
      if (t.geometry || t.stops.length === 0) continue;
      const pts: LonLat[] = [depot, ...t.stops.map((s) => [s.lon, s.lat] as LonLat), depot];
      jobs.push({ trip: t, pts });
    }
  }
  if (jobs.length === 0) return false;

  let any = false;
  // Fetch each trip's legs with bounded concurrency; cached legs are instant, so
  // retrying a trip only re-fetches the legs that failed transiently (cold Velo).
  for (const job of jobs) {
    for (let attempt = 0; attempt < 3 && !job.trip.geometry; attempt++) {
      const legFns = job.pts.slice(0, -1).map((_, k) => () => fetchLeg(job.pts[k]!, job.pts[k + 1]!));
      const legs = await pool(legFns, 6);
      const coords = stitch(legs);
      if (coords.length >= 2) {
        job.trip.geometry = { type: 'LineString', coordinates: coords } as GeoJSONLineString;
        any = true;
      }
    }
  }
  persistCache();
  return any;
}

export async function veloReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${config.veloOrigin}/api/v1/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch { return false; }
}
