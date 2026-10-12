import { randomUUID } from 'node:crypto';
import type { Lease, StatefulStore } from './postgres.js';

export interface SolveOutput { planId: string; scenarioId: string; scenarioRevision: number; plan: unknown }
export type SolveExecutor = (lease: Lease, signal: AbortSignal) => Promise<SolveOutput>;

/** One durable-job iteration. Heartbeats stop before publication; completeSolve
 * rechecks the live fence in the same transaction that publishes the plan. */
export async function workOneSolve(store: StatefulStore, execute: SolveExecutor, workerId = `worker-${randomUUID()}`, leaseSeconds = 30): Promise<boolean> {
  const lease = await store.claimJob('solve', workerId, leaseSeconds);
  if (!lease) return false;
  const abort = new AbortController();
  const heartbeat = setInterval(() => void store.heartbeatJob(lease, leaseSeconds).catch(() => abort.abort()), Math.max(250, leaseSeconds * 500));
  try {
    const output = await execute(lease, abort.signal);
    await store.completeSolve(lease, output.planId, output.scenarioId, output.scenarioRevision, output.plan);
  } catch (error) {
    try { await store.failJob(lease, (error as Error).message); } catch { /* a new fence owns the terminal decision */ }
    throw error;
  } finally { clearInterval(heartbeat); }
  return true;
}
