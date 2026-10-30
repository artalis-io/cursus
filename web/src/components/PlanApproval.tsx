import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError } from '@/lib/api';
import { usePermission } from '@/permissions';
import { useI18n } from '@/i18n';
import {isWorkflowEvidence} from '@/lib/workspace-status';
import type { Workflow } from '../../../server/src/workflow-contract';

export interface ApprovalEvidence {
  workflow: Workflow | null;
  phase: 'loading' | 'ready' | 'unavailable' | 'error';
}

/** One owner for both compact evidence and the existing approval controls.
 * Opening/collapsing details never refetches, remounts or grants permission. */
export function PlanApproval({ planId, revision, pending, children }: {
  planId: string; revision: number; pending: boolean;
  children?: (evidence: ApprovalEvidence, detail: ReactNode) => ReactNode;
}) {
  const { lang } = useI18n(); const hu = lang === 'hu';
  const canReview = usePermission('plan.review'), canApprove = usePermission('plan.approve');
  const context = `${planId}/${revision}`;
  const [record, setRecord] = useState<{ context: string; value: Workflow } | null>(null);
  const [phase, setPhase] = useState<ApprovalEvidence['phase']>('loading');
  const workflow = record?.context === context ? record.value : null;
  const [error, setError] = useState<string | null>(null);
  const [ack, setAck] = useState(false), [busy, setBusy] = useState(false);
  const retry = useRef<() => void>(() => {});
  const generation = useRef({ value: 0 });
  useLayoutEffect(() => { const clock = generation.current; clock.value++; return () => { clock.value++; }; }, [planId, revision]);
  const accepted = useRef<{context:string; value:Workflow}|null>(null);
  useLayoutEffect(() => { setAck(false); }, [canReview, canApprove]);
  const accept = useCallback((next: Workflow) => {
    const previous = accepted.current;
    if (previous?.context === context) {
      if (previous.value.version > next.version || previous.value.currentRevision > next.currentRevision) return false;
      if (JSON.stringify(previous.value) !== JSON.stringify(next)) setAck(false);
    }
    accepted.current = {context,value:next}; setRecord({context,value:next}); return true;
  }, [context]);
  useEffect(() => {
    let alive = true, fetching = false;
    setRecord(null); setPhase('loading'); setError(null); setAck(false); setBusy(false);
    const refresh = async () => {
      if (fetching) return; fetching = true;
      try { const result = await api.planWorkflow(planId); if (!isWorkflowEvidence(result)) throw Error('Invalid approval response.'); if (alive) { if (!accept(result)) throw Error('Approval evidence moved backwards.'); setError(null); setPhase('ready'); } }
      catch (e) { if (alive) {
        const unavailable = e instanceof ApiError && e.status === 404;
        setAck(false); setPhase(unavailable ? 'unavailable' : 'error');
        setError(unavailable ? null : (e as Error).message);
      } }
      finally { fetching = false; }
    };
    retry.current = () => { if (!fetching) { setError(null); setPhase('loading'); void refresh(); } };
    void refresh(); const timer = setInterval(() => { void refresh(); }, 5000);
    return () => { alive = false; retry.current = () => {}; clearInterval(timer); };
  }, [planId, revision, accept]);
  // Revision-bound evidence prevents a previous Approved response from flashing
  // while a new revision is loading. Failed/404 reads never certify approval.
  const evidencePhase = error ? 'error' : !workflow && phase === 'ready' ? 'loading' : phase;
  const labels = hu ? { draft: 'Tervezet', reviewed: 'Ellenőrizve', approved: 'Jóváhagyva', superseded: 'Elavult' }
    : { draft: 'Draft', reviewed: 'Reviewed', approved: 'Approved', superseded: 'Superseded' };
  const actionable = !!workflow && evidencePhase === 'ready' && !error && workflow.blockers.length === 0 && workflow.currentRevision === revision && workflow.scenarioRevision === revision && !pending && !busy;
  const act = async (action: 'review' | 'approve') => {
    if (!workflow || !actionable || !ack) return;
    const epoch = generation.current.value;
    setBusy(true); setError(null);
    try { const next = await api.transitionPlan(planId, action, workflow.version, revision, ack); if (epoch === generation.current.value) { accept(next); setAck(false); } }
    catch (e) { if (epoch === generation.current.value) { setAck(false); setError((e as Error).message); } }
    finally { if (epoch === generation.current.value) setBusy(false); }
  };
  const detail = <section data-plan-id={planId} aria-label={hu ? 'Terv jóváhagyása' : 'Plan approval'} className="border-b border-divider pb-3 text-xs">
    <div className="flex flex-wrap items-center gap-3">
      <strong>{hu ? 'Terv ellenőrzése' : 'Plan review'} · {evidencePhase === 'ready' && workflow ? labels[workflow.state] : hu ? 'Ismeretlen' : 'Unknown'}</strong>
      {workflow && evidencePhase === 'ready' && <>
        <span className="text-muted-foreground">{hu ? 'Forgatókönyv-verzió' : 'Scenario revision'} {workflow.scenarioRevision}</span>
        {workflow.at && <span className="text-muted-foreground">{new Date(workflow.at).toLocaleString()}</span>}
        {actionable && ((canReview && workflow.state === 'draft') || (canApprove && workflow.state === 'reviewed')) && <>
          <label className="flex items-center gap-2"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} />
            {hu ? 'Ellenőriztem a korlátokat és a jóváhagyott kivételeket.' : 'I reviewed constraints and approved policy exceptions.'}</label>
          <button type="button" className="rounded border border-divider px-2 py-1 disabled:opacity-40" disabled={!ack} onClick={() => void act(workflow.state === 'draft' ? 'review' : 'approve')}>
            {workflow.state === 'draft' ? hu ? 'Ellenőrzöttnek jelölés' : 'Mark reviewed' : hu ? 'Terv jóváhagyása' : 'Approve plan'}</button>
        </>}
        {workflow.blockers.length > 0 && <p className="w-full text-muted-foreground">{hu ? 'A jóváhagyás feltételei nem teljesülnek.' : workflow.blockers.join(' ')}</p>}
      </>}
    </div>
    {evidencePhase !== 'ready' && <p className="mt-1 text-muted-foreground">{hu ? evidencePhase === 'loading' ? 'Jóváhagyási állapot betöltése…' : 'A jóváhagyási állapot nem érhető el.' : evidencePhase === 'loading' ? 'Loading approval status…' : 'Approval status unavailable.'}
      {evidencePhase !== 'loading' && <button type="button" className="ml-2 underline" onClick={() => retry.current()}>{hu ? 'Újra' : 'Retry approval status'}</button>}
    </p>}
    {error && <p role="alert" className="mt-1 text-destructive">{error}</p>}
  </section>;
  return children ? children({ workflow, phase: error ? 'error' : evidencePhase }, detail) : detail;
}
