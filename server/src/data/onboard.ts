import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { minimalEnv } from '../util/childenv.js';
import { CATALOG, type Entity, type FieldType } from './catalog.js';

const pExecFile = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));            // server/src/data
const SAMPLE_PY = resolve(here, '../../scripts/sample_table.py');
const INGEST_SH = resolve(config.nexusDir, 'scripts/ingest.sh');
const NX_PIPELINE = resolve(config.nexusDir, 'nx_pipeline');

/** Upload formats we accept. nx_pipeline parses both; Node never parses the bytes. */
export type UploadExt = 'csv' | 'xlsx';
export function extFromName(filename: string | undefined): UploadExt | null {
  if (!filename) return null;
  if (/\.xlsx$/i.test(filename)) return 'xlsx';
  if (/\.csv$/i.test(filename)) return 'csv';
  return null;
}
function isXlsx(path: string): boolean { return /\.xlsx$/i.test(path); }

function tmpDir(): string { const d = resolve(config.uploadsDir, 'tmp'); mkdirSync(d, { recursive: true }); return d; }

/** A server-side path for an upload (generated name; the client filename is never trusted). */
export function newUploadPath(entity: Entity, ext: UploadExt = 'csv'): { uploadId: string; path: string } {
  const uploadId = `up_${randomUUID().slice(0, 12)}`;
  return { uploadId, path: resolve(tmpDir(), `${uploadId}_${entity}.${ext}`) };
}
/** Resolve an upload's stored path by its id+entity prefix, whatever extension it has. */
export function uploadPath(uploadId: string, entity: Entity): string {
  const prefix = `${uploadId}_${entity}.`;
  const dir = tmpDir();
  try {
    const hit = readdirSync(dir).find((f) => f.startsWith(prefix) && (f.endsWith('.csv') || f.endsWith('.xlsx')));
    if (hit) return resolve(dir, hit);
  } catch { /* dir may not exist yet */ }
  return resolve(dir, `${prefix}csv`); // fallback (existsSync check by caller will 404)
}

export interface Sample { headers: string[]; rows: string[][]; totalRows: number; delimiter: string }

/** Headers + sample rows + row count. CSV is parsed by sample_table.py; XLSX is
 * parsed by nx_pipeline --raw (the Role-P parser). Node never parses raw bytes. */
export async function sampleUpload(path: string, limit = 8): Promise<Sample> {
  if (!existsSync(path)) throw new Error('upload not found');
  if (isXlsx(path)) return sampleXlsx(path, limit);
  const { stdout } = await pExecFile('python3', [SAMPLE_PY, path, String(limit)], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
  const o = JSON.parse(stdout) as Sample & { error?: string };
  if (o.error) throw new Error(`sample failed: ${o.error}`);
  return o;
}

interface NxRaw { tables?: { headers?: string[]; rows?: { cells?: string[] }[]; row_count?: number }[]; error?: string }
/** Sample an XLSX via `nx_pipeline --raw` (first table): headers + first N rows. */
async function sampleXlsx(path: string, limit: number): Promise<Sample> {
  const { stdout } = await pExecFile(NX_PIPELINE, [path, '--raw'], { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
  const o = JSON.parse(stdout) as NxRaw;
  if (o.error) throw new Error(`xlsx parse failed: ${o.error}`);
  const t = o.tables?.[0];
  if (!t) throw new Error('no tables in workbook');
  const headers = t.headers ?? [];
  const rows = (t.rows ?? []).slice(0, limit).map((r) => r.cells ?? []);
  return { headers, rows, totalRows: t.row_count ?? rows.length, delimiter: 'xlsx' };
}

export type Mapping = Record<string, number>; // canonical field -> raw column index

/** Generate an nx_schema v2 from a column mapping (direct column->field). For
 * orders, also derive `address_geocode` (a merge of street/zip/city) so the
 * output is geocode-ready; reconcile verifies merge-derived fields too. */
export function buildSchema(entity: Entity, mapping: Mapping, rawCols = 18): object {
  const fields = CATALOG[entity];
  const byField = new Map(fields.map((f) => [f.field, f]));
  const columns: object[] = [];
  for (const [field, idx] of Object.entries(mapping)) {
    const f = byField.get(field);
    if (!f || typeof idx !== 'number' || idx < 0) continue;
    columns.push(columnSpec(idx, field, f.type, f.required));
  }
  const schema: Record<string, unknown> = {
    nx_schema: 2, version: `onboard-${entity}`, output_type: 'record',
    table_selector: { index: 0 }, skip_rows: 0, columns,
  };
  // Derived fields for orders. Virtual columns are appended after the raw width,
  // in multi_transforms order, one per emitted target.
  if (entity === 'orders') {
    const transforms: object[] = [];
    let vcol = rawCols;
    const merge = addressMerge(mapping);
    if (merge) { transforms.push(merge); columns.push({ source: vcol++, target: 'address_geocode', type: 'string', default: '' }); }
    if (mapping.time_window_raw != null) {
      transforms.push({ type: 'regex', source: mapping.time_window_raw, pattern: '([0-9]{1,2}:[0-9]{2}) *- *([0-9]{1,2}:[0-9]{2})', targets: [{ field: 'tw_start', group: 1 }, { field: 'tw_end', group: 2 }] });
      columns.push({ source: vcol++, target: 'tw_start', type: 'string', default: '' });
      columns.push({ source: vcol++, target: 'tw_end', type: 'string', default: '' });
    }
    if (transforms.length) schema.multi_transforms = transforms;
  }
  return schema;
}

/** An address_geocode merge "street, zip city" from whichever of street/zip/city
 * are mapped (city is required). */
function addressMerge(mapping: Mapping): object | null {
  if (mapping.city == null) return null;
  const sources: number[] = [];
  const pos: Record<string, number> = {};
  for (const f of ['street', 'zip', 'city'] as const) {
    if (mapping[f] != null) { pos[f] = sources.length; sources.push(mapping[f]!); }
  }
  const segs: string[] = [];
  if ('street' in pos) segs.push(`{${pos.street}},`);
  if ('zip' in pos) segs.push(`{${pos.zip}}`);
  segs.push(`{${pos.city}}`);
  return { type: 'merge', sources, template: segs.join(' '), target: 'address_geocode' };
}
function columnSpec(source: number, target: string, type: FieldType, required: boolean): object {
  const base: Record<string, unknown> = { source, target, type };
  if (type === 'string') { base.transforms = ['trim']; if (!required) base.default = ''; }
  else if (type === 'double') { base.precision = 10; base.validate = { min: 0 }; }
  else if (type === 'int') { base.validate = { min: 0 }; }
  else if (type === 'bool') { base.default = 'false'; }
  if (required) base.required = true;
  return base;
}

/** Which required fields are unmapped (empty if the mapping is complete). */
export function missingRequired(entity: Entity, mapping: Mapping): string[] {
  return CATALOG[entity].filter((f) => f.required && !(f.field in mapping)).map((f) => f.field);
}

export interface Preview {
  ok: boolean;                 // reconcile passed (admit-able)
  reconcile: { provenanceOk: boolean; rowsReconciled: number; fieldsVerified: string[]; mismatches: number; mismatchSamples: string[] };
  semantic: { errors: number; warnings: number; info: number; items: { level: string; kind: string; count: number }[] };
  canonical: { count: number; sample: Record<string, unknown>[] };
  error?: string;
}

/** Run the real ingest (nx_pipeline + reconcile gate + semantic checks) on an
 * uploaded file with a generated schema, and summarize the result for review. */
export async function runIngestPreview(path: string, entity: Entity, mapping: Mapping): Promise<Preview> {
  const miss = missingRequired(entity, mapping);
  if (miss.length) return emptyPreview(`map required fields: ${miss.join(', ')}`);
  if (!existsSync(INGEST_SH)) return emptyPreview(`nexus ingest not found at ${INGEST_SH} (build: make -C nexus tools)`);

  const rawCols = (await sampleUpload(path, 1)).headers.length;
  const schemaPath = `${path}.schema.json`;
  const outPath = `${path}.canonical.json`;
  writeFileSync(schemaPath, JSON.stringify(buildSchema(entity, mapping, rawCols)));

  let stdout = '', exitCode = 0;
  try {
    const r = await pExecFile('sh', [INGEST_SH, path, schemaPath, outPath], { timeout: config.ingestTimeoutSec * 1000, maxBuffer: 32 * 1024 * 1024 });
    stdout = r.stdout;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number; killed?: boolean };
    stdout = err.stdout ?? '';
    exitCode = typeof err.code === 'number' ? err.code : 2;
    if (err.killed) { cleanup(schemaPath, outPath); return emptyPreview(`ingest timed out after ${config.ingestTimeoutSec}s`); }
    if (exitCode === 2) { cleanup(schemaPath, outPath); return emptyPreview((err.stderr || 'ingest setup error').trim().slice(0, 300)); }
    // exit 1 = reconcile mismatch: fall through and report it (stdout has the details)
  }

  const reconcile = parseReconcile(stdout);
  const semantic = parseSemantic(stdout);
  let canonical = { count: 0, sample: [] as Record<string, unknown>[] };
  try {
    const raw = JSON.parse(readFileSync(outPath, 'utf8')) as unknown;
    const recs = (Array.isArray(raw) ? raw : (raw as { records?: Record<string, unknown>[] }).records) ?? [];
    canonical = { count: recs.length, sample: recs.slice(0, 8) };
  } catch { /* no output on gate failure */ }

  cleanup(schemaPath, outPath);
  return { ok: exitCode === 0 && reconcile.provenanceOk && reconcile.mismatches === 0, reconcile, semantic, canonical };
}

function cleanup(...paths: string[]): void { for (const p of paths) { try { rmSync(p, { force: true }); } catch { /* ignore */ } } }
function emptyPreview(error: string): Preview {
  return { ok: false, reconcile: { provenanceOk: false, rowsReconciled: 0, fieldsVerified: [], mismatches: 0, mismatchSamples: [] }, semantic: { errors: 0, warnings: 0, info: 0, items: [] }, canonical: { count: 0, sample: [] }, error };
}

export function parseReconcile(stdout: string): Preview['reconcile'] {
  const provenanceOk = /provenance sha256\s*:\s*OK/.test(stdout);
  const rowsReconciled = Number(/rows reconciled\s*:\s*(\d+)/.exec(stdout)?.[1] ?? 0);
  const mismatches = Number(/mismatches\s*:\s*(\d+)/.exec(stdout)?.[1] ?? 0);
  const fieldsStr = /fields verified\s*:\s*\d+\s*\[([^\]]*)\]/.exec(stdout)?.[1] ?? '';
  const fieldsVerified = fieldsStr.split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  const mismatchSamples = (stdout.match(/^\s*MISMATCH .*/gm) ?? []).slice(0, 20).map((s) => s.trim());
  return { provenanceOk, rowsReconciled, fieldsVerified, mismatches, mismatchSamples };
}

export function parseSemantic(stdout: string): Preview['semantic'] {
  const items: { level: string; kind: string; count: number }[] = [];
  let errors = 0, warnings = 0, info = 0;
  for (const m of stdout.matchAll(/\[(ERROR|WARN|INFO)\]\s+([\w-]+)\s+\((\d+)\)/g)) {
    const level = m[1]!, kind = m[2]!, count = Number(m[3]!);
    items.push({ level, kind, count });
    if (level === 'ERROR') errors += count; else if (level === 'WARN') warnings += count; else info += count;
  }
  return { errors, warnings, info, items };
}

/* ---- M2: geocode the mapped orders (cache-first; keys-if-present else offline) ---- */

export type Tier = 'GREEN' | 'YELLOW' | 'APPROX' | 'RED';
export interface GeoPoint { lon: number; lat: number; tier: Tier; city: string; orderNo: string; customer: string }
export interface GeocodeResult {
  ok: boolean;
  error?: string;
  mode: 'offline' | 'online';
  total: number;
  resolved: number;
  unresolved: number;
  byTier: Record<Tier, number>;
  points: GeoPoint[];          // capped for the map
}

function envHasKeys(): boolean {
  if (config.geocodeForceOffline) return false;
  try {
    const txt = readFileSync(config.geocodeEnv, 'utf8');
    return /\b(GOOGLE\w*KEY|HERE\w*KEY|GOOGLE_API_KEY|HERE_API_KEY)\s*=\s*\S+/i.test(txt);
  } catch { return false; }
}

/** Run the real 3-way geocoder on the mapped orders, cache-first. Online calls
 * are allowed only when API keys are configured (else cache-only/offline). */
export async function runGeocode(path: string, mapping: Mapping): Promise<GeocodeResult> {
  if (mapping.city == null) return emptyGeo('map the City column before geocoding');
  const sample = await sampleUpload(path, 1);
  const schemaPath = `${path}.geo.schema.json`;
  const canonPath = `${path}.geo.canonical.json`;
  const outPath = `${path}.geocoded.json`;
  writeFileSync(schemaPath, JSON.stringify(buildSchema('orders', mapping, sample.headers.length)));

  const online = envHasKeys();
  const nx = resolve(config.nexusDir, 'nx_pipeline');
  const gc = resolve(config.nexusDir, 'scripts/geocode_verify.py');
  try {
    await pExecFile(nx, [path, '--schema', schemaPath, '-o', canonPath], { timeout: config.ingestTimeoutSec * 1000, maxBuffer: 32 * 1024 * 1024 });
    const args = [gc, '--orders', canonPath, '--out', outPath, '--cache-dir', config.geocodeCacheDir, '--env', config.geocodeEnv];
    if (existsSync(config.geocodePbf)) args.push('--pbf', config.geocodePbf);
    // A5: a minimal child env (keys come from --env, not inherited process.env).
    const env = minimalEnv(online ? {} : { GEOCODE_OFFLINE: '1' });
    await pExecFile('python3', args, { timeout: config.geocodeTimeoutSec * 1000, maxBuffer: 64 * 1024 * 1024, env });
  } catch (e) {
    const err = e as { killed?: boolean; stderr?: string };
    cleanup(schemaPath, canonPath, outPath);
    return emptyGeo(err.killed ? `geocode timed out after ${config.geocodeTimeoutSec}s` : (err.stderr || 'geocode failed').trim().slice(0, 300), online ? 'online' : 'offline');
  }

  let recs: Record<string, unknown>[] = [];
  try {
    const raw = JSON.parse(readFileSync(outPath, 'utf8')) as unknown;
    recs = (Array.isArray(raw) ? raw : (raw as { records?: Record<string, unknown>[] }).records) ?? [];
  } catch { /* below */ }
  cleanup(schemaPath, canonPath, outPath);

  const byTier: Record<Tier, number> = { GREEN: 0, YELLOW: 0, APPROX: 0, RED: 0 };
  const points: GeoPoint[] = [];
  let resolved = 0;
  for (const o of recs) {
    const lat = o.lat, lon = o.lon;
    const tier = (['GREEN', 'YELLOW', 'APPROX', 'RED'].includes(String(o.geo_tier)) ? o.geo_tier : 'RED') as Tier;
    byTier[tier]++;
    if (typeof lat === 'number' && typeof lon === 'number') {
      resolved++;
      if (points.length < 2000) points.push({ lon, lat, tier, city: String(o.city ?? ''), orderNo: String(o.order_no ?? ''), customer: String(o.customer ?? '') });
    }
  }
  return { ok: resolved > 0, mode: online ? 'online' : 'offline', total: recs.length, resolved, unresolved: recs.length - resolved, byTier, points };
}

function emptyGeo(error: string, mode: 'offline' | 'online' = 'offline'): GeocodeResult {
  return { ok: false, error, mode, total: 0, resolved: 0, unresolved: 0, byTier: { GREEN: 0, YELLOW: 0, APPROX: 0, RED: 0 }, points: [] };
}
