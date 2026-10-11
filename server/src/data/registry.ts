import { mkdirSync, readdirSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { config } from '../config.js';
import { writeJsonAtomic } from '../util/jsonfile.js';

/* Registry of admitted (uploaded) datasets. Each dataset is a folder under the
 * external uploads dir holding its Surge request, geocoded orders, and a
 * dataset.json manifest. Its days (by delivery date) become selectable
 * alongside the built-in days. Never committed. */

export interface RegDay { dayId: string; date: string; isoDate: string; label: string; orders: number }
export interface Dataset {
  id: string;
  label: string;
  createdAt: string;
  depot: { name: string; lon: number; lat: number };
  requestPath: string;
  geocodedPath: string;
  days: RegDay[];
}

/* A geocoded order is routable iff it has coordinates, a confident tier, and is
 * on the router's graph (Hungary). Shared by admit (building the matrix/tasks)
 * and loadDay (scoping) so task indices stay aligned. */
export function isRoutableOrder(o: Record<string, unknown>): boolean {
  return typeof o.lat === 'number' && typeof o.lon === 'number'
    && ['GREEN', 'YELLOW'].includes(String(o.geo_tier)) && String(o.geo_cc) === 'HU';
}

export function datasetsRoot(): string { const d = resolve(config.uploadsDir, 'datasets'); mkdirSync(d, { recursive: true }); return d; }
export function datasetDir(id: string): string {
  // Defense-in-depth: reject path traversal here so the safety does not rely on
  // every caller validating the id (public callers already match ds_<token>).
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`invalid dataset id: ${id}`);
  return resolve(datasetsRoot(), id);
}

const registry = new Map<string, Dataset>();
function load(): void {
  registry.clear();
  const root = datasetsRoot();
  if (!existsSync(root)) return;
  for (const id of readdirSync(root)) {
    const dir = join(root, id);
    try {
      const ds = JSON.parse(readFileSync(join(dir, 'dataset.json'), 'utf8')) as Dataset;
      if (ds.id) { registry.set(ds.id, ds); continue; }
    } catch { /* fall through to orphan handling */ }
    // A9: a dir without a valid manifest is a crash orphan (admit writes the
    // request/geocoded files before the manifest). Remove it so it cannot
    // accumulate invisibly. Only sweep directories, never stray files.
    try {
      if (statSync(dir).isDirectory()) { rmSync(dir, { recursive: true, force: true }); console.warn(`[registry] removed orphan dataset dir: ${id}`); }
    } catch { /* ignore */ }
  }
}
load();

export function registerDataset(ds: Dataset): void {
  mkdirSync(datasetDir(ds.id), { recursive: true });
  // Written last and atomically: the manifest's presence is what makes the
  // dataset "committed"; a half-written one can never shadow the old.
  writeJsonAtomic(join(datasetDir(ds.id), 'dataset.json'), ds);
  registry.set(ds.id, ds);
}
export function allDatasets(): Dataset[] { return [...registry.values()]; }
export function getDataset(id: string): Dataset | undefined { return registry.get(id); }
export function unregisterDataset(id: string): Dataset | null {
  const ds = registry.get(id);
  if (!ds) return null;
  registry.delete(id);
  try { rmSync(datasetDir(id), { recursive: true, force: true }); } catch { /* best-effort */ }
  return ds;
}
export function datasetForDay(dayId: string): { dataset: Dataset; day: RegDay } | null {
  for (const ds of registry.values()) {
    const day = ds.days.find((d) => d.dayId === dayId);
    if (day) return { dataset: ds, day };
  }
  return null;
}
