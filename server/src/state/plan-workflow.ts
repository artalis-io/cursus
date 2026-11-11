import {parseProfile,profileDigest} from '../planning-profiles.js';
import {manualSettings,operatingPolicyChanged} from './manual-settings.js';
import {loadingBlockers,loadingSource,loadingRequired} from '../hard-loading.js';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Principal } from '../auth.js';
import type { Plan } from '../types.js';
import type { Scenario } from '../store.js';
import type { StatefulStore } from './postgres.js';
import type { ApprovalBlocker, ApprovalBlockerCode, ApprovalBlockerTarget, Workflow } from '../workflow-contract.js';
import type {PlanIdentity} from '../library-contract.js';
import { constraintSnapshot, type HandoffActor, type HandoffMetadata } from '../handoff.js';
import { withNormalizedPlanStats } from '../plan/stats.js';
export type { Workflow } from '../workflow-contract.js';

interface ReviewEvent { action: string; detail: { version: number; planSha256: string; scenarioRevision: number;
      scenarioSnapshot?: Scenario; actor?: { userId: string; email: string }; acknowledgedExceptions?: boolean };
      user_id: string | null; email: string | null; created_at: Date }

export class WorkflowError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const planDigest = (plan: unknown): string => createHash('sha256').update(canonical(plan)).digest('hex');

/** This is an approval gate over recorded solver evidence, not a new feasibility certificate. */
export function approvalIssues(plan: Plan, revision: number, scenario?: Scenario): ApprovalBlocker[] {
  const issues:ApprovalBlocker[]=loadingBlockers(plan,scenario).map(message=>({code:'physical_loading',message,target:{kind:'section',section:'loading'}}));
  const add=(code:ApprovalBlockerCode,message:string,target:ApprovalBlockerTarget={kind:'section',section:'constraints'})=>issues.push({code,message,target});
  if (plan.scenarioRevision !== revision) add('revision_changed','Plan does not match the current scenario revision.',{kind:'section',section:'changes'});
  if(scenario&&canonical(plan.provenance?.planningProfiles??[])!==canonical(scenario.planningProfiles??[]))
    add('profiles_changed','Plan uses different planning profile revisions.');
  if (plan.provenance?.validation?.valid !== true || !Array.isArray(plan.provenance?.validation?.violations)
    || plan.provenance.validation.violations.some(v => !v || typeof v !== 'object' || (v as { soft?: boolean }).soft !== true
      || ['VEHICLE_SIZE', 'TAIL_LIFT', 'CAPACITY', 'HARD_TW'].includes(String((v as { type?: string }).type))))
    add('validation_failed','Missing or failed solver validation evidence.',{kind:'section',section:'issues'});
  if (!Array.isArray(plan.unassigned) || plan.unassigned.length > 0 || !Number.isSafeInteger(plan.stats?.totalOrders)
    || plan.stats.totalOrders <= 0 || plan.stats.servedOrders !== plan.stats.totalOrders)
    add('coverage_incomplete','Approval requires complete, consistent order coverage.',{kind:'section',section:'issues'});
  if (!/^[a-f0-9]{64}$/.test(plan.provenance?.inputSha256 ?? '')) add('dataset_identity_missing','Dataset identity is missing.');
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  try {
    const stops = plan.vehicles.flatMap(v => v.trips.flatMap(t => t.stops));
    if(plan.shipmentMetadata){
      const metadata=plan.shipmentMetadata,ids=[...stops,...plan.unassigned].map(s=>s.requestId);
      const described=metadata.deliveries.map(d=>d.requestId);
      if(metadata.datasetSha256!==plan.provenance.datasetSha256||metadata.sourceSha256!==plan.provenance.shipmentSha256||
        new Set(ids).size!==ids.length||ids.some(id=>id===undefined)||new Set(described).size!==described.length||
        described.length!==ids.length||ids.some(id=>!described.includes(id!)))add('shipment_metadata_mismatch','Shipment metadata does not match the plan delivery inventory.');
    }
    if (!stops.length || plan.stats.deliveryStops !== stops.length) add('stop_inventory_mismatch','Stop inventory does not match coverage.',{kind:'section',section:'issues'});
    for (const vehicle of plan.vehicles) for (const trip of vehicle.trips) {
      if (![trip.loadKg, trip.loadPallets, vehicle.capacityKg, vehicle.capacityPallets].every(finite)
        || trip.loadKg > vehicle.capacityKg + 1 || trip.loadPallets > vehicle.capacityPallets + 1e-6)
        add('capacity','Capacity evidence is missing or violated.',{kind:'trip',vehicleId:vehicle.id,tripIndex:trip.index});
      for (const stop of trip.stops) {
        if (stop.maxTonnage === undefined || stop.maxTonnage !== null && (!finite(stop.maxTonnage) || !finite(vehicle.tonnage) || vehicle.tonnage > stop.maxTonnage))
          add('gvw','GVW evidence is missing or violated.',{kind:'stop',vehicleId:vehicle.id,tripIndex:trip.index,seq:stop.seq,orderNo:stop.orderNo,...(stop.requestId!==undefined?{requestId:stop.requestId}:{})});
        if (typeof stop.requiresTailLift !== 'boolean' || stop.requiresTailLift && vehicle.hasTailLift !== true)
          add('tail_lift','Tail-lift evidence is missing or violated.',{kind:'stop',vehicleId:vehicle.id,tripIndex:trip.index,seq:stop.seq,orderNo:stop.orderNo,...(stop.requestId!==undefined?{requestId:stop.requestId}:{})});
        if (![stop.arrivalSec, stop.serviceStartSec, stop.twStartSec, stop.twEndSec].every(finite)
          || stop.serviceStartSec < stop.twStartSec - 1 || stop.twEndSec > 0 && Math.max(stop.arrivalSec, stop.serviceStartSec) > stop.twEndSec + 1)
          add('time_window','Time-window evidence is missing or violated.',{kind:'stop',vehicleId:vehicle.id,tripIndex:trip.index,seq:stop.seq,orderNo:stop.orderNo,...(stop.requestId!==undefined?{requestId:stop.requestId}:{})});
      }
    }
    for (const lock of scenario?.sequences.filter(s => s.locked) ?? []) {
      const actual = plan.vehicles.find(v => v.id === lock.vehicleId)?.trips.flatMap(t => t.stops) ?? [];
      if (actual.length !== lock.orderNos.length || actual.some((value, index) => value.orderNo !== lock.orderNos[index] ||
        lock.requestIds !== undefined && value.requestId !== lock.requestIds[index]) ||
        !lock.requestIds && new Set(actual.map(s => s.orderNo)).size !== actual.length) add('locked_route','Locked route differs from the scenario.',{kind:'vehicle',vehicleId:lock.vehicleId});
    }
  } catch { add('constraint_evidence_missing','Plan constraint evidence is incomplete.'); }
  return issues;
}

/** Preserve the established approval gate and legacy messages exactly. */
export function approvalBlockers(plan:Plan,revision:number,scenario?:Scenario):string[]{
  return [...new Set(approvalIssues(plan,revision,scenario).map(issue=>issue.message))];
}

/** Immutable approval ledger reuses the existing tenant-scoped audit store.
 * Scenario row locks serialize approval against edit/delete transactions.
 * No operational dispatched/published state or customer system-of-record is introduced. */
export class PlanWorkflow {
  constructor(private store: StatefulStore, private tenantId: string,private policyBlockers?:(plan:Plan)=>string[]) {}

  private async snapshot(client: PoolClient, id: string, lock: boolean, allowMissingScenario = false,
    prepared?:{plan:Plan;scenario:Scenario;revision:number;event:ReviewEvent|undefined;loading:()=>Promise<{source:string|undefined;required:boolean}>}) {
    const found = prepared?null:await client.query<{ body: Plan }>('SELECT body FROM plans WHERE tenant_id=$1 AND id=$2', [this.tenantId, id]);
    const plan = prepared?.plan??found?.rows[0]?.body;
    if (!plan) throw new WorkflowError(404, 'plan not found');
    const scenarios = prepared?null:await client.query<{ revision: string; body: Scenario }>(`SELECT revision,body FROM scenarios WHERE tenant_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`, [this.tenantId, plan.scenarioId]);
    if (!prepared&&!scenarios?.rows[0] && !allowMissingScenario) throw new WorkflowError(409, 'Plan scenario no longer exists.');
    const scenario = prepared?.scenario??scenarios?.rows[0]?.body??null;
    const revision = prepared?.revision??(scenarios?.rows[0] ? Number(scenarios.rows[0].revision) : -1);
    const hash = planDigest(plan);
    const events = prepared?null:await client.query<ReviewEvent>(
      `SELECT e.action,e.detail,e.user_id,e.created_at,u.email FROM audit_events e LEFT JOIN users u ON u.id=e.user_id
       WHERE e.tenant_id=$1 AND e.action IN ('plan.review','plan.approve')
       AND e.detail->>'planId'=$2 ORDER BY e.id DESC LIMIT 1`, [this.tenantId, id]);
    const event = prepared?prepared.event:events?.rows[0];
    const policyIssues=[...(this.policyBlockers?.(plan)??[])];
    for(const ref of scenario?.planningProfiles?.filter(p=>p.kind==='fleet')??[]){
      const found=await client.query<{body:import('../planning-profile-contract.js').ProfileContent;sha256:string;approved_at:Date|null}>(
        'SELECT body,sha256,approved_at FROM planning_profile_revisions WHERE tenant_id=$1 AND profile_id=$2 AND revision=$3',[this.tenantId,ref.id,ref.revision]);
      const row=found.rows[0];
      if(!row?.approved_at||row.sha256!==ref.sha256||profileDigest(parseProfile(row.body))!==ref.sha256){policyIssues.push('Pinned fleet profile evidence is unavailable.');continue;}
      const limits=manualSettings(row.body.settings).operatingLimits;
      if(limits&&operatingPolicyChanged(plan,limits))policyIssues.push('Fleet operating evidence is missing or exceeds its approved limits; Replan before approval.');
    }
    const extra:ApprovalBlocker[]=policyIssues.map(message=>({code:'settings_changed',message,target:{kind:'section',section:'constraints'}}));
    const physical=(messages:string[])=>{policyIssues.push(...messages);extra.push(...messages.map(message=>({code:'physical_loading' as const,message,target:{kind:'section' as const,section:'loading' as const}})));};
    if(scenario){
      try{const context=prepared?await prepared.loading():await this.loadingContext(client,scenario);
        const {source,required}=context;
        physical(loadingBlockers(plan,{...scenario,hardLoadingRequired:required},required||plan.physicalLoading?.mode==='hard'?source:undefined));
        if(required&&!source)physical(['Physical loading source is no longer admitted.']);
        if(plan.physicalLoading?.mode==='hard'&&!source)physical(['Physical loading source is no longer admitted.']);
      }catch(error){if(!(error as Error).message.startsWith('Physical loading:'))throw error;physical([(error as Error).message]);}
    }
    const state = event ? revision !== plan.scenarioRevision || event.detail.planSha256 !== hash || policyIssues.length>0 || loadingBlockers(plan,scenario??undefined).length>0 ? 'superseded'
      : event.action === 'plan.approve' ? 'approved' : 'reviewed' : 'draft';
    const core=approvalIssues(plan,revision,scenario??undefined);
    const freshness:PlanIdentity['freshness']=!scenario?'unknown':scenario.supersededBy?'archived':revision!==plan.scenarioRevision||policyIssues.length>0||canonical(plan.provenance?.planningProfiles??[])!==canonical(scenario.planningProfiles??[])?'stale':'current';
    return { plan, scenario, event, freshness, workflow: { state, version: event?.detail.version ?? 0, scenarioRevision: plan.scenarioRevision,
      currentRevision: revision, planSha256: hash, actor: event?.user_id ?? null, at: event?.created_at.toISOString() ?? null,
      blockers: [...new Set(core.map(issue=>issue.message)),...policyIssues],
      blockerDetails:{version:1,planId:plan.id,scenarioId:plan.scenarioId,planRevision:plan.scenarioRevision,currentRevision:revision,planSha256:hash,items:[...core,...extra]} } satisfies Workflow };
  }

  private async loadingContext(client:PoolClient,scenario:Scenario){
    const source=await loadingSource(client,this.tenantId,scenario);
    const required=await loadingRequired(client,this.tenantId,scenario,source,this.store.hardLoadingEnabled);
    return {source,required};
  }

  /** No row locks, object storage or native execution. Events and pointers come
   * from one MVCC snapshot. Loading-policy lookups are cached per scenario. */
  async catalogue(day?:string){
    return this.store.tx(async client=>{
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const clock=await client.query<{at:Date}>('SELECT transaction_timestamp() AS at');
      const rows=await client.query<{body:Scenario;revision:string}>("SELECT body,revision FROM scenarios WHERE tenant_id=$1 AND ($2::text IS NULL OR body->>'day'=$2)",[this.tenantId,day??null]);
      const scenarios=rows.rows.map(r=>({...r.body,revision:Number(r.revision)}));
      const found=await client.query<{body:Plan}>(`SELECT p.body FROM plans p JOIN scenarios s ON s.tenant_id=p.tenant_id AND s.id=p.scenario_id
        WHERE p.tenant_id=$1 AND ($2::text IS NULL OR s.body->>'day'=$2)`,[this.tenantId,day??null]);
      const plans=found.rows.map(r=>r.body),ids=plans.map(p=>p.id);
      const events=await client.query<ReviewEvent&{plan_id:string}>(`SELECT DISTINCT ON(e.detail->>'planId') e.detail->>'planId' AS plan_id,e.action,e.detail,e.user_id,e.created_at,u.email
        FROM audit_events e LEFT JOIN users u ON u.id=e.user_id
        WHERE e.tenant_id=$1 AND e.action IN ('plan.review','plan.approve') AND e.detail->>'planId'=ANY($2::text[])
        ORDER BY e.detail->>'planId',e.id DESC`,[this.tenantId,ids]);
      const byScenario=new Map(scenarios.map(s=>[s.id,s])),byEvent=new Map(events.rows.map(e=>[e.plan_id,e]));
      const loading=new Map<string,ReturnType<PlanWorkflow['loadingContext']>>();
      const identities=new Map<string,PlanIdentity>(),latest=new Map<string,Plan>();
      for(const p of plans){const old=latest.get(p.scenarioId);if(!old||p.createdAt>old.createdAt||p.createdAt===old.createdAt&&p.id>old.id)latest.set(p.scenarioId,p);}
      for(const plan of plans){
        const scenario=byScenario.get(plan.scenarioId);if(!scenario)continue;
        const current=await this.snapshot(client,plan.id,false,false,{plan,scenario,revision:scenario.revision,event:byEvent.get(plan.id),loading:()=>{
          let value=loading.get(scenario.id);if(!value){value=this.loadingContext(client,scenario);loading.set(scenario.id,value);}return value;
        }});
        const state=current.workflow.state;
        identities.set(plan.id,{version:1,planId:plan.id,scenarioId:scenario.id,planRevision:plan.scenarioRevision,scenarioRevision:scenario.revision,
          selected:(scenario.selectedPlanId??scenario.manualPlanId)===plan.id,latest:latest.get(scenario.id)?.id===plan.id,
          approval:(state==='approved'||state==='reviewed')&&(current.freshness!=='current'||current.workflow.blockers.length>0)?'superseded':state,
          freshness:current.freshness,checkedAt:clock.rows[0]!.at.toISOString(),planSha256:current.workflow.planSha256});
      }
      return {scenarios,plans:plans.map(withNormalizedPlanStats),identities};
    });
  }

  async get(id: string): Promise<Workflow> {
    return this.store.tx(async client => (await this.snapshot(client, id, true)).workflow);
  }

  /** Render bytes, not a lazy/streamed response, while the scenario lock is held.
   * Network delivery is outside the transaction; checkedAt defines the snapshot. */
  async renderExport(id: string, requireApproved: boolean, render: (plan: Plan, metadata: HandoffMetadata) => string,
    persist?:(client:PoolClient,plan:Plan,metadata:HandoffMetadata,body:string)=>Promise<void>,
    authorize?:(client:PoolClient)=>Promise<void>): Promise<{ body: string; metadata: HandoffMetadata }> {
    return this.store.tx(async client => {
      await authorize?.(client);
      const { plan, scenario, event, workflow } = await this.snapshot(client, id, true, true);
      const fresh = scenario !== null && workflow.currentRevision === plan.scenarioRevision;
      const approved = workflow.state === 'approved' && fresh && workflow.blockers.length === 0;
      const status = approved ? 'Approved' : !fresh || workflow.state === 'superseded' || workflow.state === 'approved' ? 'Superseded' : 'Draft';
      if (requireApproved && !approved) throw new WorkflowError(409, 'This plan is not currently approved. Refresh its review status or download an ordinary draft/superseded export.');
      const historical = event?.detail.scenarioSnapshot;
      const recorded = historical?.id === plan.scenarioId && historical.revision === plan.scenarioRevision ? historical : null;
      const actor: HandoffActor = event?.user_id ? {
        userId: event.user_id, email: event.detail.actor?.userId === event.user_id ? event.detail.actor.email : event.email,
        identitySource: event.detail.actor?.userId === event.user_id ? 'approval-event' : 'user-record',
      } : { userId: null, email: null, identitySource: event ? 'local' : 'unavailable' };
      const clock = await client.query<{ at: Date }>('SELECT clock_timestamp() AS at');
      const metadata: HandoffMetadata = {
        version: 1, status, planId: plan.id, scenarioId: plan.scenarioId, scenarioRevision: plan.scenarioRevision,
        currentScenarioRevision: scenario ? workflow.currentRevision : null, planSha256: workflow.planSha256,
        checkedAt: clock.rows[0]!.at.toISOString(),
        approval: event?.action === 'plan.approve' ? { workflowVersion: workflow.version, approvedAt: event.created_at.toISOString(),
          approver: actor, exceptionsAcknowledged: event.detail.acknowledgedExceptions === true } : null,
        blockers: [...workflow.blockers, ...(!scenario ? ['Plan scenario no longer exists.'] : [])],
        constraints: constraintSnapshot(plan, fresh ? scenario : recorded, fresh ? 'matching-revision' : recorded ? 'approval-event' : 'unavailable'),
        policy: plan.provenance?.planningPolicy ?? null,
      };
      const normalized=withNormalizedPlanStats(plan),body=render(normalized,metadata);
      await persist?.(client,normalized,metadata,body);
      return { body, metadata };
    });
  }

  async transition(id: string, action: 'plan.review' | 'plan.approve', version: number, revision: number,
    acknowledgeExceptions: boolean, actor?: Principal): Promise<Workflow> {
    return this.store.tx(async client => {
      const { plan, scenario, workflow } = await this.snapshot(client, id, true);
      if (workflow.version !== version || workflow.currentRevision !== revision)
        throw new WorkflowError(409, 'Plan review changed. Reload before continuing.');
      if (workflow.blockers.length) throw new WorkflowError(409, workflow.blockers.join(' '));
      if (!acknowledgeExceptions) throw new WorkflowError(400, 'Explicit acknowledgement of constraints and approved policy exceptions is required.');
      if (action === 'plan.review' && workflow.state !== 'draft') throw new WorkflowError(409, 'Only a draft plan can be reviewed.');
      if (action === 'plan.approve' && workflow.state !== 'reviewed') throw new WorkflowError(409, 'Review the current plan before approval.');
      await client.query(`INSERT INTO audit_events(tenant_id,user_id,action,detail) VALUES($1,$2,$3,$4)`,
        [this.tenantId, actor?.userId ?? null, action, { planId: id, scenarioId: plan.scenarioId,
          scenarioRevision: plan.scenarioRevision, planSha256: workflow.planSha256, version: version + 1,
          acknowledgedExceptions: true, actorMode: actor ? 'authenticated' : 'local',
          actor: actor ? { userId: actor.userId, email: actor.email } : null, scenarioSnapshot: scenario }]);
      return (await this.snapshot(client, id, false)).workflow;
    });
  }
}
