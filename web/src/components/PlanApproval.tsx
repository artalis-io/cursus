import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { usePermission } from '@/permissions';
import { useI18n } from '@/i18n';
import type { Workflow } from '../../../server/src/workflow-contract';

/** Read-only visibility for every role; actions always re-authorized by the API. */
export function PlanApproval({ planId, revision, pending }: { planId: string; revision: number; pending: boolean }) {
  const { lang } = useI18n(); const hu = lang === 'hu';
  const canReview = usePermission('plan.review'), canApprove = usePermission('plan.approve');
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ack, setAck] = useState(false), [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true, fetching = false;
    setWorkflow(null); setError(null); setAck(false);
    const refresh = async () => {
      if (fetching) return; fetching = true;
      try { const result = await api.planWorkflow(planId); if (alive) { setWorkflow(result); setError(null); } }
      catch (e) { if (alive && (!(e instanceof ApiError) || e.status !== 404)) setError((e as Error).message); }
      finally { fetching = false; }
    };
    void refresh(); const timer = setInterval(() => { void refresh(); }, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [planId, revision]);
  if (!workflow) return error ? <div role="alert" className="px-4 py-2 text-xs text-destructive">{error}</div> : null;
  const labels = hu ? { draft: 'Tervezet', reviewed: 'Ellenőrizve', approved: 'Jóváhagyva', superseded: 'Elavult' }
    : { draft: 'Draft', reviewed: 'Reviewed', approved: 'Approved', superseded: 'Superseded' };
  const actionable = workflow.blockers.length === 0 && workflow.currentRevision === revision && workflow.scenarioRevision === revision && !pending && !busy;
  const act = async (action: 'review' | 'approve') => {
    setBusy(true); setError(null);
    try { setWorkflow(await api.transitionPlan(planId, action, workflow.version, revision, ack)); setAck(false); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <section aria-label={hu ? 'Terv jóváhagyása' : 'Plan approval'} className="shrink-0 border-b border-divider px-4 py-2 text-xs">
    <div className="flex flex-wrap items-center gap-3">
      <strong>{hu ? 'Terv ellenőrzése' : 'Plan review'} · {labels[workflow.state]}</strong>
      <span className="text-muted-foreground">{hu ? 'Forgatókönyv-verzió' : 'Scenario revision'} {workflow.scenarioRevision}</span>
      {workflow.at && <span className="text-muted-foreground">{new Date(workflow.at).toLocaleString()}</span>}
      {actionable && ((canReview && workflow.state === 'draft') || (canApprove && workflow.state === 'reviewed')) && <>
        <label className="flex items-center gap-2"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} />
          {hu ? 'Ellenőriztem a korlátokat és a jóváhagyott kivételeket.' : 'I reviewed constraints and approved policy exceptions.'}</label>
        <button className="rounded border border-divider px-2 py-1 disabled:opacity-40" disabled={!ack} onClick={() => void act(workflow.state === 'draft' ? 'review' : 'approve')}>
          {workflow.state === 'draft' ? hu ? 'Ellenőrzöttnek jelölés' : 'Mark reviewed' : hu ? 'Terv jóváhagyása' : 'Approve plan'}</button>
      </>}
    </div>
    {workflow.blockers.length > 0 && <p className="mt-1 text-muted-foreground">{hu ? 'A jóváhagyás feltételei nem teljesülnek.' : workflow.blockers.join(' ')}</p>}
    {error && <p role="alert" className="mt-1 text-destructive">{error}</p>}
  </section>;
}
