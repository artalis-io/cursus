import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Principal } from '../auth.js';
import type { Plan } from '../types.js';
import type { Scenario } from '../store.js';
import type { StatefulStore } from './postgres.js';

export class WorkflowError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export interface Workflow {
  state: 'draft' | 'reviewed' | 'approved' | 'superseded';
  version: number;
  scenarioRevision: number;
  currentRevision: number;
  planSha256: string;
  actor: string | null;
  at: string | null;
  blockers: string[];
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const planDigest = (plan: unknown): string => createHash('sha256').update(canonical(plan)).digest('hex');

/** This is an approval gate over recorded solver evidence, not a new feasibility certificate. */
export function approvalBlockers(plan: Plan, revision: number, scenario?: Scenario): string[] {
  const issues: string[] = [];
  if (plan.scenarioRevision !== revision) issues.push('Plan does not match the current scenario revision.');
  if (plan.provenance?.validation?.valid !== true || !Array.isArray(plan.provenance?.validation?.violations)
    || plan.provenance.validation.violations.some(v => !v || typeof v !== 'object' || (v as { soft?: boolean }).soft !== true
      || ['VEHICLE_SIZE', 'TAIL_LIFT', 'CAPACITY', 'HARD_TW'].includes(String((v as { type?: string }).type))))
    issues.push('Missing or failed solver validation evidence.');
  if (!Array.isArray(plan.unassigned) || plan.unassigned.length > 0 || !Number.isSafeInteger(plan.stats?.totalOrders)
    || plan.stats.totalOrders <= 0 || plan.stats.servedOrders !== plan.stats.totalOrders)
    issues.push('Approval requires complete, consistent order coverage.');
  if (!/^[a-f0-9]{64}$/.test(plan.provenance?.inputSha256 ?? '')) issues.push('Dataset identity is missing.');
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  try {
    const stops = plan.vehicles.flatMap(v => v.trips.flatMap(t => t.stops));
    if (!stops.length || plan.stats.deliveryStops !== stops.length) issues.push('Stop inventory does not match coverage.');
    for (const vehicle of plan.vehicles) for (const trip of vehicle.trips) {
      if (![trip.loadKg, trip.loadPallets, vehicle.capacityKg, vehicle.capacityPallets].every(finite)
        || trip.loadKg > vehicle.capacityKg + 1 || trip.loadPallets > vehicle.capacityPallets + 1e-6)
        issues.push('Capacity evidence is missing or violated.');
      for (const stop of trip.stops) {
        if (stop.maxTonnage === undefined || stop.maxTonnage !== null && (!finite(stop.maxTonnage) || !finite(vehicle.tonnage) || vehicle.tonnage > stop.maxTonnage))
          issues.push('GVW evidence is missing or violated.');
        if (typeof stop.requiresTailLift !== 'boolean' || stop.requiresTailLift && vehicle.hasTailLift !== true)
          issues.push('Tail-lift evidence is missing or violated.');
        if (![stop.arrivalSec, stop.serviceStartSec, stop.twStartSec, stop.twEndSec].every(finite)
          || stop.serviceStartSec < stop.twStartSec - 1 || stop.twEndSec > 0 && Math.max(stop.arrivalSec, stop.serviceStartSec) > stop.twEndSec + 1)
          issues.push('Time-window evidence is missing or violated.');
      }
    }
    for (const lock of scenario?.sequences.filter(s => s.locked) ?? []) {
      const actual = plan.vehicles.find(v => v.id === lock.vehicleId)?.trips.flatMap(t => t.stops.map(s => s.orderNo)) ?? [];
      if (actual.length !== lock.orderNos.length || actual.some((value, index) => value !== lock.orderNos[index])) issues.push('Locked route differs from the scenario.');
    }
  } catch { issues.push('Plan constraint evidence is incomplete.'); }
  return [...new Set(issues)];
}

/** Immutable approval ledger reuses the existing tenant-scoped audit store.
 * Scenario row locks serialize approval against edit/delete transactions.
 * No operational dispatched/published state or customer system-of-record is introduced. */
export class PlanWorkflow {
  constructor(private store: StatefulStore, private tenantId: string) {}

  private async snapshot(client: PoolClient, id: string, lock: boolean): Promise<{ workflow: Workflow; plan: Plan }> {
    const found = await client.query<{ body: Plan }>('SELECT body FROM plans WHERE tenant_id=$1 AND id=$2', [this.tenantId, id]);
    const plan = found.rows[0]?.body;
    if (!plan) throw new WorkflowError(404, 'plan not found');
    const scenarios = await client.query<{ revision: string; body: Scenario }>(`SELECT revision,body FROM scenarios WHERE tenant_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`, [this.tenantId, plan.scenarioId]);
    if (!scenarios.rows[0]) throw new WorkflowError(409, 'Plan scenario no longer exists.');
    const revision = Number(scenarios.rows[0].revision);
    const hash = planDigest(plan);
    const events = await client.query<{ action: string; detail: { version: number; planSha256: string; scenarioRevision: number }; user_id: string | null; created_at: Date }>(
      `SELECT action,detail,user_id,created_at FROM audit_events WHERE tenant_id=$1 AND action IN ('plan.review','plan.approve')
       AND detail->>'planId'=$2 ORDER BY id DESC LIMIT 1`, [this.tenantId, id]);
    const event = events.rows[0];
    const state = event ? revision !== plan.scenarioRevision || event.detail.planSha256 !== hash ? 'superseded'
      : event.action === 'plan.approve' ? 'approved' : 'reviewed' : 'draft';
    return { plan, workflow: { state, version: event?.detail.version ?? 0, scenarioRevision: plan.scenarioRevision,
      currentRevision: revision, planSha256: hash, actor: event?.user_id ?? null, at: event?.created_at.toISOString() ?? null,
      blockers: approvalBlockers(plan, revision, scenarios.rows[0].body) } };
  }

  async get(id: string): Promise<Workflow> {
    return this.store.tx(async client => (await this.snapshot(client, id, true)).workflow);
  }

  async transition(id: string, action: 'plan.review' | 'plan.approve', version: number, revision: number,
    acknowledgeExceptions: boolean, actor?: Principal): Promise<Workflow> {
    return this.store.tx(async client => {
      const { plan, workflow } = await this.snapshot(client, id, true);
      if (workflow.version !== version || workflow.currentRevision !== revision)
        throw new WorkflowError(409, 'Plan review changed. Reload before continuing.');
      if (workflow.blockers.length) throw new WorkflowError(409, workflow.blockers.join(' '));
      if (!acknowledgeExceptions) throw new WorkflowError(400, 'Explicit acknowledgement of constraints and approved policy exceptions is required.');
      if (action === 'plan.review' && workflow.state !== 'draft') throw new WorkflowError(409, 'Only a draft plan can be reviewed.');
      if (action === 'plan.approve' && workflow.state !== 'reviewed') throw new WorkflowError(409, 'Review the current plan before approval.');
      await client.query(`INSERT INTO audit_events(tenant_id,user_id,action,detail) VALUES($1,$2,$3,$4)`,
        [this.tenantId, actor?.userId ?? null, action, { planId: id, scenarioId: plan.scenarioId,
          scenarioRevision: plan.scenarioRevision, planSha256: workflow.planSha256, version: version + 1,
          acknowledgedExceptions: true, actorMode: actor ? 'authenticated' : 'local' }]);
      return (await this.snapshot(client, id, false)).workflow;
    });
  }
}
