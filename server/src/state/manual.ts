import { randomUUID } from 'node:crypto';
import type { Plan } from '../types.js';
import type { Scenario } from '../store.js';
import type { Principal } from '../auth.js';
import { type ManualBatch, applyManualBatch, ManualCommandError } from '../plan/manual.js';
import { prepareManualInput, evaluateManualInput, materializeManualPlan, ManualAdapterError, type ManualDatasetContext } from '../plan/manual-adapter.js';
import { manualTripKey } from '../plan/manual-evaluate.js';
import type { StatefulStore } from './postgres.js';
import type { PoolClient } from 'pg';
import { planDigest } from './plan-workflow.js';
import { hasPermission } from '../roles.js';

export class ManualPublicationError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export interface ManualPublicationRequest { parentPlanId: string; batch: ManualBatch }
export type ManualDatasetLoader = (plan: Plan, scenario: Scenario) => Promise<ManualDatasetContext>;

export function parseManualRequest(value: unknown): ManualPublicationRequest {
  const invalid = () => new ManualPublicationError(400, 'Invalid manual planning request.');
  const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
  const keys = (x: Record<string, unknown>, allowed: string[]) => Object.keys(x).every(key => allowed.includes(key));
  const id = (x: unknown) => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
  if (!object(value) || !keys(value, ['parentPlanId', 'batch']) || typeof value.parentPlanId !== 'string' || value.parentPlanId.length > 128 || !value.parentPlanId) throw invalid();
  const batch = value.batch;
  if (!object(batch) || !keys(batch, ['operationId', 'datasetSha256', 'commands']) ||
    typeof batch.operationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(batch.operationId) ||
    typeof batch.datasetSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(batch.datasetSha256) ||
    !Array.isArray(batch.commands) || !batch.commands.length || batch.commands.length > 1000) throw invalid();
  for (const command of batch.commands) {
    if (!object(command) || !id(command.requestId)) throw invalid();
    if (command.op === 'assign') {
      if (!keys(command, ['op','requestId','vehicleId','tripId','position']) || !id(command.vehicleId) || !id(command.position) ||
        typeof command.tripId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(command.tripId)) throw invalid();
    } else if (!['release','deassign'].includes(String(command.op)) || !keys(command, ['op','requestId'])) throw invalid();
  }
  return value as unknown as ManualPublicationRequest;
}

/** Explicit opt-in loader: no node-local or cross-tenant dataset fallback. */
export class ManualPlanPublisher {
  constructor(private store: StatefulStore, private tenantId: string, private load: ManualDatasetLoader) {}

  private async receipt(client: PoolClient, operationId: string, payloadHash: string, actorId: string): Promise<Plan | null> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`manual/${this.tenantId}/${operationId}`]);
    const found = await client.query<{ detail: { payloadHash: string; actorId: string; planId: string } }>(
      "SELECT detail FROM audit_events WHERE tenant_id=$1 AND action='plan.manual' AND detail->>'operationId'=$2", [this.tenantId, operationId]);
    if (!found.rows.length) return null;
    const receipt = found.rows[0]!.detail;
    if (receipt.payloadHash !== payloadHash || receipt.actorId !== actorId)
      throw new ManualPublicationError(409, 'Operation key was already used for different intent.');
    const result = await client.query<{ body: Plan }>('SELECT body FROM plans WHERE tenant_id=$1 AND id=$2', [this.tenantId, receipt.planId]);
    if (!result.rows[0]) throw new ManualPublicationError(409, 'Manual publication receipt is incomplete.');
    return result.rows[0].body;
  }

  async publish(scenarioId: string, revision: number, intent: ManualPublicationRequest, actor?: Principal): Promise<Plan> {
    if (actor && actor.tenantId !== this.tenantId) throw new ManualPublicationError(403, 'Tenant mismatch.');
    if (actor && !hasPermission(actor.role, 'scenario.edit')) throw new ManualPublicationError(403, 'Manual planning permission required.');
    if (!Number.isSafeInteger(revision) || revision < 0) throw new ManualPublicationError(400, 'Invalid expected revision.');
    intent = parseManualRequest(intent);
    const actorId = actor?.userId ?? 'local';
    const payloadHash = planDigest({ scenarioId, revision, intent });
    const replay = await this.store.tx(client => this.receipt(client, intent.batch.operationId, payloadHash, actorId));
    if (replay) return replay;
    const [scenario, parentRows] = await Promise.all([this.store.getScenario(this.tenantId, scenarioId),
      this.store.pool.query<{ body: Plan }>('SELECT body FROM plans WHERE tenant_id=$1 AND id=$2', [this.tenantId, intent.parentPlanId])]);
    // Hash actual immutable bytes, not read-time normalization of old plans.
    const parent = parentRows.rows[0]?.body;
    if (!scenario || !parent || parent.scenarioId !== scenarioId) throw new ManualPublicationError(404, 'Scenario or parent plan not found.');
    if (scenario.kind !== 'copy') throw new ManualPublicationError(409, 'Create an editable scenario copy before manual planning.');
    if (scenario.revision !== revision || parent.scenarioRevision !== revision || scenario.manualPlanId && scenario.manualPlanId !== parent.id)
      throw new ManualPublicationError(409, 'Parent plan is stale; reload before planning.');
    let context: ManualDatasetContext;
    try { context = await this.load(parent, scenario); }
    catch { throw new ManualPublicationError(422, 'Pinned admitted dataset or trusted planning settings are unavailable.'); }
    // A new explicit decision supersedes the old label-based pin. Remove it
    // before evaluation as well as publication; release must not revive it.
    const tasks = new Map(context.day.request.tasks.map(task => [task.id, task.ref]));
    const refs = new Map(context.day.request.requests.map(order => [order.id, tasks.get(order.delivery_task_id)]));
    const editedRefs = new Set(intent.batch.commands.map(command => refs.get(command.requestId)));
    const effectiveScenario: Scenario = { ...scenario, pins: scenario.pins.filter(pin => !editedRefs.has(pin.orderNo)) };
    let input, evaluation;
    const at = new Date().toISOString();
    try {
      input = prepareManualInput(parent, effectiveScenario, context);
      const original = input.layout;
      input.layout = applyManualBatch(original, intent.batch, { actorId, at });
      for (const route of input.layout.routes) {
        const key = manualTripKey(route.vehicleId, route.tripId);
        if (!input.departures.has(key)) input.departures.set(key, input.request.vehicles.find(v => v.id === route.vehicleId)?.shift_early ?? 0);
      }
      evaluation = evaluateManualInput(input, original, effectiveScenario);
    } catch (error) {
      if (error instanceof ManualCommandError || error instanceof ManualAdapterError)
        throw new ManualPublicationError(409, error.message);
      throw new ManualPublicationError(422, 'Manual plan cannot be evaluated with the available dataset evidence.');
    }
    const updated: Scenario = { ...effectiveScenario, revision: revision+1, manualPlanId: `pln_${randomUUID()}`,
      manualDecisions: { datasetSha256: input.datasetSha256, decisions: structuredClone(input.layout.decisions),
        requestIds: [...input.layout.requestIds],
        origins: structuredClone(input.layout.origins), history: structuredClone(input.layout.history) } };
    const plan = materializeManualPlan(parent, updated, input, evaluation, context, updated.manualPlanId!, at);
    const parentHash = planDigest(parent);
    return this.store.tx(async client => {
      const again = await this.receipt(client, intent.batch.operationId, payloadHash, actorId);
      if (again) return again;
      const current = await client.query<{ revision: string }>('SELECT revision FROM scenarios WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [this.tenantId, scenarioId]);
      if (Number(current.rows[0]?.revision) !== revision) throw new ManualPublicationError(409, 'Scenario changed during evaluation.');
      const base = await client.query<{ body: Plan }>('SELECT body FROM plans WHERE tenant_id=$1 AND id=$2', [this.tenantId, parent.id]);
      if (!base.rows[0] || planDigest(base.rows[0].body) !== parentHash) throw new ManualPublicationError(409, 'Parent plan changed during evaluation.');
      await client.query('UPDATE scenarios SET revision=$3,body=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2', [this.tenantId, scenarioId, updated.revision, updated]);
      await client.query('INSERT INTO plans(tenant_id,id,scenario_id,scenario_revision,body) VALUES($1,$2,$3,$4,$5)', [this.tenantId, plan.id, scenarioId, updated.revision, plan]);
      await client.query("INSERT INTO audit_events(tenant_id,user_id,action,detail) VALUES($1,$2,'plan.manual',$3)",
        [this.tenantId, actor?.userId ?? null, { operationId: intent.batch.operationId, actorId, payloadHash, planId: plan.id, parentPlanId: parent.id, scenarioId, revision: updated.revision }]);
      return plan;
    });
  }
}
