import type { StatefulStore } from './postgres.js';
import type { Plan } from '../types.js';
import type { Scenario } from '../store.js';
import { WorkflowError, approvalBlockers } from './plan-workflow.js';
/** Selection is not approval and does not edit the planning revision. */
export async function selectPlan(store: StatefulStore, tenantId: string, scenarioId: string, revision: number,
  planId: string, selectionVersion: number, acknowledgeIncomplete: boolean,
  policyIssues?: (plan: Plan) => string[], actorId?: string) {
  return store.tx(async client => {
    if(actorId){const membership=await client.query<{role:string}>('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2 FOR SHARE',[tenantId,actorId]);
      if(!['admin','planner'].includes(membership.rows[0]?.role??''))throw new WorkflowError(403,'Plan selection permission changed.');}
    const row = await client.query<{revision:string;body:Scenario}>('SELECT revision,body FROM scenarios WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenantId,scenarioId]);
    if (!row.rows[0]) throw new WorkflowError(404,'Scenario not found.');
    const scenario=row.rows[0].body;
    if (Number(row.rows[0].revision)!==revision || (scenario.selectionVersion??0)!==selectionVersion) throw new WorkflowError(409,'Scenario or selected plan changed; reload before choosing a result.');
    const found=await client.query<{body:Plan}>('SELECT body FROM plans WHERE tenant_id=$1 AND id=$2',[tenantId,planId]);
    const plan=found.rows[0]?.body;
    if (!plan) throw new WorkflowError(404,'Plan not found.');
    if (plan.scenarioId!==scenarioId || plan.scenarioRevision!==revision) throw new WorkflowError(409,'The result does not match the current scenario revision.');
    if (plan.stats.servedOrders + plan.unassigned.length !== plan.stats.totalOrders)
      throw new WorkflowError(409,'Candidate coverage is inconsistent.');
    const blockers=[...approvalBlockers(plan,revision,scenario),...(policyIssues?.(plan)??[])];
    const coverage='Approval requires complete, consistent order coverage.';
    if (blockers.some(issue=>issue!==coverage) || blockers.includes(coverage)&&!acknowledgeIncomplete) throw new WorkflowError(409,blockers.join(' '));
    const updated={...scenario,selectedPlanId:planId,selectionVersion:selectionVersion+1,
      ...(scenario.manualDecisions?{manualPlanId:planId}:{})};
    await client.query('UPDATE scenarios SET body=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2',[tenantId,scenarioId,updated]);
    await client.query("INSERT INTO audit_events(tenant_id,user_id,action,detail) VALUES($1,$2,'plan.select',$3)",[tenantId,actorId??null,{scenarioId,planId,revision,selectionVersion:updated.selectionVersion,acknowledgeIncomplete}]);
    return updated;
  });
}
