import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from '../config.js';
import { admitDataset } from '../data/admit.js';
import { enrichmentFromRecords, loadVehicleInfo, type LoadedDay } from '../data/dataset.js';
import type { Mapping } from '../data/onboard.js';
import { applyOverrides, applySequences, applyVehicleOverrides, type Objective } from '../solve.js';
import { mapSolutionToPlan } from '../plan/mapper.js';
import { fillPlanGeometry } from '../geometry/velo.js';
import type { Plan, SurgeRequest, SurgeSolution } from '../types.js';
import type { Scenario } from '../store.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { ImmutableObject, ObjectStore } from './objects.js';
import { StaleFenceError, type Lease, type StatefulStore } from './postgres.js';
import { nativeSolveRequest } from './solver-ids.js';
import { applyAccessLimits } from '../plan/access.js';
import { withPlanningPolicy } from '../plan/policy.js';
import { populationConfig } from '../solver-config.js';
import { tariffIdentity } from '../cost.js';
import { applyRetainedDecisions, datasetAllowances, verifyRetainedSolution, withRetainedProvenance } from '../plan/retained.js';

const OUTPUT_SCHEMA_VERSION = 1;
const run = promisify(execFile);
export interface ConversionPayload { datasetId: string; source: ImmutableObject; sourceName: string; mapping: Mapping; label: string;
  fleet?: { source: ImmutableObject; sourceName: string; mapping: Mapping } }
export interface ConversionOutput { datasetId: string; fingerprint: string; manifest: Record<string, unknown>; artifacts: ImmutableObject[] }

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') { const record = value as Record<string, unknown>; return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${stable(record[k])}`).join(',')}}`; }
  return JSON.stringify(value);
}
async function fileDigest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function conversionIdentity(payload: ConversionPayload): Promise<{ fingerprint: string; converters: Record<string, string> }> {
  const paths = { nexus: resolve(config.nexusDir, 'nx_pipeline'), geocoder: resolve(config.nexusDir, 'scripts/geocode_verify.py'),
    routingGraph: config.veloGraph, matrix: config.matrixBuildBin };
  const converters: Record<string, string> = {};
  for (const [name, path] of Object.entries(paths)) converters[name] = await fileDigest(path);
  const identity = { source: payload.source.sha256, mapping: payload.mapping, fleet: payload.fleet ? { source: payload.fleet.source.sha256, mapping: payload.fleet.mapping } : null, converters,
    matrix: { profile: config.veloProfile, maxLocations: config.maxMatrixLocations }, outputSchemaVersion: OUTPUT_SCHEMA_VERSION,
    fleetEncodingVersion: 3 }; // preserves explicit GVW and tail-lift capabilities in uploaded fleets
  return { fingerprint: createHash('sha256').update(stable(identity)).digest('hex'), converters };
}

/** Execute the actual Nexus -> geocoder -> Velo matrix pipeline. All mutable
 * files are scratch; only checksum-addressed output objects survive. */
export async function executeDatasetConversion(lease: Lease, objects: ObjectStore, signal: AbortSignal): Promise<ConversionOutput> {
  const payload = lease.payload as ConversionPayload;
  if (!payload?.datasetId || !payload.source?.sha256 || !payload.mapping) throw new Error('invalid dataset conversion payload');
  const identity = await conversionIdentity(payload);
  const workspace = await mkdtemp(join(tmpdir(), 'cursus-admit-'));
  try {
    if (signal.aborted) throw new Error('conversion lease lost');
    const sourceBytes = await objects.getVerified(payload.source);
    const sourcePath = join(workspace, basename(payload.sourceName || 'upload.csv'));
    await writeFile(sourcePath, sourceBytes, { mode: 0o600 });
    let fleetSource: { path: string; mapping: Mapping } | undefined;
    if (payload.fleet) {
      const fleetPath = join(workspace, basename(payload.fleet.sourceName || 'vehicles.csv'));
      await writeFile(fleetPath, await objects.getVerified(payload.fleet.source), { mode: 0o600 });
      fleetSource = { path: fleetPath, mapping: payload.fleet.mapping };
    }
    const result = await admitDataset(sourcePath, payload.mapping, payload.label, undefined, fleetSource,
      { workspaceRoot: workspace, datasetId: payload.datasetId, register: false, signal });
    if (!result.ok) throw new Error(result.error ?? 'dataset conversion failed');
    if (signal.aborted) throw new Error('conversion lease lost');
    const outputDir = join(workspace, payload.datasetId);
    const request = await objects.putImmutable(lease.tenantId, await readFile(join(outputDir, 'request.json')), 'application/json');
    const geocoded = await objects.putImmutable(lease.tenantId, await readFile(join(outputDir, 'orders.geocoded.json')), 'application/json');
    const artifacts = [payload.source, request, geocoded];
    return { datasetId: payload.datasetId, fingerprint: identity.fingerprint, artifacts,
      manifest: { schemaVersion: OUTPUT_SCHEMA_VERSION, conversionFingerprint: identity.fingerprint, converters: identity.converters,
        source: payload.source, artifacts: { request, geocoded }, label: payload.label, days: result.days, stats: result } };
  } finally { await rm(workspace, { recursive: true, force: true }); }
}

export async function workOneDatasetAdmission(store: StatefulStore, objects: ObjectStore, workerId: string, leaseSeconds = 120): Promise<boolean> {
  const lease = await store.claimJob('dataset-admit', workerId, leaseSeconds); if (!lease) return false;
  const abort = new AbortController();
  let heartbeating = false;
  const heartbeat = setInterval(() => {
    if (heartbeating) return;
    heartbeating = true;
    void store.heartbeatJob(lease, leaseSeconds).catch(() => abort.abort()).finally(() => { heartbeating = false; });
  }, Math.max(1000, leaseSeconds * 500));
  try {
    const output = await executeDatasetConversion(lease, objects, abort.signal);
    // Staging is deliberately outside the admission transaction. If this
    // worker loses its fence, artifacts remain non-visible but discoverable.
    for (const artifact of output.artifacts) await store.stageObject(lease.tenantId, artifact);
    await store.completeDatasetAdmission(lease, output.datasetId, output.manifest, output.artifacts);
  } catch (error) {
    if (!(error instanceof StaleFenceError)) try { await store.failJob(lease, (error as Error).message); } catch { /* a newer fence owns it */ }
    throw error;
  } finally { clearInterval(heartbeat); }
  return true;
}

/** Solve directly from admitted immutable artifacts; no node-local registry is
 * authoritative. This is the stateful counterpart of loadDay/buildRequest. */
export interface ConvertedManifest { artifacts?: { request?: ImmutableObject; geocoded?: ImmutableObject };
  days?: { dayId: string; date?: string; isoDate: string; label: string }[] }
export async function loadConvertedDay(objects: ObjectStore, tenantId: string, manifest: ConvertedManifest,
  scenario: Scenario): Promise<LoadedDay> {
  const requestObject = manifest?.artifacts?.request as ImmutableObject | undefined;
  const geoObject = manifest?.artifacts?.geocoded as ImmutableObject | undefined;
  if (!requestObject || !geoObject) throw new Error('admitted dataset artifacts are incomplete');
  const prefix = `tenants/${tenantId}/sha256/`;
  if (!requestObject.key.startsWith(prefix) || !geoObject.key.startsWith(prefix)) throw new Error('dataset artifact is outside the tenant namespace');
  const [requestBytes, geoBytes] = await Promise.all([objects.getVerified(requestObject), objects.getVerified(geoObject)]);
  const request = JSON.parse(new TextDecoder().decode(requestBytes)) as SurgeRequest;
  const geoJson = JSON.parse(new TextDecoder().decode(geoBytes)) as { records?: Record<string, unknown>[] } | Record<string, unknown>[];
  const rows = Array.isArray(geoJson) ? geoJson : geoJson.records ?? [];
  const dayMeta = manifest.days?.find((d) => d.dayId === scenario.day) ?? manifest.days?.[0];
  if (!dayMeta) throw new Error('dataset day is missing');
  const refs = new Set(rows.filter((r) => String(r.delivery_date ?? '') === String(dayMeta.date ?? dayMeta.isoDate))
    .map((r) => String(r.order_no)));
  const taskRef = new Map(request.tasks.map((t) => [t.id, String(t.ref)]));
  request.requests = request.requests.filter((r) => !refs.size || refs.has(taskRef.get(r.delivery_task_id) ?? ''));
  const scopedReqIds = request.requests.map((r) => r.id);
  const solution: SurgeSolution = { status: 'OK', routes: [], unassigned: scopedReqIds,
    stats: { vehicles_used: 0, trips: 0, total_distance: 0, unassigned: scopedReqIds.length } };
  return withPlanningPolicy({ datasetRequestSha256: requestObject.sha256,
    def: { id: dayMeta.dayId, date: dayMeta.date ?? dayMeta.isoDate, isoDate: dayMeta.isoDate, label: dayMeta.label,
    requestFile: '', solutionFile: '' }, kind: 'uploaded', request, solution,
    scopeTaskIds: new Set(request.requests.map((r) => r.delivery_task_id)),
    depot: { name: 'Depot', lon: request.locations[0]!.x, lat: request.locations[0]!.y }, enrichment: enrichmentFromRecords(rows) }, scenario.planningPolicy);
}

export async function solveConvertedDataset(objects: ObjectStore, tenantId: string, manifest: ConvertedManifest, scenario: Scenario,
  budgetSec: number, objective: Objective, signal: AbortSignal, fullBudget = false): Promise<Plan> {
  const day = await loadConvertedDay(objects, tenantId, manifest, scenario);
  const request = day.request;
  const baseline = datasetAllowances(request), datasetVehicles = request.vehicles.map(vehicle => vehicle.id);
  if (scenario.removedVehicleIds.length) request.vehicles = request.vehicles.filter((v) => !scenario.removedVehicleIds.includes(v.id));
  const available = new Set(request.vehicles.map((v) => v.id));
  applyOverrides(request, scenario, available); applyVehicleOverrides(request, scenario); applySequences(request, scenario, available);
  const retained=scenario.manualDecisions;
  if(retained&&(!retained.tariff||!retained.fleetInfo||tariffIdentity(retained.tariff)!==retained.tariffSha256))
    throw new Error('manual solve tariff/fleet snapshot is missing or inconsistent');
  const vehicleInfo = retained?.fleetInfo?new Map(retained.fleetInfo):loadVehicleInfo();
  if(retained){
    const reload=new Map(retained.reloadSeconds);
    for(const vehicle of request.vehicles){const seconds=reload.get(vehicle.id);
      if(typeof seconds!=='number'||!Number.isSafeInteger(seconds)||seconds<0||seconds>2147483647)throw new Error('manual reload snapshot is missing or invalid');
      vehicle.trip_reload_seconds=seconds;
    }
  }
  applyAccessLimits(request, day.enrichment, vehicleInfo);
  applyRetainedDecisions(request, scenario, day.datasetRequestSha256, baseline);
  request.config = populationConfig({ ...request.config, max_time_seconds: budgetSec, seed: 42, lexicographic_objective: objective !== 'distance',
    hard_capacity: true, hard_time_windows: true, hard_max_duration: true,
    ...(fullBudget ? { max_iterations: 2_000_000_000 } : {}) });
  const workspace = await mkdtemp(join(tmpdir(), 'cursus-converted-solve-'));
  try {
    const native = nativeSolveRequest(request, scenario.sequences);
    const path = join(workspace, 'request.json'); await writeFile(path, JSON.stringify(native.request), { mode: 0o600 });
    const startedAt = Date.now();
    const { stdout } = await run(config.surgeBin, [path], { signal, timeout: (budgetSec + config.solveWatchdogGraceSec) * 1000,
      maxBuffer: Math.max(1, config.maxSolveOutputMB) * 1024 * 1024 });
    const solution = native.restore(JSON.parse(stdout) as SurgeSolution);
    if (!Array.isArray(solution.routes) || !Array.isArray(solution.unassigned) || !['OK', 'LIMIT', 'INFEASIBLE'].includes(solution.status))
      throw new Error('converted dataset solve produced an invalid solution');
    verifyRetainedSolution(request, scenario, solution);
    const mapped = mapSolutionToPlan({ day, request, solution, enrichment: day.enrichment, vehicleInfo, tariff:retained?.tariff, scenarioId: scenario.id,
      scenarioRevision: scenario.revision, planId: `pln_${randomUUID().slice(0, 8)}`, source: 'live', createdAt: new Date().toISOString() });
    const plan = withRetainedProvenance(mapped, scenario, datasetVehicles);
    if(retained?.tariffSha256)plan.provenance.tariffSha256=retained.tariffSha256;
    if (scenario.planningPolicy) plan.provenance.planningPolicy = structuredClone(scenario.planningPolicy);
    plan.stats.solveElapsedSeconds = Math.round((Date.now() - startedAt) / 100) / 10;
    if (plan.provenance.validation.violations.some(v => ['VEHICLE_SIZE', 'TAIL_LIFT'].includes((v as {type?: string}).type ?? '')))
      throw new Error('solver violated mandatory destination access or tail-lift requirements');
    await fillPlanGeometry(plan).catch(() => false); return plan;
  } finally { await rm(workspace, { recursive: true, force: true }); }
}
