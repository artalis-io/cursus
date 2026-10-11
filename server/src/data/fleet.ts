import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { buildSchema, sampleUpload, type Mapping } from './onboard.js';
import type { SurgeRequestVehicle } from '../types.js';

const pExecFile = promisify(execFile);
const NX = resolve(config.nexusDir, 'nx_pipeline');

/* A standard semi-trailer, used when a vehicle row omits a capacity dimension. */
export const DEFAULT_CAP_KG = 24000;
export const DEFAULT_CAP_PLT = 33;
export const MAX_FLEET = 600;              // guards the solver against absurd uploads
const DEFAULT_FIXED_COST = 100_000;        // matches the built-in template fleet

export interface Fleet { vehicles: SurgeRequestVehicle[]; defaulted: number; count: number }
export type FleetResult = { ok: true; fleet: Fleet } | { ok: false; error: string };

function num(v: unknown): number | null { return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null; }

/** Map canonical vehicle records -> a 0-indexed single-depot Surge fleet. Pure.
 * A row missing a capacity dimension falls back to a standard truck and is
 * counted in `defaulted` so the UI can warn. */
export function toSurgeFleet(records: Record<string, unknown>[]): Fleet {
  let defaulted = 0;
  const vehicles: SurgeRequestVehicle[] = records.map((v, i) => {
    const kg = num(v.capacity_kg), plt = num(v.capacity_pallets);
    if (kg == null || plt == null) defaulted++;
    const ref = String(v.id ?? v.plate ?? '').trim() || `V${i + 1}`;
    return {
      id: i, ref,
      capacity: [Math.round(kg ?? DEFAULT_CAP_KG), Math.round(plt ?? DEFAULT_CAP_PLT)],
      start_depot_id: 0, end_depot_id: 0, fixed_cost: DEFAULT_FIXED_COST,
    };
  });
  return { vehicles, defaulted, count: vehicles.length };
}

/** Ingest an uploaded vehicles file (real nx_pipeline, Role-P) and build a Surge
 * fleet from its mapped columns. Never parses the raw bytes in Node. */
export async function buildFleetFromUpload(uploadPath: string, mapping: Mapping): Promise<FleetResult> {
  if (!existsSync(NX)) return { ok: false, error: 'nx_pipeline not built (make -C nexus tools)' };
  if (mapping.id == null) return { ok: false, error: 'map the Vehicle id column' };
  const tmp = resolve(config.uploadsDir, 'tmp');
  mkdirSync(tmp, { recursive: true });
  const base = resolve(tmp, `fleet_${randomUUID().slice(0, 8)}`);
  const schemaPath = `${base}.schema.json`, canonPath = `${base}.canon.json`;
  try {
    const rawCols = (await sampleUpload(uploadPath, 1)).headers.length;
    writeFileSync(schemaPath, JSON.stringify(buildSchema('vehicles', mapping, rawCols)));
    await pExecFile(NX, [uploadPath, '--schema', schemaPath, '-o', canonPath], { timeout: config.ingestTimeoutSec * 1000, maxBuffer: 32 * 1024 * 1024 });
    const o = JSON.parse(readFileSync(canonPath, 'utf8')) as Record<string, unknown>[] | { records?: Record<string, unknown>[] };
    const recs = (Array.isArray(o) ? o : o.records) ?? [];
    if (recs.length < 1) return { ok: false, error: 'no vehicles parsed from the file' };
    if (recs.length > MAX_FLEET) return { ok: false, error: `fleet too large (${recs.length} > ${MAX_FLEET} vehicles)` };
    return { ok: true, fleet: toSurgeFleet(recs) };
  } catch (e) {
    const err = e as { killed?: boolean; stderr?: string };
    return { ok: false, error: err.killed ? 'vehicles ingest timed out' : (err.stderr || (e as Error).message).trim().slice(0, 300) };
  } finally {
    rmSync(schemaPath, { force: true }); rmSync(canonPath, { force: true });
  }
}
