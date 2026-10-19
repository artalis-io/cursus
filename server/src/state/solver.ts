import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { buildRequest, type Objective } from '../solve.js';
import { mapSolutionToPlan } from '../plan/mapper.js';
import { fillPlanGeometry } from '../geometry/velo.js';
import { loadVehicleInfo } from '../data/dataset.js';
import type { Scenario } from '../store.js';
import type { SurgeSolution } from '../types.js';
import type { Lease } from './postgres.js';
import type { SolveOutput } from './worker.js';
import { nativeSolveRequest } from './solver-ids.js';

const run = promisify(execFile);
interface SolvePayload { scenario: Scenario; scenarioId: string; scenarioRevision: number; budgetSec?: number; objective?: Objective; fullBudget?: boolean }

/** Native OTTO/Surge executor for a durable leased job. The workspace is
 * disposable; only completeSolve may publish its mapped result. */
export async function executeSurgeLease(lease: Lease, signal: AbortSignal): Promise<SolveOutput> {
  const payload = lease.payload as SolvePayload;
  if (!payload?.scenario || payload.scenario.id !== payload.scenarioId || payload.scenario.revision !== payload.scenarioRevision)
    throw new Error('invalid or inconsistent solve payload');
  const budget = Math.max(1, Math.min(payload.budgetSec ?? config.solveTimeSeconds, 86_400));
  const built = buildRequest(payload.scenario, budget, payload.objective ?? 'vehicles', payload.fullBudget ?? false);
  const workspace = await mkdtemp(join(tmpdir(), 'cursus-solve-'));
  const requestFile = join(workspace, 'request.json');
  try {
    const native = nativeSolveRequest(built.request, payload.scenario.sequences);
    await writeFile(requestFile, JSON.stringify(native.request), { mode: 0o600 });
    const { stdout, stderr } = await run(config.surgeBin, [requestFile], { signal, timeout: (budget + config.solveWatchdogGraceSec) * 1000,
      maxBuffer: Math.max(1, config.maxSolveOutputMB) * 1024 * 1024 });
    let solution: SurgeSolution;
    try { solution = JSON.parse(stdout) as SurgeSolution; } catch { throw new Error(`surge_solve returned invalid JSON: ${stderr.slice(0, 500)}`); }
    if (!Array.isArray(solution.routes) || !Array.isArray(solution.unassigned) || !['OK', 'LIMIT', 'INFEASIBLE'].includes(solution.status))
      throw new Error(`surge_solve produced no usable solution (${solution.status ?? 'unknown'})`);
    solution = native.restore(solution);
    const planId = `pln_${randomUUID().slice(0, 8)}`;
    const plan = mapSolutionToPlan({ day: built.day, request: built.request, solution, enrichment: built.day.enrichment,
      vehicleInfo: loadVehicleInfo(), scenarioId: payload.scenarioId, scenarioRevision: payload.scenarioRevision,
      planId, source: 'live', createdAt: new Date().toISOString() });
    if (plan.provenance.validation.violations.some(v => ['VEHICLE_SIZE', 'TAIL_LIFT'].includes((v as {type?: string}).type ?? '')))
      throw new Error('solver violated mandatory destination access or tail-lift requirements');
    await fillPlanGeometry(plan).catch(() => false);
    return { planId, scenarioId: payload.scenarioId, scenarioRevision: payload.scenarioRevision, plan };
  } finally { await rm(workspace, { recursive: true, force: true }); }
}
