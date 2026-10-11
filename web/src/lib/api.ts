import type { Comparison, DaySummary, Job, Objective, Plan, Scenario, ScenarioEdit, Trip } from '@/types';

/* Same-origin API client. In dev, Vite proxies /api and /tiles to the backend
 * (VITE_API_ORIGIN); in production the backend serves the SPA and these paths. */

export type ApiErrorCode = 'rate_limited' | 'server' | 'not_found' | 'bad_request' | 'network' | 'unknown';
/* A typed error so the UI can show a humane, localized message (429 -> "server
 * busy", 5xx -> "server error", offline -> "connection lost") instead of a raw
 * "/api/...: 429". serverMessage carries a 4xx body message worth surfacing. */
export class ApiError extends Error {
  constructor(public status: number | null, public code: ApiErrorCode, message: string, public serverMessage?: string) {
    super(message); this.name = 'ApiError';
  }
}
function classify(status: number): ApiErrorCode {
  if (status === 429) return 'rate_limited';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'server';
  if (status >= 400) return 'bad_request';
  return 'unknown';
}
async function handle<T>(r: Response, url: string): Promise<T> {
  if (r.ok) return (await r.json()) as T;
  const code = classify(r.status);
  let serverMessage: string | undefined;
  try { serverMessage = ((await r.json()) as { error?: string }).error; } catch { /* non-JSON body */ }
  throw new ApiError(r.status, code, serverMessage ?? `${url}: ${r.status}`, serverMessage);
}
function asNetworkError(e: unknown, url: string): never {
  if (e instanceof ApiError) throw e;
  throw new ApiError(null, 'network', `${url}: ${(e as Error).message}`);
}

async function jget<T>(url: string): Promise<T> {
  let r: Response;
  try { r = await fetch(url); } catch (e) { asNetworkError(e, url); }
  return handle<T>(r, url);
}
async function jsend<T>(url: string, method: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) { asNetworkError(e, url); }
  return handle<T>(r, url);
}

export const api = {
  days: () => jget<DaySummary[]>('/api/days'),
  plan: (id: string) => jget<Plan>(`/api/plans/${id}`),
  /** Recompute one vehicle trip under a proposed stop order (no re-solve). */
  evaluateTrip: (planId: string, body: { vehicleId: number; tripIndex: number; startSec: number; reloadSecAfter: number; orderNos: string[] }) =>
    jsend<{ trip: Trip }>(`/api/plans/${planId}/evaluate`, 'POST', body),
  scenario: (id: string) => jget<Scenario & { ordersInScope: number; vehicleCount: number; isoDate: string }>(`/api/scenarios/${id}`),

  config: () => jget<{ carta: string; velo: string; solveTimeSeconds: number; cost: { available: boolean; currency: string; source: 'demo' | 'external' } }>('/api/config'),

  createBaseScenario: (day: string) => jsend<Scenario>('/api/scenarios', 'POST', { day }),
  createCopy: (from: string, removeVehicleId: number, label?: string) =>
    jsend<Scenario>('/api/scenarios', 'POST', { from, removeVehicleId, label }),

  /** Apply a manual override; the backend forks a copy from a base scenario. */
  editScenario: (id: string, edit: ScenarioEdit, label?: string) =>
    jsend<Scenario>(`/api/scenarios/${id}/edit`, 'POST', { edit, label }),

  /** Apply several overrides at once (bulk actions); forks + persists once. */
  editScenarioBatch: (id: string, edits: ScenarioEdit[], label?: string) =>
    jsend<Scenario>(`/api/scenarios/${id}/edits`, 'POST', { edits, ...(label ? { label } : {}) }),

  solve: (scenarioId: string, budgetSec?: number, objective?: Objective, fullBudget?: boolean) =>
    jsend<{ jobId: string; scenarioId: string; scenarioRevision: number; budgetSec: number; objective: Objective }>(
      `/api/scenarios/${scenarioId}/solve`, 'POST', { ...(budgetSec ? { budgetSec } : {}), ...(objective ? { objective } : {}), ...(fullBudget ? { fullBudget: true } : {}) }),

  exportCsvUrl: (planId: string) => `/api/plans/${planId}/export.csv`,
  routeSheetUrl: (planId: string) => `/api/plans/${planId}/routesheet.html`,
  routesCsvUrl: (planId: string) => `/api/plans/${planId}/routes.csv`,
  handoffJsonUrl: (planId: string) => `/api/plans/${planId}/handoff.json`,

  plans: (day?: string) => jget<PlanSummary[]>(`/api/plans${day ? `?day=${day}` : ''}`),

  job: (id: string) => jget<Job>(`/api/jobs/${id}`),
  cancelJob: (id: string) => jsend<{ cancelled: boolean; status: string }>(`/api/jobs/${id}`, 'DELETE'),

  compare: (base: string, revised: string) => jget<Comparison>(`/api/compare?base=${base}&revised=${revised}`),

  // ---- What-if scenario workspace ----
  scenariosForDay: (day: string) => jget<ScenarioSummary[]>(`/api/scenarios?day=${day}`),
  renameScenario: (id: string, label: string) => jsend<Scenario>(`/api/scenarios/${id}/rename`, 'POST', { label }),
  deleteScenario: (id: string) => jsend<{ deleted: boolean }>(`/api/scenarios/${id}`, 'DELETE'),
  exportScenario: (id: string) => jget<ScenarioExport>(`/api/scenarios/${id}/export`),
  importScenario: (bundle: unknown) => jsend<Scenario>('/api/scenarios/import', 'POST', bundle),

  week: () => jget<WeekSummary>('/api/week'),

  sageStatus: () => jget<{ reachable: boolean; model: string }>('/api/sage/status'),
  narratePlan: (id: string, lang: string) => jsend<{ text: string }>(`/api/plans/${id}/narrate`, 'POST', { lang }),
  narrateCompare: (base: string, revised: string, lang: string) =>
    jsend<{ text: string }>(`/api/compare/narrate?base=${base}&revised=${revised}`, 'POST', { lang }),

  importSummary: () => jget<ImportSummary>('/api/import/summary'),
  importRaw: (file: string) => jget<RawSample>(`/api/import/raw?file=${file}&limit=8`),
  importCanonical: () => jget<CanonicalSample>('/api/import/canonical?limit=8'),

  // ---- Onboarding (upload a dataset) ----
  onboardCatalog: () => jget<Record<Entity, CanonicalField[]>>('/api/import/catalog'),
  onboardUpload: async (entity: Entity, file: File): Promise<UploadResult> => {
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch(`/api/import/upload?entity=${entity}`, { method: 'POST', body: fd });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `upload: ${r.status}`);
    return r.json() as Promise<UploadResult>;
  },
  onboardPreview: (uploadId: string, entity: Entity, mapping: Record<string, number>) =>
    jsend<OnboardPreview>('/api/import/preview', 'POST', { uploadId, entity, mapping }),
  onboardGeocode: (uploadId: string, mapping: Record<string, number>) =>
    jsend<GeocodeResult>('/api/import/geocode', 'POST', { uploadId, mapping }),
  onboardAdmit: (uploadId: string, mapping: Record<string, number>, label: string, fleet?: { vehiclesUploadId: string; vehiclesMapping: Record<string, number> }) =>
    jsend<{ jobId: string }>('/api/import/admit', 'POST', { uploadId, mapping, label, ...(fleet ? { vehiclesUploadId: fleet.vehiclesUploadId, vehiclesMapping: fleet.vehiclesMapping } : {}) }),
  onboardDatasets: () => jget<DatasetSummary[]>('/api/import/datasets'),
  onboardDeleteDataset: (id: string) => jsend<{ deleted: boolean; days: number }>(`/api/import/datasets/${id}`, 'DELETE'),
};

export interface ScenarioExport {
  otto_scenario: 1; day: string; label: string;
  edits: { removedVehicleIds: number[]; pins: unknown[]; forbids: unknown[]; vehicleOverrides: unknown[]; sequences: unknown[] };
}

export interface ScenarioSummary {
  id: string; label: string; kind: 'base' | 'copy'; revision: number; changesCount: number;
  latest: {
    planId: string; createdAt: string;
    servedOrders: number; totalOrders: number; vehiclesUsed: number; totalDistanceKm: number;
    unassigned: number; cost: number | null; currency: string | null;
  } | null;
}

export interface DatasetSummary {
  id: string; label: string; createdAt: string;
  days: { dayId: string; isoDate: string; orders: number }[];
  totalOrders: number;
}

export interface AdmitResult {
  ok: boolean; error?: string;
  datasetId?: string; label?: string;
  days?: { dayId: string; isoDate: string; label: string; orders: number }[];
  routable?: number; excluded?: number; unresolved?: number; snapWarnings?: number;
  fleet?: { count: number; defaulted: number; custom: boolean };
}

export type GeoTier = 'GREEN' | 'YELLOW' | 'APPROX' | 'RED';
export interface GeoPoint { lon: number; lat: number; tier: GeoTier; city: string; orderNo: string; customer: string }
export interface GeocodeResult {
  ok: boolean; error?: string; mode: 'offline' | 'online';
  total: number; resolved: number; unresolved: number;
  byTier: Record<GeoTier, number>; points: GeoPoint[];
}

export type Entity = 'orders' | 'vehicles' | 'routes';
export interface CanonicalField { field: string; type: string; required: boolean; label: string; hint?: string; aliases: string[] }
export interface UploadResult { uploadId: string; entity: Entity; headers: string[]; rows: string[][]; totalRows: number; delimiter: string; suggested: Record<string, number> }
export interface OnboardPreview {
  ok: boolean;
  error?: string;
  reconcile: { provenanceOk: boolean; rowsReconciled: number; fieldsVerified: string[]; mismatches: number; mismatchSamples: string[] };
  semantic: { errors: number; warnings: number; info: number; items: { level: string; kind: string; count: number }[] };
  canonical: { count: number; sample: Record<string, unknown>[] };
}

export interface ImportSummary {
  sources: { kind: string; label: string; file: string; present: boolean; sha256: string | null; rawRows: number }[];
  canonical: { orders: { count: number | null; sourceSha256: string | null; audit: { rows_processed?: number; rows_accepted?: number; rows_rejected?: number; validation?: { errors?: number; warnings?: number } } | null } };
  pipeline: { stage: string; detail: string }[];
  rules: string[];
  scope: { rawOrderLines: number; inScopeHungarian: number; day1: number; day2: number };
}
export interface PlanSummary {
  id: string; scenarioId: string; day: string | null; label: string;
  source: 'saved' | 'live' | 'sample'; createdAt: string; termination: string;
  servedOrders: number; totalOrders: number; vehiclesUsed: number; totalDistanceKm: number;
}
export interface WeekVehicleDay { trips: number; km: number; cost: number | null; finishSec: number }
export interface WeekVehicleRow {
  ref: string; vehicleClass: string | null; isSubcontractor: boolean;
  perDay: Record<string, WeekVehicleDay | null>;
  totalTrips: number; totalKm: number; totalCost: number | null; daysWorked: number;
}
export interface WeekSummary {
  currency: string;
  days: { dayId: string; isoDate: string; label: string; servedOrders: number; totalOrders: number; vehiclesUsed: number; trips: number; totalDistanceKm: number; costTotal: number | null }[];
  totals: { servedOrders: number; totalOrders: number; vehiclesUsed: number; trips: number; totalDistanceKm: number; costTotal: number | null };
  vehicles: WeekVehicleRow[];
}

export interface RawSample { label: string; headers: string[]; rows: string[][]; totalRows: number }
export interface CanonicalSample { fields: string[]; rows: Record<string, unknown>[]; count: number; sha256: string | null }

/** Poll a job to a terminal state, reporting each tick. Honors an AbortSignal. */
export async function pollJob(
  jobId: string,
  onTick: (job: Job) => void,
  opts: { intervalMs?: number; signal?: AbortSignal } = {},
): Promise<Job> {
  const interval = opts.intervalMs ?? 1200;
  const maxTransientFailures = 5;      // tolerate brief blips; don't abort a healthy server-side job
  let failures = 0;
  for (;;) {
    if (opts.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    let job: Job;
    try {
      job = await api.job(jobId);
      failures = 0;
    } catch (e) {
      // A network blip or a transient 5xx shouldn't kill the whole solve view.
      if (++failures > maxTransientFailures) throw e;
      await new Promise((res) => setTimeout(res, interval));
      continue;
    }
    onTick(job);
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') return job;
    await new Promise((res) => setTimeout(res, interval));
  }
}
