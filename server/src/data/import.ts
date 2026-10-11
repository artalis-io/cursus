import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from '../config.js';

/* Read-only surface for the "import story" view: the raw Excel-origin CSVs, the
 * Nexus canonical audit/provenance, the pipeline stages and the business rules
 * the importer enforces. Everything is sourced from the dataset; nothing is
 * invented. Customer-identifying columns are pseudonymized when anonymize is on. */

function ds(rel: string): string { return resolve(config.datasetRoot, rel); }
function sha256File(path: string): string | null {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return null; }
}

/* Minimal RFC-4180-ish CSV parser (handles quotes, embedded commas/newlines). */
function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const t = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let field = '', row: string[] = [], inQ = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (inQ) {
      if (c === '"') { if (t[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      row.push(field); rows.push(row); field = ''; row = [];
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  const headers = rows.shift() ?? [];
  return { headers, rows: rows.filter((r) => r.some((c) => c.trim() !== '')) };
}

/* Raw source filenames are dataset-specific (the actual files live under
 * ${DATASET_ROOT}/raw and may carry a client prefix), so they are env-driven —
 * no client-named literal in the repo. Point these at your dataset's files. */
const RAW_FILES: Record<string, { file: string; kind: string; label: string; redactCols: string[] }> = {
  orders: { file: process.env.DISPATCH_RAW_ORDERS ?? 'raw/orders_raw.csv', kind: 'orders', label: 'Orders (Excel export)',
    redactCols: ['Szállítási cím megnevezés', 'Kiszállítási cím: utca, házszám'] },
  vehicles: { file: process.env.DISPATCH_RAW_VEHICLES ?? 'raw/vehicles_raw.csv', kind: 'vehicles', label: 'Vehicles', redactCols: [] },
  routes: { file: process.env.DISPATCH_RAW_ROUTES ?? 'raw/routes_fact_raw.csv', kind: 'routes', label: 'Historical routes (baseline)', redactCols: [] },
};

function stablePseudo(s: string): string {
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `Customer ${(h % 900) + 100}`;
}

export function rawSample(which: string, limit = 8): { label: string; headers: string[]; rows: string[][]; totalRows: number } | null {
  const def = RAW_FILES[which];
  if (!def || !existsSync(ds(def.file))) return null;
  const { headers, rows } = parseCsv(readFileSync(ds(def.file), 'utf8'));
  const redactIdx = def.redactCols.map((c) => headers.indexOf(c)).filter((i) => i >= 0);
  const sample = rows.slice(0, limit).map((r) => r.map((cell, i) => {
    if (config.anonymize && redactIdx.includes(i) && cell.trim()) return stablePseudo(cell);
    return cell;
  }));
  return { label: def.label, headers, rows: sample, totalRows: rows.length };
}

export function canonicalSample(limit = 8): { fields: string[]; rows: Record<string, unknown>[]; count: number; sha256: string | null; audit: unknown } | null {
  if (!existsSync(ds('input/orders.json'))) return null;
  const doc = JSON.parse(readFileSync(ds('input/orders.json'), 'utf8')) as {
    records: Record<string, unknown>[]; record_count?: number; source_sha256?: string; audit?: unknown;
  };
  const show = ['order_no', 'customer', 'city', 'delivery_date', 'weight_kg', 'pallets', 'tw_start', 'tw_end', 'service_min'];
  const rows = doc.records.slice(0, limit).map((r) => {
    const o: Record<string, unknown> = {};
    for (const f of show) o[f] = f === 'customer' && config.anonymize && r[f] ? stablePseudo(String(r[f])) : r[f];
    return o;
  });
  return { fields: show, rows, count: doc.record_count ?? doc.records.length, sha256: doc.source_sha256 ?? null, audit: doc.audit ?? null };
}

// Show a neutral, kind-based filename when anonymizing so no client-specific raw
// filename leaks to the UI; otherwise show the basename.
const displayFile = (d: { file: string; kind: string }): string =>
  config.anonymize ? `${d.kind}.csv` : d.file.replace(/^raw\//, '');

export function importSummary() {
  const sources = Object.values(RAW_FILES).map((d) => {
    const path = ds(d.file);
    const present = existsSync(path);
    let rawRows = 0;
    if (present) rawRows = parseCsv(readFileSync(path, 'utf8')).rows.length;
    return { kind: d.kind, label: d.label, file: displayFile(d), present, sha256: sha256File(path)?.slice(0, 16) ?? null, rawRows };
  });
  const canon = canonicalSample(0);

  return {
    sources,
    canonical: { orders: { count: canon?.count ?? null, sourceSha256: canon?.sha256 ?? null, audit: canon?.audit ?? null } },
    // The Nexus pipeline, in order. Counts are the dataset's real figures.
    pipeline: [
      { stage: 'Excel export (CSV)', detail: '332 order lines, 38 vehicles, 332 historical legs' },
      { stage: 'Nexus validate', detail: 'schema + rules; 332/332 accepted, 0 errors, 6 warnings (duplicate order_no = multi-round fuvars)' },
      { stage: 'Canonical (nx_canonical)', detail: 'typed records + source_sha256 provenance; doubles re-serialized at 15 sig figs' },
      { stage: 'Reconcile gate', detail: 'every canonical field traced back to raw bytes (rel_tol 1e-6); 0 mismatches' },
      { stage: 'Geocode', detail: 'Google authoritative + Locus cross-check + libpostal; 263 Hungarian lines in scope' },
      { stage: 'Travel matrix (Velo)', detail: '264×264 truck distance/duration, HGV-aware' },
      { stage: 'Surge request', detail: '2-D demand [kg, pallets], hard capacity/time-windows/duration, per day' },
    ],
    // Business rules the importer enforces (quoted from the dataset PIPELINE.md).
    rules: [
      'Fractional pallets: pallets is a double (partial/stackable), never derived from weight.',
      'Shared tractors: 6 tractors appear solo and with a trailer; mutually exclusive in Surge.',
      'Subcontractors: 10 "unlimited" carriers modeled as a finite 24 t fleet.',
      'Fuvar ≠ one trip: some fuvars span multiple rounds (forduló); 3 duplicate order_no.',
      'Carrier↔vehicle join gap: routes_fact names (S AND TO) differ from plates (S&TO).',
      'Precision clamp fix: Stage X re-serializes doubles at 15 significant figures.',
    ],
    scope: { rawOrderLines: 332, inScopeHungarian: 263, day1: 117, day2: 146 },
  };
}
