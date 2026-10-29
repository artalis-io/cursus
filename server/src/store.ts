import { mkdirSync, readdirSync, readFileSync, existsSync, renameSync, rmSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { writeJsonAtomic } from './util/jsonfile.js';
import type { Plan } from './types.js';
import { withNormalizedPlanStats } from './plan/stats.js';
import type { PlanningPolicy } from './plan/policy.js';
import { approvalBlockers } from './state/plan-workflow.js';

/* Minimal durable store for scenarios, plans and jobs. JSON files under the
 * local data dir (not SQLite) - fastest reliable for a single-node demo, and
 * nothing here is client-private (plans are derived, scenarios are edits).
 * Source data stays immutable and external. */

/* Manual dispatcher overrides, applied to the Surge request at solve time:
 * a pin forces an order onto one vehicle (allowed_vehicles = [vehicleId]);
 * a forbid excludes a vehicle for an order (forbidden_vehicles). Pins win over
 * forbids for the same order. Orders are keyed by order_no (stable across days). */
export interface Pin { orderNo: string; requestId?:number; vehicleId: number }
export interface Forbid { orderNo: string; requestId?:number; vehicleId: number }

/* A per-vehicle constraint override for the next replan. Unset fields keep the
 * vehicle's dataset defaults. */
export interface VehicleOverride {
  vehicleId: number;
  capacityKg?: number;
  capacityPallets?: number;
  shiftEarlySec?: number;
  shiftLateSec?: number;
  maxTrips?: number;
  maxDistanceKm?: number;
  maxDurationMin?: number;
}
export type VehicleConstraintPatch = Omit<VehicleOverride, 'vehicleId'>;

/* A manual stop order for one vehicle: the listed orders are kept on that
 * vehicle and solved in this sequence (via allowed_vehicles + precedence).
 * `locked` additionally forbids every other order from the vehicle, freezing
 * its route exactly (lock-and-resolve); the rest re-solves around it. */
export interface VehicleSequence { vehicleId: number; orderNos: string[]; requestIds?:number[]; locked?: boolean }
export const MAX_SEQUENCE_LEN = 500;

export interface Scenario {
  deliveryDatasetSha256?:string;
  selectedPlanId?: string;
  selectionVersion?: number;
  manualPlanId?: string;
  manualDecisions?: { datasetSha256: string; decisions: Record<string, import('./plan/manual.js').ManualDecision>;
    requestIds?: number[];
    tariff?: import('./cost.js').Tariff; tariffSha256?:string; fleetInfo?:[string, import('./data/dataset.js').VehicleInfo][];
    reloadSeconds?:[number,number][];
    unavailableVehicleIds?:number[];
    origins?: Record<string, import('./plan/manual.js').AssignmentOrigin>; history?: import('./plan/manual.js').AssignmentEvent[] };
  planningPolicy?: PlanningPolicy;
  id: string;
  day: string;            // 'day1' | 'day2'
  kind: 'base' | 'copy';
  parentId: string | null;
  revision: number;       // bumped on each edit
  label: string;
  removedVehicleIds: number[];
  pins: Pin[];
  forbids: Forbid[];
  vehicleOverrides: VehicleOverride[];
  sequences: VehicleSequence[];
  createdAt: string;
}

/* A single dispatcher edit applied to an editable (copy) scenario. All edits
 * stack on the scenario and take effect together on the next Replan. */
export type ScenarioEdit = (
  | { op: 'removeVehicle'; vehicleId: number }
  | { op: 'restoreVehicle'; vehicleId: number }
  | { op: 'pin'; orderNo: string; requestId?:number; vehicleId: number }
  | { op: 'unpin'; orderNo: string; requestId?:number }
  | { op: 'forbid'; orderNo: string; requestId?:number; vehicleId: number }
  | { op: 'unforbid'; orderNo: string; requestId?:number; vehicleId: number }
  | { op: 'setVehicleConstraint'; vehicleId: number; patch: VehicleConstraintPatch }
  | { op: 'clearVehicleConstraint'; vehicleId: number }
  | { op: 'setSequence'; vehicleId: number; orderNos: string[]; requestIds?:number[]; locked?: boolean }
  | { op: 'clearSequence'; vehicleId: number }
  | { op: 'clearOverrides' }) & {datasetSha256?:string};

/* Validate + bounds-check an untrusted edit from the API. Returns an error
 * message, or null if the edit is well-formed and in range. */
const CONSTRAINT_BOUNDS: Record<keyof VehicleConstraintPatch, [number, number]> = {
  capacityKg: [0, 200_000], capacityPallets: [0, 100],
  shiftEarlySec: [0, 86_400], shiftLateSec: [0, 86_400],
  maxTrips: [1, 50], maxDistanceKm: [0, 10_000], maxDurationMin: [0, 1_440],
};
export function validateScenarioEdit(edit: unknown): string | null {
  if (!edit || typeof edit !== 'object') return 'edit object required';
  const e = edit as Record<string, unknown>;
  const isVid = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1e9;
  const isOrder = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64;
  if(e.requestId!==undefined&&!isVid(e.requestId))return 'valid requestId required';
  if((e.requestId!==undefined||e.requestIds!==undefined)&&!(/^[a-f0-9]{64}$/.test(String(e.datasetSha256??''))))return 'Dataset checksum required for stable delivery identities';
  switch (e.op) {
    case 'removeVehicle': case 'restoreVehicle': case 'clearVehicleConstraint': case 'clearSequence':
      return isVid(e.vehicleId) ? null : 'valid vehicleId required';
    case 'setSequence': {
      if (!isVid(e.vehicleId)) return 'valid vehicleId required';
      if (!Array.isArray(e.orderNos)) return 'orderNos array required';
      if (e.orderNos.length > MAX_SEQUENCE_LEN) return `too many orders (> ${MAX_SEQUENCE_LEN})`;
      if (!e.orderNos.every(isOrder)) return 'orderNos must be valid order numbers';
      if(e.requestIds!==undefined&&(!Array.isArray(e.requestIds)||e.requestIds.length!==e.orderNos.length||!e.requestIds.every(isVid)||new Set(e.requestIds).size!==e.requestIds.length))return 'requestIds must uniquely identify each order';
      if (e.requestIds===undefined&&new Set(e.orderNos).size !== e.orderNos.length) return 'orderNos must be unique';
      if (e.locked != null && typeof e.locked !== 'boolean') return 'locked must be a boolean';
      return null;
    }
    case 'pin': case 'forbid': case 'unforbid':
      return isOrder(e.orderNo) && isVid(e.vehicleId) ? null : 'valid orderNo and vehicleId required';
    case 'unpin':
      return isOrder(e.orderNo) ? null : 'valid orderNo required';
    case 'clearOverrides':
      return null;
    case 'setVehicleConstraint': {
      if (!isVid(e.vehicleId)) return 'valid vehicleId required';
      const patch = e.patch;
      if (!patch || typeof patch !== 'object') return 'patch object required';
      for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
        if (v == null) continue; // clearing a field
        const bounds = CONSTRAINT_BOUNDS[k as keyof VehicleConstraintPatch];
        if (!bounds) return `unknown constraint: ${k}`;
        if (typeof v !== 'number' || !Number.isFinite(v) || v < bounds[0] || v > bounds[1]) return `${k} must be ${bounds[0]}..${bounds[1]}`;
      }
      return null;
    }
    default:
      return `unknown edit op: ${String(e.op)}`;
  }
}

/** Apply already-validated edits to an isolated scenario value. Persistence
 * adapters use this common domain operation so legacy and PostgreSQL modes do
 * not drift in dispatcher semantics. */
export function applyScenarioEdits(scenario: Scenario, edits: ScenarioEdit[]): Scenario {
  const same=(a:{orderNo:string;requestId?:number},b:{orderNo:string;requestId?:number})=>a.orderNo===b.orderNo&&a.requestId===b.requestId;
  const s = structuredClone(scenario);
  if (s.kind === 'base') throw new Error('base scenario is immutable; fork a copy first');
  for (const edit of edits) {
    if(edit.datasetSha256){
      if(s.deliveryDatasetSha256&&s.deliveryDatasetSha256!==edit.datasetSha256)throw new Error('Delivery dataset changed');
      s.deliveryDatasetSha256=edit.datasetSha256;
    }
    switch (edit.op) {
      case 'removeVehicle':
        if (!s.removedVehicleIds.includes(edit.vehicleId)) s.removedVehicleIds.push(edit.vehicleId);
        s.pins = s.pins.filter((p) => p.vehicleId !== edit.vehicleId);
        s.vehicleOverrides = s.vehicleOverrides.filter((o) => o.vehicleId !== edit.vehicleId);
        s.sequences = s.sequences.filter((q) => q.vehicleId !== edit.vehicleId); break;
      case 'restoreVehicle': s.removedVehicleIds = s.removedVehicleIds.filter((v) => v !== edit.vehicleId); break;
      case 'setVehicleConstraint': {
        const old = s.vehicleOverrides.find((o) => o.vehicleId === edit.vehicleId);
        const merged: VehicleOverride = { ...(old ?? { vehicleId: edit.vehicleId }), ...edit.patch };
        for (const k of Object.keys(edit.patch) as (keyof VehicleConstraintPatch)[]) if (edit.patch[k] == null) delete merged[k];
        const rest = s.vehicleOverrides.filter((o) => o.vehicleId !== edit.vehicleId);
        s.vehicleOverrides = Object.keys(merged).length > 1 ? [...rest, merged] : rest; break;
      }
      case 'clearVehicleConstraint': s.vehicleOverrides = s.vehicleOverrides.filter((o) => o.vehicleId !== edit.vehicleId); break;
      case 'setSequence': {
        const rest = s.sequences.filter((q) => q.vehicleId !== edit.vehicleId);
        const keep = edit.orderNos.length >= 2 || Boolean(edit.locked && edit.orderNos.length);
        s.sequences = keep ? [...rest, { vehicleId: edit.vehicleId, orderNos: [...edit.orderNos],...(edit.requestIds?{requestIds:[...edit.requestIds]}:{}), ...(edit.locked ? { locked: true } : {}) }] : rest; break;
      }
      case 'clearSequence': s.sequences = s.sequences.filter((q) => q.vehicleId !== edit.vehicleId); break;
      case 'pin': s.pins = [...s.pins.filter(p=>!same(p,edit)), { orderNo: edit.orderNo,...(edit.requestId===undefined?{}:{requestId:edit.requestId}), vehicleId: edit.vehicleId }]; s.forbids = s.forbids.filter(f=>!same(f,edit)); break;
      case 'unpin': s.pins = s.pins.filter(p=>!same(p,edit)); break;
      case 'forbid': if (!s.forbids.some(f=>same(f,edit)&&f.vehicleId===edit.vehicleId)) s.forbids.push({orderNo:edit.orderNo,...(edit.requestId===undefined?{}:{requestId:edit.requestId}),vehicleId:edit.vehicleId}); s.pins = s.pins.filter(p=>!(same(p,edit)&&p.vehicleId===edit.vehicleId)); break;
      case 'unforbid': s.forbids = s.forbids.filter(f=>!(same(f,edit)&&f.vehicleId===edit.vehicleId)); break;
      case 'clearOverrides': s.pins = []; s.forbids = []; s.sequences = []; break;
    }
  }
  s.revision += 1;
  return s;
}

/* A portable scenario: its edits + day + label, shareable as JSON so a colleague
 * can import it to recreate the same what-if (there is no multi-user store). */
export interface ScenarioEditsBundle {
  deliveryDatasetSha256?:string;
  planningPolicyId?: string; // reference only; never grants new approval
  removedVehicleIds: number[];
  pins: Pin[];
  forbids: Forbid[];
  vehicleOverrides: VehicleOverride[];
  sequences: VehicleSequence[];
}
export interface ScenarioExport { otto_scenario: 1; day: string; label: string; edits: ScenarioEditsBundle }

export function exportScenario(s: Scenario): ScenarioExport {
  return {
    otto_scenario: 1, day: s.day, label: s.label,
    edits: {
      ...(s.deliveryDatasetSha256?{deliveryDatasetSha256:s.deliveryDatasetSha256}:{}),
      ...(s.planningPolicy ? { planningPolicyId: s.planningPolicy.id } : {}),
      removedVehicleIds: [...s.removedVehicleIds],
      pins: s.pins.map((p) => ({ ...p })),
      forbids: s.forbids.map((f) => ({ ...f })),
      vehicleOverrides: s.vehicleOverrides.map((o) => ({ ...o })),
      sequences: s.sequences.map((q) => ({ vehicleId: q.vehicleId, orderNos: [...q.orderNos],...(q.requestIds?{requestIds:[...q.requestIds]}:{}), ...(q.locked ? { locked: true } : {}) })),
    },
  };
}

/* Validate an untrusted imported scenario bundle. Returns an error message or
 * a cleaned edits bundle. */
export function parseScenarioImport(body: unknown): { error: string } | { day: string; label: string; edits: ScenarioEditsBundle } {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== 'object') return { error: 'scenario object required' };
  if (b.otto_scenario !== 1) return { error: 'not an OTTO scenario export' };
  const day = b.day;
  if (typeof day !== 'string' || day.length === 0 || day.length > 64) return { error: 'valid day required' };
  const label = typeof b.label === 'string' && b.label.length <= 120 ? b.label : 'Imported scenario';
  const e = (b.edits ?? {}) as Record<string, unknown>;
  const isVid = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1e9;
  const isOrder = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64;
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const removedVehicleIds = arr(e.removedVehicleIds).filter(isVid);
  if([...arr(e.pins),...arr(e.forbids)].some(p=>p&&typeof p==='object'&&'requestId' in p&&p.requestId!==undefined&&!isVid(p.requestId)))return {error:'Invalid imported delivery identity'};
  const stableRef=(p:Pin|Forbid)=>p.requestId===undefined?{}:{requestId:p.requestId};
  const pins: Pin[] = arr(e.pins).filter((p): p is Pin => !!p && isOrder((p as Pin).orderNo) && isVid((p as Pin).vehicleId)).map(p=>({orderNo:p.orderNo,vehicleId:p.vehicleId,...stableRef(p)}));
  const forbids: Forbid[] = arr(e.forbids).filter((f): f is Forbid => !!f && isOrder((f as Forbid).orderNo) && isVid((f as Forbid).vehicleId)).map(f=>({orderNo:f.orderNo,vehicleId:f.vehicleId,...stableRef(f)}));
  const vehicleOverrides: VehicleOverride[] = [];
  for (const o of arr(e.vehicleOverrides)) {
    const ov = o as VehicleOverride;
    if (!ov || !isVid(ov.vehicleId)) continue;
    const clean: VehicleOverride = { vehicleId: ov.vehicleId };
    for (const [k, bounds] of Object.entries(CONSTRAINT_BOUNDS)) {
      const val = (ov as unknown as Record<string, unknown>)[k];
      if (typeof val === 'number' && Number.isFinite(val) && val >= bounds[0] && val <= bounds[1]) (clean as unknown as Record<string, unknown>)[k] = val;
    }
    if (Object.keys(clean).length > 1) vehicleOverrides.push(clean);
  }
  const sequences: VehicleSequence[] = [];
  for (const q of arr(e.sequences)) {
    const sq = q as VehicleSequence;
    if (!sq || !isVid(sq.vehicleId) || !Array.isArray(sq.orderNos)) continue;
    const orderNos = sq.orderNos.filter(isOrder).slice(0, MAX_SEQUENCE_LEN);
    if(sq.requestIds!==undefined&&(!Array.isArray(sq.requestIds)||sq.requestIds.length!==orderNos.length||!sq.requestIds.every(isVid)||new Set(sq.requestIds).size!==sq.requestIds.length))return {error:'Invalid sequence identities'};
    if (!sq.requestIds&&new Set(orderNos).size !== orderNos.length) continue;
    if (orderNos.length >= 2 || (sq.locked && orderNos.length >= 1)) sequences.push({ vehicleId: sq.vehicleId, orderNos,...(sq.requestIds?{requestIds:[...sq.requestIds]}:{}), ...(sq.locked ? { locked: true } : {}) });
  }
  if (e.planningPolicyId !== undefined && (typeof e.planningPolicyId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(e.planningPolicyId)))
    return { error: 'invalid planning policy reference' };
  if(e.deliveryDatasetSha256!==undefined&&!/^[a-f0-9]{64}$/.test(String(e.deliveryDatasetSha256)))return {error:'Invalid delivery dataset checksum'};
  if((pins.some(p=>p.requestId!==undefined)||forbids.some(p=>p.requestId!==undefined)||sequences.some(s=>s.requestIds))&&!e.deliveryDatasetSha256)return {error:'Dataset checksum required for delivery identities'};
  return { day, label, edits: { removedVehicleIds, pins, forbids, vehicleOverrides, sequences,...(typeof e.deliveryDatasetSha256==='string'?{deliveryDatasetSha256:e.deliveryDatasetSha256}:{}),
    ...(typeof e.planningPolicyId === 'string' ? { planningPolicyId: e.planningPolicyId } : {}) } };
}

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface Job {
  id: string;
  scenarioId: string;
  scenarioRevision: number;
  status: JobStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  elapsedSec: number;
  planId: string | null;
  termination: string | null;
  error: string | null;
  kind?: 'solve' | 'import';   // 'import' = dataset admit (geocode/matrix/request)
  stage?: string;              // coarse progress stage for import jobs
  result?: unknown;            // the admit result on completion
}

function dir(sub: string): string {
  const d = resolve(config.dataDir, sub);
  mkdirSync(d, { recursive: true });
  return d;
}
/* Atomic write: a crash mid-write leaves the old file intact (temp + rename),
 * never a half-written/corrupt JSON. Shared with registry/geocache via util. */
const writeJson = writeJsonAtomic;
function isJobRequestFile(f: string): boolean { return f.endsWith('_request.json'); }
function loadAll<T>(sub: string): Map<string, T> {
  const m = new Map<string, T>();
  const d = dir(sub);
  if (!existsSync(d)) return m;
  for (const f of readdirSync(d)) {
    if (f.endsWith('.tmp')) { try { rmSync(join(d, f)); } catch { /* ignore */ } continue; } // stale temp from a crash
    if (!f.endsWith('.json') || isJobRequestFile(f)) continue;
    const fp = join(d, f);
    try {
      const o = JSON.parse(readFileSync(fp, 'utf8')) as { id?: string };
      if (o.id) m.set(o.id, o as T);
    } catch {
      // Quarantine rather than silently drop, so a corrupt file is visible.
      try { renameSync(fp, `${fp}.corrupt`); } catch { /* ignore */ }
      console.warn(`[store] quarantined unreadable ${sub} file: ${f}`);
    }
  }
  return m;
}

export class Store {
  scenarios = loadAll<Scenario>('scenarios');
  jobs = loadAll<Job>('jobs');
  plans = new Map<string, Plan>();          // in-memory (baselines + live)
  private persistedPlans = loadAll<Plan>('plans');

  constructor() {
    for (const [id, p] of this.persistedPlans) this.plans.set(id, p);
    // Normalize scenarios persisted before overrides existed.
    for (const s of this.scenarios.values()) {
      if (!Array.isArray(s.pins)) s.pins = [];
      if (!Array.isArray(s.forbids)) s.forbids = [];
      if (!Array.isArray(s.vehicleOverrides)) s.vehicleOverrides = [];
      if (!Array.isArray(s.sequences)) s.sequences = [];
    }
    this.reconcileInterruptedJobs();  // no subprocess survives a restart
    this.gcPlans(); this.gcJobs(); this.gcScenarios(); // prune any backlog left from prior runs
  }

  /* A1: jobs persisted as pending/running have no live subprocess after a
   * restart (the queue + child handles are in-memory only). Left as-is they
   * stay "running" forever and clients poll them indefinitely. Mark them
   * failed on boot so the UI sees a terminal state. */
  private reconcileInterruptedJobs(): void {
    const now = new Date().toISOString();
    for (const j of this.jobs.values()) {
      if (j.status === 'running' || j.status === 'pending') {
        j.status = 'failed';
        j.error = 'interrupted by a server restart';
        j.finishedAt = now;
        this.saveJob(j);
      }
    }
  }

  /* Retention: keep at most `keep` of the oldest primary files in a dir (by
   * mtime), returning the removed base names. */
  private pruneDir(sub: string, keep: number, isPrimary: (f: string) => boolean): string[] {
    const d = dir(sub);
    let files: string[];
    try { files = readdirSync(d).filter((f) => f.endsWith('.json') && !f.endsWith('.corrupt') && isPrimary(f)); } catch { return []; }
    if (files.length <= keep) return [];
    const withT = files.map((f) => { let t = 0; try { t = statSync(join(d, f)).mtimeMs; } catch { /* ignore */ } return { f, t }; });
    withT.sort((a, b) => a.t - b.t); // oldest first
    const removed: string[] = [];
    for (const { f } of withT.slice(0, withT.length - keep)) {
      try { rmSync(join(d, f), { force: true }); removed.push(f); } catch { /* ignore */ }
    }
    return removed;
  }

  gcPlans(): void {
    const selected = new Set([...this.scenarios.values()].map(s => s.selectedPlanId).filter(Boolean));
    for (const f of this.pruneDir('plans', Math.max(1, config.retainPlans), f => !selected.has(f.replace(/\.json$/, '')))) {
      this.plans.delete(f.replace(/\.json$/, ''));
    }
  }
  gcJobs(): void {
    const d = dir('jobs');
    for (const f of this.pruneDir('jobs', Math.max(1, config.retainJobs), (x) => !isJobRequestFile(x))) {
      const id = f.replace(/\.json$/, '');
      this.jobs.delete(id);
      try { rmSync(join(d, `${id}_request.json`), { force: true }); } catch { /* ignore */ }
    }
  }
  /* Prune old what-if copies (ids start with 'scn_'); base scenarios (<day>-base)
   * are never counted or pruned. Scenarios referenced by a non-terminal job (a
   * queued/running solve holds the job + a reference) are also skipped, so GC
   * can't orphan an in-flight result. Without this, every forked edit accumulates. */
  gcScenarios(): void {
    const live = new Set([...this.jobs.values()].filter((j) => j.status === 'pending' || j.status === 'running').map((j) => j.scenarioId));
    for (const f of this.pruneDir('scenarios', Math.max(1, config.retainScenarios), (x) => x.startsWith('scn_') && !live.has(x.replace(/\.json$/, '')))) {
      this.scenarios.delete(f.replace(/\.json$/, ''));
    }
  }

  newId(prefix: string): string { return `${prefix}_${randomUUID().slice(0, 8)}`; }
  selectPlan(scenarioId:string,revision:number,planId:string,version:number,acknowledgeIncomplete:boolean):Scenario {
    const s=this.scenarios.get(scenarioId),p=this.plans.get(planId);
    if(!s||!p)throw new Error('Plan or scenario not found');
    if(s.revision!==revision||(s.selectionVersion??0)!==version||p.scenarioId!==s.id||p.scenarioRevision!==revision)throw new Error('Scenario or plan selection changed');
    if(p.stats.servedOrders+p.unassigned.length!==p.stats.totalOrders)throw new Error('Candidate coverage is inconsistent');
    const issues=approvalBlockers(p,revision,s),coverage='Approval requires complete, consistent order coverage.';
    if(issues.some(x=>x!==coverage)||issues.includes(coverage)&&!acknowledgeIncomplete)throw new Error(issues.join(' '));
    const updated={...s,selectedPlanId:planId,selectionVersion:version+1};
    writeJson(join(dir('scenarios'),`${s.id}.json`),updated);this.scenarios.set(s.id,updated);return updated;
  }

  /* Idempotent base scenario per day (immutable, revision 0). */
  ensureBaseScenario(day: string, label: string): Scenario {
    const id = `${day}-base`;
    let s = this.scenarios.get(id);
    if (!s) {
      s = { id, day, kind: 'base', parentId: null, revision: 0, label, removedVehicleIds: [], pins: [], forbids: [], vehicleOverrides: [], sequences: [], createdAt: new Date().toISOString() };
      this.scenarios.set(id, s);
      writeJson(join(dir('scenarios'), `${id}.json`), s);
    }
    return s;
  }

  createCopy(parent: Scenario, edits: { removeVehicleId?: number }, label?: string): Scenario {
    const removed = [...parent.removedVehicleIds];
    if (edits.removeVehicleId != null && !removed.includes(edits.removeVehicleId)) removed.push(edits.removeVehicleId);
    const s: Scenario = {
      ...(parent.deliveryDatasetSha256?{deliveryDatasetSha256:parent.deliveryDatasetSha256}:{}),
      ...(parent.planningPolicy ? { planningPolicy: structuredClone(parent.planningPolicy) } : {}),
      id: this.newId('scn'),
      day: parent.day,
      kind: 'copy',
      parentId: parent.id,
      revision: 1,
      label: label ?? `${parent.label} (edited)`,
      removedVehicleIds: removed,
      pins: parent.pins.map((p) => ({ ...p })),
      forbids: parent.forbids.map((f) => ({ ...f })),
      vehicleOverrides: parent.vehicleOverrides.map((o) => ({ ...o })),
      sequences: parent.sequences.map(q=>structuredClone(q)),
      createdAt: new Date().toISOString(),
    };
    this.scenarios.set(s.id, s);
    writeJson(join(dir('scenarios'), `${s.id}.json`), s);
    if (this.scenarios.size > config.retainScenarios + 20) this.gcScenarios(); // cheap trigger
    return s;
  }

  /** Return an editable (copy) scenario for the given one: copies forked from an
   * immutable base so the baseline is never mutated; copies are edited in place. */
  forkForEdit(current: Scenario, label?: string): Scenario {
    if (current.kind === 'copy') return current;
    return this.createCopy(current, {}, label);
  }

  /** Apply a dispatcher edit to an editable scenario, bump its revision, persist.
   * Throws on a base scenario (immutable). Returns the updated scenario. */
  editScenario(id: string, edit: ScenarioEdit): Scenario {
    return this.editScenarioBatch(id, [edit]);
  }

  /** Apply several edits to an editable scenario atomically: all mutate the same
   * scenario, then one revision bump + one persist. Used by bulk actions. */
  editScenarioBatch(id: string, edits: ScenarioEdit[]): Scenario {
    const s = this.scenarios.get(id);
    if (!s) throw new Error('scenario not found');
    if (s.kind === 'base') throw new Error('base scenario is immutable; fork a copy first');
    for (const edit of edits) this.applyEditInPlace(s, edit);
    s.revision += 1;
    this.scenarios.set(s.id, s);
    writeJson(join(dir('scenarios'), `${s.id}.json`), s);
    return s;
  }

  /** Mutate a scenario object by one edit (no revision bump, no persist). */
  private applyEditInPlace(s: Scenario, edit: ScenarioEdit): void {
    switch (edit.op) {
      case 'removeVehicle':
        if (!s.removedVehicleIds.includes(edit.vehicleId)) s.removedVehicleIds.push(edit.vehicleId);
        // orders cannot be pinned/sequenced to, nor constraints set on, a removed vehicle
        s.pins = s.pins.filter((p) => p.vehicleId !== edit.vehicleId);
        s.vehicleOverrides = s.vehicleOverrides.filter((o) => o.vehicleId !== edit.vehicleId);
        s.sequences = s.sequences.filter((q) => q.vehicleId !== edit.vehicleId);
        break;
      case 'restoreVehicle':
        s.removedVehicleIds = s.removedVehicleIds.filter((v) => v !== edit.vehicleId);
        break;
      case 'setVehicleConstraint': {
        const existing = s.vehicleOverrides.find((o) => o.vehicleId === edit.vehicleId);
        const merged: VehicleOverride = { ...(existing ?? { vehicleId: edit.vehicleId }), ...edit.patch };
        // drop keys explicitly set to undefined/null so they revert to default
        for (const k of Object.keys(edit.patch) as (keyof VehicleConstraintPatch)[]) {
          if (edit.patch[k] == null) delete merged[k];
        }
        const rest = s.vehicleOverrides.filter((o) => o.vehicleId !== edit.vehicleId);
        // keep only if it still constrains something beyond the id
        s.vehicleOverrides = Object.keys(merged).length > 1 ? [...rest, merged] : rest;
        break;
      }
      case 'clearVehicleConstraint':
        s.vehicleOverrides = s.vehicleOverrides.filter((o) => o.vehicleId !== edit.vehicleId);
        break;
      case 'setSequence': {
        const rest = s.sequences.filter((q) => q.vehicleId !== edit.vehicleId);
        // a sequence of <2 orders carries no ordering -> treat as clear (unless
        // locked: a 1-stop vehicle can still be frozen)
        const keep = edit.orderNos.length >= 2 || (edit.locked && edit.orderNos.length >= 1);
        s.sequences = keep ? [...rest, { vehicleId: edit.vehicleId, orderNos: [...edit.orderNos], ...(edit.locked ? { locked: true } : {}) }] : rest;
        break;
      }
      case 'clearSequence':
        s.sequences = s.sequences.filter((q) => q.vehicleId !== edit.vehicleId);
        break;
      case 'pin':
        s.pins = s.pins.filter((p) => p.orderNo !== edit.orderNo);
        s.pins.push({ orderNo: edit.orderNo, vehicleId: edit.vehicleId });
        s.forbids = s.forbids.filter((f) => f.orderNo !== edit.orderNo); // pin supersedes forbids
        break;
      case 'unpin':
        s.pins = s.pins.filter((p) => p.orderNo !== edit.orderNo);
        break;
      case 'forbid':
        if (!s.forbids.some((f) => f.orderNo === edit.orderNo && f.vehicleId === edit.vehicleId))
          s.forbids.push({ orderNo: edit.orderNo, vehicleId: edit.vehicleId });
        s.pins = s.pins.filter((p) => !(p.orderNo === edit.orderNo && p.vehicleId === edit.vehicleId));
        break;
      case 'unforbid':
        s.forbids = s.forbids.filter((f) => !(f.orderNo === edit.orderNo && f.vehicleId === edit.vehicleId));
        break;
      case 'clearOverrides':
        s.pins = []; s.forbids = []; s.sequences = [];
        break;
    }
  }

  getScenario(id: string): Scenario | undefined { return this.scenarios.get(id); }

  putPlan(plan: Plan, persist = true): void {
    this.plans.set(plan.id, plan);
    if (persist) {
      writeJson(join(dir('plans'), `${plan.id}.json`), plan);
      if (this.plans.size > config.retainPlans + 20) this.gcPlans(); // cheap trigger
    }
  }
  getPlan(id: string): Plan | undefined {
    const plan = this.plans.get(id);
    return plan ? withNormalizedPlanStats(plan) : undefined;
  }
  plansForScenario(scenarioId: string): Plan[] {
    return [...this.plans.values()].filter((p) => p.scenarioId === scenarioId).map(withNormalizedPlanStats);
  }
  /** The most recent plan for a scenario (its current "result"), if any. */
  latestPlanForScenario(scenarioId: string): Plan | undefined {
    const ps = this.plansForScenario(scenarioId);
    return ps.length ? ps.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b)) : undefined;
  }
  /** Scenarios for a day (base + the dispatcher's what-if copies). */
  scenariosForDay(day: string): Scenario[] {
    return [...this.scenarios.values()].filter((s) => s.day === day);
  }
  /** Rename a scenario (for telling what-ifs apart). */
  renameScenario(id: string, label: string): Scenario {
    const s = this.scenarios.get(id);
    if (!s) throw new Error('scenario not found');
    s.label = label;
    s.revision++;
    writeJson(join(dir('scenarios'), `${s.id}.json`), s);
    return s;
  }
  /** Recreate a scenario from an imported edits bundle as a new copy of the day's base. */
  importScenario(base: Scenario, label: string, edits: ScenarioEditsBundle): Scenario {
    if (edits.planningPolicyId && edits.planningPolicyId !== base.planningPolicy?.id) throw new Error('planning policy reference is not approved in this workspace');
    const s = this.createCopy(base, {}, label);
    s.removedVehicleIds = [...edits.removedVehicleIds];
    s.pins = edits.pins.map((p) => ({ ...p }));
    s.forbids = edits.forbids.map((f) => ({ ...f }));
    if(edits.deliveryDatasetSha256)s.deliveryDatasetSha256=edits.deliveryDatasetSha256;
    s.vehicleOverrides = edits.vehicleOverrides.map((o) => ({ ...o }));
    s.sequences = edits.sequences.map(q=>structuredClone(q));
    s.revision += 1;
    this.scenarios.set(s.id, s);
    writeJson(join(dir('scenarios'), `${s.id}.json`), s);
    return s;
  }

  /** Delete a what-if copy (base scenarios are kept; their plans GC naturally). */
  deleteScenario(id: string): boolean {
    const s = this.scenarios.get(id);
    if (!s) return false;
    if (s.kind === 'base') throw new Error('base scenario cannot be deleted');
    this.scenarios.delete(id);
    try { rmSync(join(dir('scenarios'), `${id}.json`), { force: true }); } catch { /* ignore */ }
    return true;
  }

  createJob(scenarioId: string, scenarioRevision: number): Job {
    const j: Job = {
      id: this.newId('job'), scenarioId, scenarioRevision,
      status: 'pending', createdAt: new Date().toISOString(),
      startedAt: null, finishedAt: null, elapsedSec: 0,
      planId: null, termination: null, error: null,
    };
    this.jobs.set(j.id, j);
    this.saveJob(j);
    if (this.jobs.size > config.retainJobs + 20) this.gcJobs(); // cheap trigger
    return j;
  }
  createImportJob(): Job {
    const j: Job = {
      id: this.newId('imp'), scenarioId: '', scenarioRevision: 0, kind: 'import',
      status: 'pending', createdAt: new Date().toISOString(),
      startedAt: null, finishedAt: null, elapsedSec: 0,
      planId: null, termination: null, error: null, stage: 'queued',
    };
    this.jobs.set(j.id, j);
    this.saveJob(j);
    if (this.jobs.size > config.retainJobs + 20) this.gcJobs();
    return j;
  }
  getJob(id: string): Job | undefined { return this.jobs.get(id); }
  saveJob(j: Job): void { writeJson(join(dir('jobs'), `${j.id}.json`), j); }

  /** Drop a day's baseline plan + base scenario (used when deleting a dataset). */
  removeDay(dayId: string): void {
    this.plans.delete(`${dayId}-baseline`);
    const sid = `${dayId}-base`;
    this.scenarios.delete(sid);
    try { rmSync(join(dir('scenarios'), `${sid}.json`), { force: true }); } catch { /* ignore */ }
  }
}

/** Construct the filesystem-backed store only for the legacy runtime. */
export const createLegacyStore = (): Store => new Store();
