import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import { loadDay, loadEnrichment, loadVehicleInfo, DAYS } from './data/dataset.js';
import { mapSolutionToPlan } from './plan/mapper.js';
import { fillPlanGeometry } from './geometry/velo.js';
import { store, type Job, type Scenario } from './store.js';
import type { SurgeRequest, SurgeSolution } from './types.js';

const enrichment = loadEnrichment();
const vehicleInfo = loadVehicleInfo();

/* Bounded solve execution: at most `maxConcurrentSolves` surge_solve processes
 * run at once; the rest queue (jobs stay 'pending' until a slot frees). Each run
 * has a watchdog that hard-kills a solver that overruns its budget, and caps the
 * captured stdout so a pathological solver can't exhaust memory. */
const running = new Map<string, ChildProcess>();
interface QueuedSolve { job: Job; scenario: Scenario; budgetSec: number; objective: Objective; fullBudget: boolean }
const queue: QueuedSolve[] = [];

export interface BuiltRequest { request: SurgeRequest; day: ReturnType<typeof loadDay> }

export type Objective = 'vehicles' | 'distance';

/** Build the exact Surge request for a scenario: day-scoped requests, edited
 * fleet, manual pins/forbids, solve budget and objective. The base day's
 * vehicles are already day-specific.
 *
 * Objective maps to Surge's lexicographic_objective: 'vehicles' (true) serves
 * then minimizes fleet size then distance; 'distance' (false) minimizes the
 * single cost objective (fixed + distance), i.e. the least-distance plan. */
export function buildRequest(scenario: Scenario, budgetSec: number, objective: Objective = 'vehicles', fullBudget = false): BuiltRequest {
  const day = loadDay(scenario.day);
  // A12: deep-clone everything we mutate, but SHARE the N^2 travel matrix by
  // reference (it is never mutated here). structuredClone of the whole request
  // would deep-copy ~2.25M distance+duration entries on the event loop per solve.
  const { travel, ...rest } = day.request;
  const request = structuredClone(rest) as SurgeRequest;
  request.travel = travel;
  request.requests = request.requests.filter((r) => day.scopeTaskIds.has(r.delivery_task_id));

  const available = new Set(request.vehicles.map((v) => v.id));
  if (scenario.removedVehicleIds.length) {
    const drop = new Set(scenario.removedVehicleIds);
    request.vehicles = request.vehicles.filter((v) => !drop.has(v.id));
    for (const id of drop) available.delete(id);
  }

  applyOverrides(request, scenario, available);
  applyVehicleOverrides(request, scenario);
  applySequences(request, scenario, available);

  request.config = {
    ...request.config,
    max_time_seconds: budgetSec,
    seed: 42,
    lexicographic_objective: objective !== 'distance',
    hard_capacity: true,
    hard_time_windows: true,
    hard_max_duration: true,
    // "Run full budget": raise the iteration cap so only the time limit stops the
    // search (keep improving/searching until budgetSec), instead of converging early.
    ...(fullBudget ? { max_iterations: 2_000_000_000 } : {}),
  };
  return { request, day };
}

/** Apply a scenario's manual pins/forbids onto a request (mutates request). Orders
 * are keyed by order_no (task.ref); pins set allowed_vehicles=[v] and supersede
 * forbids on the same order; forbids append to forbidden_vehicles. Overrides
 * naming a vehicle not in `available` (e.g. one that was removed) are skipped. */
export function applyOverrides(request: SurgeRequest, scenario: Scenario, available?: Set<number>): void {
  if (!scenario.pins.length && !scenario.forbids.length) return;
  const avail = available ?? new Set(request.vehicles.map((v) => v.id));
  const taskRefById = new Map(request.tasks.map((t) => [t.id, t.ref]));
  const reqByOrderNo = new Map<string, SurgeRequest['requests'][number]>();
  for (const r of request.requests) {
    const ref = taskRefById.get(r.delivery_task_id);
    if (ref != null) reqByOrderNo.set(String(ref), r);
  }
  for (const p of scenario.pins) {
    const r = reqByOrderNo.get(p.orderNo);
    if (r && avail.has(p.vehicleId)) r.allowed_vehicles = [p.vehicleId];
  }
  for (const f of scenario.forbids) {
    const r = reqByOrderNo.get(f.orderNo);
    if (!r || !avail.has(f.vehicleId)) continue;
    if (r.allowed_vehicles) continue; // a pin on this order supersedes forbids
    r.forbidden_vehicles = [...(r.forbidden_vehicles ?? []), f.vehicleId];
  }
}

/** Apply per-vehicle constraint overrides (capacity, shift, max trips/distance/
 * duration) onto the request vehicles (mutates request). Unset fields are left
 * at the vehicle's dataset defaults. Distance is km->m, duration is min->s. */
export function applyVehicleOverrides(request: SurgeRequest, scenario: Scenario): void {
  if (!scenario.vehicleOverrides.length) return;
  const byId = new Map(request.vehicles.map((v) => [v.id, v]));
  for (const o of scenario.vehicleOverrides) {
    const v = byId.get(o.vehicleId);
    if (!v) continue; // vehicle removed / not in scope
    if (o.capacityKg != null) v.capacity[0] = o.capacityKg;
    if (o.capacityPallets != null) v.capacity[1] = o.capacityPallets;
    if (o.shiftEarlySec != null) v.shift_early = o.shiftEarlySec;
    if (o.shiftLateSec != null) v.shift_late = o.shiftLateSec;
    if (o.maxTrips != null) v.max_trips = o.maxTrips;
    if (o.maxDistanceKm != null) v.max_distance = o.maxDistanceKm * 1000;
    if (o.maxDurationMin != null) v.max_duration = o.maxDurationMin * 60;
  }
}

/** Apply manual stop sequences (mutates request). Each sequence locks its orders
 * to one vehicle (allowed_vehicles) and chains precedence between consecutive
 * orders so the solver keeps them in the dispatcher's order. Orders not in scope
 * or on an unavailable vehicle are skipped. */
export function applySequences(request: SurgeRequest, scenario: Scenario, available?: Set<number>): void {
  if (!scenario.sequences?.length) return;
  const avail = available ?? new Set(request.vehicles.map((v) => v.id));
  const reqIdByOrderNo = new Map<string, number>();
  const taskRefById = new Map(request.tasks.map((t) => [t.id, t.ref]));
  for (const r of request.requests) {
    const ref = taskRefById.get(r.delivery_task_id);
    if (ref != null) reqIdByOrderNo.set(String(ref), r.id);
  }
  const reqById = new Map(request.requests.map((r) => [r.id, r]));
  const prec = request.precedences ?? [];
  for (const seq of scenario.sequences) {
    if (!avail.has(seq.vehicleId)) continue; // vehicle removed/out of scope
    // resolve to in-scope request ids, preserving the dispatcher's order
    const ids = seq.orderNos.map((o) => reqIdByOrderNo.get(o)).filter((x): x is number => x != null);
    if (ids.length < (seq.locked ? 1 : 2)) continue;
    for (const id of ids) { const r = reqById.get(id); if (r) r.allowed_vehicles = [seq.vehicleId]; } // keep on the vehicle
    for (let i = 0; i + 1 < ids.length; i++) prec.push({ before: ids[i]!, after: ids[i + 1]! });
    if (seq.locked) {
      // freeze the route exactly: no other order may be added to this vehicle
      const inSeq = new Set(ids);
      for (const r of request.requests) {
        if (!inSeq.has(r.id)) r.forbidden_vehicles = [...(r.forbidden_vehicles ?? []), seq.vehicleId];
      }
    }
  }
  if (prec.length) request.precedences = prec;
}

function dayLabel(dayId: string): string {
  return DAYS.find((d) => d.id === dayId)?.label ?? dayId;
}

/** Spawn surge_solve for a job (off the event loop), then map + geometry-fill +
 * store the resulting plan. Updates job status throughout. */
/** Enqueue a solve: runs immediately if a slot is free, else queues (the job
 * stays 'pending' until a slot frees). */
export function enqueueSolve(job: Job, scenario: Scenario, budgetSec: number, objective: Objective = 'vehicles', fullBudget = false): void {
  if (running.size < Math.max(1, config.maxConcurrentSolves)) runSolveProcess(job, scenario, budgetSec, objective, fullBudget);
  else queue.push({ job, scenario, budgetSec, objective, fullBudget });
}

/* A3: backpressure. False when all solver slots are busy AND the queue is at
 * its depth cap; the API returns 503 rather than growing an unbounded queue. */
export function hasSolveCapacity(): boolean {
  return running.size < Math.max(1, config.maxConcurrentSolves) || queue.length < Math.max(0, config.maxSolveQueue);
}

function pumpQueue(): void {
  while (running.size < Math.max(1, config.maxConcurrentSolves) && queue.length) {
    const next = queue.shift()!;
    if (next.job.status === 'cancelled') continue; // cancelled while queued
    runSolveProcess(next.job, next.scenario, next.budgetSec, next.objective, next.fullBudget);
  }
}

function runSolveProcess(job: Job, scenario: Scenario, budgetSec: number, objective: Objective, fullBudget: boolean): void {
  const built = buildRequest(scenario, budgetSec, objective, fullBudget);
  const jobsDir = resolve(config.dataDir, 'jobs');
  mkdirSync(jobsDir, { recursive: true });
  const reqFile = resolve(jobsDir, `${job.id}_request.json`);
  writeFileSync(reqFile, JSON.stringify(built.request));

  job.status = 'running';
  job.startedAt = new Date().toISOString();
  store.saveJob(job);

  const t0 = Date.now();
  const child = spawn(config.surgeBin, [reqFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  running.set(job.id, child);

  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let outBytes = 0, overflow = false, timedOut = false;
  const maxOut = Math.max(1, config.maxSolveOutputMB) * 1024 * 1024;

  child.stdout.on('data', (c: Buffer) => {
    outBytes += c.length;
    if (outBytes > maxOut) { if (!overflow) { overflow = true; child.kill('SIGKILL'); } return; }
    out.push(c);
  });
  child.stderr.on('data', (c: Buffer) => { if (err.length < 256) err.push(c); });

  // Watchdog: a solver that overruns its budget is SIGTERM'd, then SIGKILL'd.
  const killMs = (budgetSec + Math.max(5, config.solveWatchdogGraceSec)) * 1000;
  const termTimer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, killMs);
  const killTimer = setTimeout(() => { if (running.has(job.id)) child.kill('SIGKILL'); }, killMs + 5000);

  child.on('error', (e) => {
    clearTimeout(termTimer); clearTimeout(killTimer);
    running.delete(job.id);
    try { rmSync(reqFile, { force: true }); } catch { /* best-effort */ }
    job.status = 'failed';
    job.error = `spawn failed: ${e.message}`;
    job.finishedAt = new Date().toISOString();
    job.elapsedSec = (Date.now() - t0) / 1000;
    store.saveJob(job);
    pumpQueue();
  });

  child.on('close', (code, signal) => {
    clearTimeout(termTimer); clearTimeout(killTimer);
    running.delete(job.id); // the surge process has exited; free the slot
    try { rmSync(reqFile, { force: true }); } catch { /* best-effort */ }
    job.elapsedSec = (Date.now() - t0) / 1000;
    job.finishedAt = new Date().toISOString();

    try {
      if (job.status === 'cancelled') { store.saveJob(job); return; }
      if (timedOut) { job.status = 'failed'; job.error = `solve exceeded its budget (${budgetSec}s) and was terminated`; store.saveJob(job); return; }
      if (overflow) { job.status = 'failed'; job.error = `solver output exceeded ${config.maxSolveOutputMB} MB`; store.saveJob(job); return; }

      let solution: SurgeSolution | null = null;
      try { solution = JSON.parse(Buffer.concat(out).toString('utf8')) as SurgeSolution; } catch { /* below */ }

      if (!solution || !Array.isArray(solution.routes) || solution.routes.length === 0) {
        job.status = 'failed';
        job.termination = solution?.status ?? null;
        job.error = (Buffer.concat(err).toString('utf8').trim() || `surge_solve exited ${code}${signal ? ` (${signal})` : ''} with no usable solution`).slice(0, 500);
        store.saveJob(job);
        return;
      }

      const planId = store.newId('pln');
      const plan = mapSolutionToPlan({
        day: built.day, request: built.request, solution, enrichment: built.day.enrichment, vehicleInfo,
        scenarioId: scenario.id, scenarioRevision: scenario.revision, planId,
        source: 'live', createdAt: new Date().toISOString(),
      });
      plan.stats.solveElapsedSeconds = Math.round(job.elapsedSec * 10) / 10;

      // Fill geometry before publishing (async; does not hold the solve slot).
      fillPlanGeometry(plan).catch(() => false).finally(() => {
        store.putPlan(plan);
        job.status = 'completed';
        job.planId = planId;
        job.termination = solution!.status;
        store.saveJob(job);
      });
    } finally {
      pumpQueue();
    }
  });
}

export function cancelJob(job: Job): boolean {
  // Queued but not yet started: drop it from the queue.
  const qi = queue.findIndex((q) => q.job.id === job.id);
  if (qi >= 0) {
    queue.splice(qi, 1);
    job.status = 'cancelled';
    job.finishedAt = new Date().toISOString();
    store.saveJob(job);
    return true;
  }
  const child = running.get(job.id);
  if (!child) return false;
  job.status = 'cancelled';
  store.saveJob(job);
  child.kill('SIGTERM');
  return true;
}

export { dayLabel };
