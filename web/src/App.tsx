import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, PanelTopClose, PanelTopOpen, PanelBottomClose, PanelBottomOpen, RotateCcw } from 'lucide-react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { TopBar } from '@/components/TopBar';
import { KpiStrip } from '@/components/KpiStrip';
import { ReadinessPanel } from '@/components/ReadinessPanel';
import { PlanApproval } from '@/components/PlanApproval';
import { ResizeHandle } from '@/components/ResizeHandle';
import { useWorkspaceLayout } from '@/useWorkspaceLayout';
import { FleetPanel } from '@/components/FleetPanel';
import { Inspector } from '@/components/Inspector';
import { Timeline } from '@/components/Timeline';
import { MapView } from '@/map/MapView';
import { CompareDialog } from '@/components/CompareDialog';
import { ImportDialog } from '@/components/ImportDialog';
import { HistoryDialog } from '@/components/HistoryDialog';
import { ChangesDialog } from '@/components/ChangesDialog';
import { WeekDialog } from '@/components/WeekDialog';
import { IssuesDialog } from '@/components/IssuesDialog';
import { ScenariosDialog } from '@/components/ScenariosDialog';
import { HelpOverlay } from '@/components/HelpOverlay';
import { api, ApiError, pollJob } from '@/lib/api';
import { useT, describeApiError } from '@/i18n';
import type { DaySummary, Job, Objective, Plan, Scenario, ScenarioEdit, Selection } from '@/types';
import { StaleWorkspaceContext, usePermission } from '@/permissions';

/* The live solve budget for UI-triggered solves. The saved baseline used ~240s
 * to reach day-1 117/0; 60s gives a believable, genuinely-elapsed optimize/replan
 * for the demo (status is reported honestly whatever the budget). Override with
 * VITE_SOLVE_SECONDS. */
const SOLVE_BUDGET_SEC = Number(import.meta.env.VITE_SOLVE_SECONDS ?? 60);

export interface JobView { id: string; status: Job['status']; elapsedSec: number; scenarioId: string; error: string | null }

/* A running solve is persisted so a page reload can reconnect to it (the solve
 * runs server-side, independent of the tab). */
const ACTIVE_JOB_KEY = 'otto.activeJob';
interface ActiveJobRef { jobId: string; scenarioId: string; dayId: string }
function persistActiveJob(v: ActiveJobRef | null): void {
  try { if (v) localStorage.setItem(ACTIVE_JOB_KEY, JSON.stringify(v)); else localStorage.removeItem(ACTIVE_JOB_KEY); } catch { /* ignore */ }
}
function readActiveJob(): ActiveJobRef | null {
  try { const s = localStorage.getItem(ACTIVE_JOB_KEY); return s ? (JSON.parse(s) as ActiveJobRef) : null; } catch { return null; }
}

function hasCompleteRouteGeometry(plan: Plan): boolean {
  return plan.vehicles.every((vehicle) => vehicle.trips.every((trip) =>
    trip.stops.length === 0 || (trip.geometry?.coordinates.length ?? 0) >= 2));
}

/** Velo geometry is derived and may be temporarily incomplete under load.
 * Refetch a partial plan a few times; the backend only retries missing trips. */
async function loadPlanWithGeometry(id: string): Promise<Plan> {
  let plan = await api.plan(id);
  for (let attempt = 1; attempt < 3 && !hasCompleteRouteGeometry(plan); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    plan = await api.plan(id);
  }
  return plan;
}

/* Preview the plan-wide distance/cost of staged (not-yet-replanned) reorders, so
 * the top KPI strip can show where the numbers are heading before Replan. Only
 * reorders are previewable: the stops are unchanged so the backend can recompute
 * each affected trip exactly (a reassignment would need a full re-solve). Returns
 * null when nothing is staged / in flight. */
function usePreviewTotals(plan: Plan | null, scenario: Scenario | null): { distanceKm: number; costTotal: number | null } | null {
  const [res, setRes] = useState<{ distanceKm: number; costTotal: number | null } | null>(null);
  const jobs = useMemo(() => {
    const out: { vehicleId: number; tripIndex: number; startSec: number; reloadSecAfter: number; orderNos: string[]; oldDist: number; oldCost: number }[] = [];
    if (!plan || !scenario) return out;
    for (const q of scenario.sequences) {
      if (q.locked) continue;
      const v = plan.vehicles.find((x) => x.id === q.vehicleId);
      if (!v) continue;
      const pos = new Map(q.orderNos.map((o, i) => [o, i]));
      for (const trip of v.trips) {
        const current = trip.stops.map((s) => s.orderNo);
        const reordered = [...current].sort((a, b) => (pos.get(a) ?? Infinity) - (pos.get(b) ?? Infinity));
        if (current.length === reordered.length && current.every((o, i) => o === reordered[i])) continue;
        out.push({ vehicleId: v.id, tripIndex: trip.index, startSec: trip.startSec, reloadSecAfter: trip.reloadSecAfter, orderNos: reordered, oldDist: trip.distanceKm, oldCost: trip.costFt ?? 0 });
      }
    }
    return out;
  }, [plan, scenario]);
  const key = plan ? `${plan.id}|${jobs.map((j) => `${j.vehicleId}:${j.tripIndex}:${j.orderNos.join('.')}`).join('|')}` : '';
  useEffect(() => {
    if (!plan || jobs.length === 0) { setRes(null); return; }
    let cancelled = false;
    Promise.all(jobs.map((j) => api.evaluateTrip(plan.id, { vehicleId: j.vehicleId, tripIndex: j.tripIndex, startSec: j.startSec, reloadSecAfter: j.reloadSecAfter, orderNos: j.orderNos })
      .then((r) => ({ dDist: r.trip.distanceKm - j.oldDist, dCost: (r.trip.costFt ?? 0) - j.oldCost }))
      .catch(() => null)))
      .then((results) => {
        if (cancelled) return;
        const ok = results.filter(Boolean) as { dDist: number; dCost: number }[];
        if (ok.length === 0) { setRes(null); return; }
        const dDist = ok.reduce((a, r) => a + r.dDist, 0);
        const dCost = ok.reduce((a, r) => a + r.dCost, 0);
        setRes({ distanceKm: plan.stats.totalDistanceKm + dDist, costTotal: plan.cost ? plan.cost.total + dCost : null });
      });
    return () => { cancelled = true; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return res;
}

/** A short, localized confirmation for a staged edit, for the toast. */
function editMessage(edit: ScenarioEdit, t: (k: string, p?: Record<string, string | number>) => string, refOf: (id: number) => string): string {
  switch (edit.op) {
    case 'pin': return t('toast.pin', { o: edit.orderNo, v: refOf(edit.vehicleId) });
    case 'unpin': return t('toast.unpin', { o: edit.orderNo });
    case 'forbid': return t('toast.forbid', { o: edit.orderNo, v: refOf(edit.vehicleId) });
    case 'removeVehicle': return t('toast.removed', { v: refOf(edit.vehicleId) });
    case 'restoreVehicle': return t('toast.restored', { v: refOf(edit.vehicleId) });
    case 'setVehicleConstraint': return t('toast.constraint', { v: refOf(edit.vehicleId) });
    case 'setSequence': return t(edit.locked ? 'toast.locked' : 'toast.resequenced', { v: refOf(edit.vehicleId) });
    case 'clearSequence': return t('toast.unlocked', { v: refOf(edit.vehicleId) });
    case 'clearOverrides': return t('toast.cleared');
    default: return t('toast.staged');
  }
}

/** Structural equality for selection history de-duplication. */
function sameSel(a: Selection, b: Selection): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export default function App() {
  const [freshnessError, setFreshnessError] = useState<string | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const navigationGeneration = useRef(0);
  const canEdit = usePermission('scenario.edit') && !freshnessError && !workspaceLoading;
  const canSolve = usePermission('optimization.submit') && !freshnessError && !workspaceLoading;
  const canCancel = usePermission('optimization.cancel');
  const canEvaluate = usePermission('plan.evaluate') && !freshnessError && !workspaceLoading;
  // Async callbacks can outlive the render that authorized them. Recheck at
  // dispatch, and invalidate queued intents across revocation/regrant cycles.
  const writeAccess = useRef({ edit: canEdit, solve: canSolve, cancel: canCancel, epoch: 0, mounted: true });
  useLayoutEffect(() => {
    const access = writeAccess.current;
    if (access.edit !== canEdit || access.solve !== canSolve || access.cancel !== canCancel) access.epoch++;
    Object.assign(access, { edit: canEdit, solve: canSolve, cancel: canCancel });
  }, [canEdit, canSolve, canCancel]);
  useLayoutEffect(() => {
    const access = writeAccess.current;
    access.mounted = true;
    return () => { access.mounted = false; access.epoch++; };
  }, []);
  const t = useT();
  const [days, setDays] = useState<DaySummary[]>([]);
  const [dayId, setDayId] = useState<string>('day1');
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [baseline, setBaseline] = useState<Plan | null>(null);
  const [pendingEdits, setPendingEdits] = useState(0);
  // Selection history: browser-style back/forward through inspected items.
  const [nav, setNav] = useState<{ stack: Selection[]; idx: number }>({ stack: [null], idx: 0 });
  const selection = nav.stack[nav.idx] ?? null;
  const navigate = useCallback((sel: Selection) => {
    setNav((n) => {
      if (sameSel(n.stack[n.idx] ?? null, sel)) return n;
      const stack = [...n.stack.slice(0, n.idx + 1), sel].slice(-50);
      return { stack, idx: stack.length - 1 };
    });
  }, []);
  const resetSelection = useCallback(() => setNav({ stack: [null], idx: 0 }), []);
  const goBack = useCallback(() => setNav((n) => (n.idx > 0 ? { ...n, idx: n.idx - 1 } : n)), []);
  const goForward = useCallback(() => setNav((n) => (n.idx < n.stack.length - 1 ? { ...n, idx: n.idx + 1 } : n)), []);
  const canGoBack = nav.idx > 0;
  const canGoForward = nav.idx < nav.stack.length - 1;
  const [job, setJob] = useState<JobView | null>(null);
  // Covers the whole click -> enqueue -> poll -> publish lifecycle. `job` is
  // replaced between those phases, so deriving UI state from it alone can
  // briefly render the idle Optimize control between two active states.
  const [solveActive, setSolveActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const [weekOpen, setWeekOpen] = useState(false);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [scenariosOpen, setScenariosOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  // Show the guided overlay on first run (once), and from the TopBar '?'.
  useEffect(() => { try { if (!localStorage.getItem('otto.helpSeen')) setHelpOpen(true); } catch { /* ignore */ } }, []);
  const closeHelp = useCallback(() => { setHelpOpen(false); try { localStorage.setItem('otto.helpSeen', '1'); } catch { /* ignore */ } }, []);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const workspace = useWorkspaceLayout(leftOpen, rightOpen);
  // Fleet-panel filter (tail-lift / advisories / search) -> the map shows only
  // the matching vehicles' routes. null = no filter (show all).
  const [visibleVehicleIds, setVisibleVehicleIds] = useState<number[] | null>(null);
  const [objective, setObjective] = useState<Objective>('vehicles');
  const [budgetSec, setBudgetSec] = useState<number>(SOLVE_BUDGET_SEC);
  const [fullBudget, setFullBudget] = useState(false); // keep searching until the time limit
  // Timeline playback: a clock (sec from midnight) swept across the planned day.
  const [clockSec, setClockSec] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(360); // plan-seconds advanced per real second

  const activeJobId = useRef<string | null>(null);
  const pollAbort = useRef<AbortController | null>(null);
  const scenarioRef = useRef<Scenario | null>(null);
  // Manual edits are persisted asynchronously. Replan awaits this queue and
  // reads scenarioRef so it cannot solve the pre-reorder scenario when clicked
  // immediately after moving a stop.
  const editQueue = useRef<Promise<boolean>>(Promise.resolve(true));
  const pendingEditsRef = useRef(pendingEdits);
  useLayoutEffect(() => { pendingEditsRef.current = pendingEdits; }, [pendingEdits]);
  const rejectStaleIntent = useCallback((error: unknown) => {
    if (error instanceof ApiError && (error.status === 409 || error.status === 428)) {
      writeAccess.current.epoch++;
      writeAccess.current.edit = false;
      writeAccess.current.solve = false;
      setFreshnessError('freshness.changed');
    }
  }, []);
  useEffect(() => {
    if (!scenario) return;
    let stopped = false, busy = false;
    setFreshnessError(null);
    const check = async () => {
      if (busy || pendingEditsRef.current > 0 || document.hidden) return;
      const snapshot = scenarioRef.current;
      if (!snapshot) return;
      busy = true;
      try {
        const latest = await api.scenario(snapshot.id);
        if (!stopped && pendingEditsRef.current === 0 && scenarioRef.current === snapshot && latest.revision !== snapshot.revision) {
          writeAccess.current.epoch++;
          writeAccess.current.edit = false; writeAccess.current.solve = false;
          setFreshnessError('freshness.changed');
        }
      } catch {
        if (!stopped && pendingEditsRef.current === 0 && scenarioRef.current === snapshot) {
          writeAccess.current.epoch++;
          writeAccess.current.edit = false; writeAccess.current.solve = false;
          setFreshnessError('freshness.unverified');
        }
      } finally { busy = false; }
    };
    const timer = setInterval(() => { void check(); }, 5000);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => { stopped = true; clearInterval(timer); window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', check); };
  }, [scenario]);
  // Transient toast for staged-edit feedback.
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2800);
  }, []);
  // Keep elapsed time visibly moving between API polls (and while the enqueue
  // request is in flight). The server remains authoritative; this is a local
  // display clock and poll responses can only move it forwards.
  useEffect(() => {
    if (job?.status !== 'pending' && job?.status !== 'running') return;
    const timer = setInterval(() => setJob((current) => current && (current.status === 'pending' || current.status === 'running')
      ? { ...current, elapsedSec: current.elapsedSec + 1 } : current), 1000);
    return () => clearInterval(timer);
  }, [job?.id, job?.status]);
  // Latest non-null plan, for edit-toast vehicle-ref lookups without dep churn.
  const planRef = useRef<Plan | null>(null);

  // Initial load: days, then reconnect to a running solve if one survives a
  // reload, else load the day-1 baseline.
  useEffect(() => {
    (async () => {
      try {
        const ds = await api.days();
        setDays(ds);
        if (!(await tryResume(ds))) await loadDay(ds.find((d) => d.id === 'day1') ?? ds[0]!);
      } catch (e) { setError(describeApiError(e, t)); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadDay = useCallback(async (d: DaySummary) => {
    const generation = ++navigationGeneration.current;
    setWorkspaceLoading(true);
    writeAccess.current.epoch++;
    pollAbort.current?.abort();
    activeJobId.current = null;
    persistActiveJob(null);
    setJob(null);
    setPlaying(false); setClockSec(null);
    resetSelection();
    try {
      const [base, latest] = await Promise.all([loadPlanWithGeometry(d.baselinePlanId), api.scenario(d.baseScenarioId)]);
      if (generation !== navigationGeneration.current) return;
      setDayId(d.id); setBaseline(base); setPlan(base); setScenario(latest);
    } finally { if (generation === navigationGeneration.current) setWorkspaceLoading(false); }
  }, []);

  // Follow a running job (already created) to its terminal state; apply + return
  // the plan only if still current. Shared by fresh solves and reload-resume.
  const followJob = useCallback(async (jobId: string, scenarioId: string, dayId: string, ctrl: AbortController): Promise<Plan | null> => {
    activeJobId.current = jobId;
    persistActiveJob({ jobId, scenarioId, dayId });
    setJob({ id: jobId, status: 'running', elapsedSec: 0, scenarioId, error: null });
    try {
      const final = await pollJob(jobId, (j) => {
        if (activeJobId.current !== jobId) return;
        setJob((current) => ({ id: j.id, status: j.status,
          elapsedSec: Math.max(current?.elapsedSec ?? 0, j.elapsedSec), scenarioId, error: j.error }));
      }, { signal: ctrl.signal });
      if (activeJobId.current !== jobId) return null; // superseded
      persistActiveJob(null);
      if (final.status === 'completed' && final.planId) {
        const revised = await loadPlanWithGeometry(final.planId);
        setPlan(revised);
        resetSelection();
        return revised;
      }
      if (final.status === 'failed') setError(final.error ?? 'Optimization failed.');
      return null;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return null;
      persistActiveJob(null);
      setError(describeApiError(e, t));
      setJob((j) => (j ? { ...j, status: 'failed', error: String(e) } : j));
      return null;
    }
  }, []);

  // Run a live solve of a scenario with the current objective/budget.
  const runSolve = useCallback(async (scenarioId: string, dayIdForJob: string): Promise<Plan | null> => {
    if (!writeAccess.current.mounted || !writeAccess.current.solve) return null;
    pollAbort.current?.abort();
    const ctrl = new AbortController();
    pollAbort.current = ctrl;
    setError(null);
    setJob({ id: '', status: 'pending', elapsedSec: 0, scenarioId, error: null });
    try {
      const current = scenarioRef.current;
      if (!current || current.id !== scenarioId) return null;
      const { jobId } = await api.solve(scenarioId, current.revision, budgetSec, objective, fullBudget);
      return await followJob(jobId, scenarioId, dayIdForJob, ctrl);
    } catch (e) {
      if ((e as Error).name === 'AbortError') return null;
      rejectStaleIntent(e);
      setError(describeApiError(e, t));
      setJob(null);
      return null;
    }
  }, [budgetSec, objective, fullBudget, followJob, rejectStaleIntent]);

  // Cancel the active solve (server-side) and drop back to the current plan.
  const cancelSolve = useCallback(async () => {
    if (!writeAccess.current.mounted || !writeAccess.current.cancel) return;
    const id = activeJobId.current;
    if (!id) { pollAbort.current?.abort(); setJob(null); return; }
    activeJobId.current = null;
    pollAbort.current?.abort();
    persistActiveJob(null);
    try { await api.cancelJob(id); } catch { /* best effort */ }
    setJob(null);
  }, []);

  // Reconnect to a solve persisted before a reload. Returns true if it set up state.
  const tryResume = useCallback(async (ds: DaySummary[]): Promise<boolean> => {
    const ref = readActiveJob();
    if (!ref) return false;
    try {
      const j = await api.job(ref.jobId);
      if (j.status === 'failed' || j.status === 'cancelled') { persistActiveJob(null); return false; }
      const sc = await api.scenario(ref.scenarioId);
      const d = ds.find((x) => x.id === sc.day) ?? ds.find((x) => x.id === ref.dayId);
      if (!d) { persistActiveJob(null); return false; }
      setDayId(d.id);
      setBaseline(await loadPlanWithGeometry(d.baselinePlanId));
      setScenario(sc);
      if (j.status === 'completed' && j.planId) {
        persistActiveJob(null);
        setPlan(await loadPlanWithGeometry(j.planId));
        return true;
      }
      // still running: show its scenario's last plan context and resume polling
      setPlan(await loadPlanWithGeometry(d.baselinePlanId));
      const ctrl = new AbortController();
      pollAbort.current = ctrl;
      void followJob(ref.jobId, ref.scenarioId, d.id, ctrl);
      return true;
    } catch { persistActiveJob(null); return false; }
  }, [followJob]);

  // Apply a manual override (forks an editable copy from a base scenario). Does
  // not solve; overrides take effect on the next Replan. A toast confirms the
  // staged edit so the tune loop has positive feedback (nothing else changes
  // on the map until Replan).
  const applyEdit = useCallback((edit: ScenarioEdit): Promise<boolean> => {
    if (!writeAccess.current.mounted || !writeAccess.current.edit) return Promise.resolve(false);
    setPendingEdits(n => n + 1);
    const epoch = writeAccess.current.epoch;
    const queued = editQueue.current.then(async () => {
      if (!writeAccess.current.mounted || !writeAccess.current.edit || epoch !== writeAccess.current.epoch) return false;
      const current = scenarioRef.current;
      if (!current) return false;
      try {
        const label = current.kind === 'base' ? t('scn.edited', { day: current.label }) : undefined;
        const updated = await api.editScenario(current.id, current.revision, edit, label);
        scenarioRef.current = updated;
        setScenario(updated);
        showToast(editMessage(edit, t, (id) => planRef.current?.vehicles.find((v) => v.id === id)?.ref ?? `#${id}`));
        return true;
      } catch (e) { rejectStaleIntent(e); setError(describeApiError(e, t)); return false; }
    });
    void queued.finally(() => { if (writeAccess.current.mounted) setPendingEdits(n => Math.max(0, n - 1)); });
    editQueue.current = queued;
    return queued;
  }, [showToast, t, rejectStaleIntent]);

  // Apply several staged edits at once (bulk actions); one fork + one revision.
  const applyEdits = useCallback((edits: ScenarioEdit[], toastMsg?: string): Promise<boolean> => {
    if (!writeAccess.current.mounted || !writeAccess.current.edit) return Promise.resolve(false);
    const epoch = writeAccess.current.epoch;
    if (edits.length === 0) return Promise.resolve(true);
    setPendingEdits(n => n + 1);
    const queued = editQueue.current.then(async () => {
      if (!writeAccess.current.mounted || !writeAccess.current.edit || epoch !== writeAccess.current.epoch) return false;
      const current = scenarioRef.current;
      if (!current) return false;
      try {
        const label = current.kind === 'base' ? t('scn.edited', { day: current.label }) : undefined;
        const updated = await api.editScenarioBatch(current.id, current.revision, edits, label);
        scenarioRef.current = updated;
        setScenario(updated);
        if (toastMsg) showToast(toastMsg);
        return true;
      } catch (e) { rejectStaleIntent(e); setError(describeApiError(e, t)); return false; }
    });
    void queued.finally(() => { if (writeAccess.current.mounted) setPendingEdits(n => Math.max(0, n - 1)); });
    editQueue.current = queued;
    return queued;
  }, [showToast, t, rejectStaleIntent]);

  // Bulk-assign: pin many orders to one vehicle in a single staged batch.
  const onBulkAssign = useCallback((orderNos: string[], vehicleId: number) => {
    const ref = planRef.current?.vehicles.find((v) => v.id === vehicleId)?.ref ?? `#${vehicleId}`;
    void applyEdits(orderNos.map((orderNo) => ({ op: 'pin', orderNo, vehicleId })), t('bulk.assignedToast', { n: orderNos.length, ref }));
  }, [applyEdits, t]);

  // Replan: solve the current (edited) scenario, then surface the comparison if
  // it is an edited copy. Staged edits are applied together here.
  const replan = useCallback(async () => {
    if (!writeAccess.current.mounted || !writeAccess.current.solve || !scenarioRef.current || solveActive) return;
    const epoch = writeAccess.current.epoch;
    setSolveActive(true);
    try {
      if (!await editQueue.current) return;
      if (!writeAccess.current.mounted || !writeAccess.current.solve || epoch !== writeAccess.current.epoch) return;
      const current = scenarioRef.current;
      if (!current) return;
      const wasCopy = current.kind === 'copy';
      const revised = await runSolve(current.id, dayId);
      if (revised && wasCopy) setCompareOpen(true);
    } finally { setSolveActive(false); }
  }, [dayId, runSolve, solveActive]);

  const resetToBaseline = useCallback(() => {
    const d = days.find((x) => x.id === dayId);
    if (d) void loadDay(d);
  }, [days, dayId, loadDay]);

  // Reopen a saved plan faithfully, restoring its scenario context.
  // A newly-admitted uploaded dataset: refresh the day list and open its first day.
  const onAdmitted = useCallback(async (dayId: string) => {
    try {
      const ds = await api.days();
      setDays(ds);
      setImportOpen(false);
      const d = ds.find((x) => x.id === dayId);
      if (d) await loadDay(d);
    } catch (e) { setError(describeApiError(e, t)); }
  }, [loadDay]);

  // A dataset was deleted (or admitted): refresh days; if the current day vanished, fall back.
  const onDatasetsChanged = useCallback(async () => {
    try {
      const ds = await api.days();
      setDays(ds);
      if (!ds.some((x) => x.id === dayId)) { const d = ds.find((x) => x.id === 'day1') ?? ds[0]; if (d) await loadDay(d); }
    } catch (e) { setError(describeApiError(e, t)); }
  }, [dayId, loadDay, t]);

  // Adopt an imported scenario: switch to its day if needed, show the clean
  // baseline, and stage its edits (Replan solves it). It has no result yet.
  const onImportScenario = useCallback(async (s: Scenario) => {
    writeAccess.current.epoch++;
    try {
      if (s.day !== dayId) { const d = days.find((x) => x.id === s.day); if (d) await loadDay(d); }
      setScenario(s);
      resetSelection();
    } catch (e) { setError(describeApiError(e, t)); }
  }, [dayId, days, loadDay, resetSelection, t]);

  const reopenPlan = useCallback(async (planId: string) => {
    const generation = ++navigationGeneration.current;
    setWorkspaceLoading(true);
    writeAccess.current.epoch++;
    pollAbort.current?.abort();
    activeJobId.current = null;
    persistActiveJob(null);
    setJob(null); resetSelection(); setError(null);
    try {
      const p = await loadPlanWithGeometry(planId);
      const sc = await api.scenario(p.scenarioId);
      if (generation !== navigationGeneration.current) return;
      const d = days.find((x) => x.id === sc.day);
      // Only swap the baseline when actually changing day. baseline.day and d.id
      // are both day ids (comparing to d.isoDate never matched).
      if (d && baseline?.day !== d.id) {
        const base = await loadPlanWithGeometry(d.baselinePlanId);
        if (generation !== navigationGeneration.current) return;
        setBaseline(base); setDayId(d.id);
      }
      setScenario(sc);
      setPlan(p);
    } catch (e) { if (generation === navigationGeneration.current) setError(describeApiError(e, t)); }
    finally { if (generation === navigationGeneration.current) setWorkspaceLoading(false); }
  }, [days, baseline]);

  // Planned-day time range (for the playback cursor).
  const dayRange = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    for (const v of plan?.vehicles ?? []) for (const tr of v.trips) { lo = Math.min(lo, tr.startSec); hi = Math.max(hi, tr.endSec); }
    return Number.isFinite(lo) ? { lo, hi } : { lo: 6 * 3600, hi: 18 * 3600 };
  }, [plan]);

  // Advance the playback clock while playing; stop at the end of the day.
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setClockSec((c) => {
        const next = (c ?? dayRange.lo) + speed * 0.12;
        if (next >= dayRange.hi) { setPlaying(false); return dayRange.hi; }
        return next;
      });
    }, 120);
    return () => clearInterval(id);
  }, [playing, speed, dayRange.lo, dayRange.hi]);

  const togglePlay = useCallback(() => {
    setClockSec((c) => (c == null || c >= dayRange.hi ? dayRange.lo : c));
    setPlaying((p) => !p);
  }, [dayRange.lo, dayRange.hi]);
  const seekClock = useCallback((sec: number) => { setPlaying(false); setClockSec(sec); }, []);
  const stopClock = useCallback(() => { setPlaying(false); setClockSec(null); }, []);
  useEffect(() => { if (plan) planRef.current = plan; }, [plan]);
  useEffect(() => { scenarioRef.current = scenario; }, [scenario]);
  const previewTotals = usePreviewTotals(canEvaluate ? plan : null, scenario);

  if (error && !plan) return <div className="flex h-full items-center justify-center text-sm text-destructive">{t('app.failed', { e: error })}</div>;
  if (!plan || !baseline || !scenario) return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{t('app.loading')}</div>;

  const isReplan = scenario.kind === 'copy';
  const solving = solveActive || job?.status === 'running' || job?.status === 'pending';
  const changesCount = scenario.removedVehicleIds.length + scenario.pins.length + scenario.forbids.length + scenario.vehicleOverrides.length + scenario.sequences.length;
  const issuesCount = plan.unassigned.length + plan.provenance.validation.violations.filter((v) => !v.soft).length;
  // Guard switching day/scenario when there are unapplied staged edits (they'd
  // be silently discarded). Returns true if it's safe to proceed.
  const okToSwitch = (): boolean => !(scenario.kind === 'copy' && changesCount > 0) || window.confirm(t('app.discardConfirm', { n: changesCount }));
  // The plan no longer reflects the scenario once it has been edited since solve.
  const dirty = scenario.revision !== plan.scenarioRevision;

  return (
    <StaleWorkspaceContext.Provider value={!!freshnessError || workspaceLoading}><TooltipProvider delayDuration={200}>
      <div className="flex h-full flex-col overflow-hidden">
        <TopBar
          days={days} dayId={dayId} onDayChange={(id) => { if (!okToSwitch()) return; const d = days.find((x) => x.id === id); if (d) void loadDay(d); }}
          scenario={scenario} plan={plan} job={job} solving={!!solving} exportPending={workspaceLoading}
          objective={objective} onObjectiveChange={setObjective}
          budgetSec={budgetSec} onBudgetChange={setBudgetSec}
          fullBudget={fullBudget} onFullBudgetChange={setFullBudget}
          changesCount={changesCount} dirty={dirty}
          onOptimize={() => void replan()}
          onCancel={() => void cancelSolve()}
          onReset={resetToBaseline}
          onOpenChanges={() => setChangesOpen(true)}
          showCompare={isReplan && plan.source === 'live'}
          onCompare={() => setCompareOpen(true)}
          onOpenImport={() => setImportOpen(true)}
          onOpenHistory={() => setHistoryOpen(true)}
          onOpenWeek={() => setWeekOpen(true)}
          onOpenIssues={() => setIssuesOpen(true)}
          issuesCount={issuesCount}
          onOpenScenarios={() => setScenariosOpen(true)}
          onOpenHelp={() => setHelpOpen(true)}
        />
        <div id="cursus-kpi-pane" className="shrink-0" hidden={!workspace.visibility.kpis}>
          <KpiStrip plan={plan} baseline={baseline} compare={isReplan} job={job}
            previewDistanceKm={previewTotals?.distanceKm} previewCostTotal={previewTotals?.costTotal} />
        </div>
        <ReadinessPanel plan={plan} baseline={baseline} scenario={scenario} pending={pendingEdits > 0 || !!solving || !!freshnessError || workspaceLoading} />
        <PlanApproval key={plan.id} planId={plan.id} revision={scenario.revision} pending={pendingEdits > 0 || !!solving || !!freshnessError || workspaceLoading || scenario.id !== plan.scenarioId} />
        {freshnessError && <div role="alert" className="border-b border-warning/40 bg-warning/10 px-4 py-2 text-sm">
          {t(freshnessError)} <button className="underline" onClick={() => {
            if (!window.confirm(t('freshness.confirm'))) return;
            writeAccess.current.epoch++;
            void api.scenario(scenario.id).then(latest => { scenarioRef.current = latest; setScenario(latest); setFreshnessError(null); setError(null); }).catch(e => setError(describeApiError(e, t)));
          }}>{t('freshness.reload')}</button>
        </div>}
        {error && <div role="alert" className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>}

        {dirty && changesCount > 0 && !solving && (
          <button type="button" onClick={() => setChangesOpen(true)}
            className="flex shrink-0 items-center justify-center gap-2 border-b border-warning/40 bg-warning/10 px-4 py-1.5 text-xs font-medium text-warning hover:bg-warning/15">
            {t('edits.pending', { n: changesCount })}
          </button>
        )}

        <div ref={workspace.containerRef} className="flex min-h-0 flex-1">
          {leftOpen && (
            <aside id="cursus-fleet-pane" className="w-[310px] shrink-0 overflow-hidden border-r border-divider" style={{ width: workspace.layout.fleet }}>
              <FleetPanel plan={plan} scenario={scenario} selection={selection} onSelect={navigate}
                onMarkUnavailable={(id) => void applyEdit({ op: 'removeVehicle', vehicleId: id })}
                onRestoreVehicle={(id) => void applyEdit({ op: 'restoreVehicle', vehicleId: id })} solving={!!solving}
                onFilterChange={setVisibleVehicleIds}
                onAssignOrder={(orderNo, vehicleId) => void applyEdit({ op: 'pin', orderNo, vehicleId })}
                onBulkAssign={onBulkAssign} />
            </aside>
          )}
          {leftOpen && workspace.layout.desktop && <ResizeHandle label={t('layout.fleet')} help={t('layout.help')} controls="cursus-fleet-pane"
            axis="x" direction={1} value={workspace.layout.fleet} min={240} max={workspace.layout.fleetMax}
            onChange={n => workspace.setSize('fleet', n)} onReset={() => workspace.resetSize('fleet')} />}

          <main className="flex min-w-0 flex-1 flex-col">
            <div id="cursus-map-pane" className="relative min-h-0 flex-1">
              <div className="absolute left-3 top-3 z-10 flex gap-1.5">
                <Button variant="graphite" size="icon" className="h-8 w-8 opacity-90" aria-label={leftOpen ? 'Collapse fleet panel' : 'Open fleet panel'} onClick={() => setLeftOpen((o) => !o)}>
                  {leftOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}
                </Button>
                <Button variant="graphite" size="icon" className="h-8 w-8 opacity-90" aria-label={rightOpen ? 'Collapse inspector' : 'Open inspector'} onClick={() => setRightOpen((o) => !o)}>
                  {rightOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
                </Button>
                <Button variant="graphite" size="icon" className="h-8 w-8 opacity-90" aria-label={t(workspace.visibility.kpis ? 'layout.collapseKpis' : 'layout.openKpis')} title={t(workspace.visibility.kpis ? 'layout.collapseKpis' : 'layout.openKpis')} aria-expanded={workspace.visibility.kpis} aria-controls="cursus-kpi-pane" onClick={() => workspace.toggleVisibility('kpis')}>
                  {workspace.visibility.kpis ? <PanelTopClose className="h-4 w-4" /> : <PanelTopOpen className="h-4 w-4" />}
                </Button>
                <Button variant="graphite" size="icon" className="h-8 w-8 opacity-90" aria-label={t(workspace.visibility.timeline ? 'layout.collapseTimeline' : 'layout.openTimeline')} title={t(workspace.visibility.timeline ? 'layout.collapseTimeline' : 'layout.openTimeline')} aria-expanded={workspace.visibility.timeline} aria-controls="cursus-timeline-pane" onClick={() => { if (workspace.visibility.timeline) stopClock(); workspace.toggleVisibility('timeline'); }}>
                  {workspace.visibility.timeline ? <PanelBottomClose className="h-4 w-4" /> : <PanelBottomOpen className="h-4 w-4" />}
                </Button>
                {workspace.layout.desktop && <Button variant="graphite" size="icon" className="h-8 w-8 opacity-90" aria-label={t('layout.reset')} title={t('layout.reset')} onClick={workspace.reset}>
                  <RotateCcw className="h-4 w-4" />
                </Button>}
              </div>
              <MapView plan={plan} scenario={scenario} selection={selection} onSelect={navigate} clockSec={clockSec} visibleVehicleIds={visibleVehicleIds} />
            </div>
            {workspace.visibility.timeline && workspace.layout.desktop && <ResizeHandle label={t('layout.timeline')} help={t('layout.help')} controls="cursus-timeline-pane"
              axis="y" direction={-1} value={workspace.layout.timeline} min={workspace.layout.timelineMin} max={workspace.layout.timelineMax}
              onChange={n => workspace.setSize('timeline', n)} onReset={() => workspace.resetSize('timeline')} />}
            <div id="cursus-timeline-pane" hidden={!workspace.visibility.timeline} className="h-48 shrink-0 overflow-hidden border-t border-divider" style={{ height: workspace.layout.timeline }}>
              <Timeline plan={plan} selection={selection} onSelect={navigate}
                clockSec={clockSec} playing={playing} speed={speed} dayRange={dayRange}
                onTogglePlay={togglePlay} onSeek={seekClock} onStop={stopClock} onSpeed={setSpeed} />
            </div>
          </main>

          {rightOpen && workspace.layout.desktop && <ResizeHandle label={t('layout.inspector')} help={t('layout.help')} controls="cursus-inspector-pane"
            axis="x" direction={-1} value={workspace.layout.inspector} min={260} max={workspace.layout.inspectorMax}
            onChange={n => workspace.setSize('inspector', n)} onReset={() => workspace.resetSize('inspector')} />}

          {rightOpen && (
            <aside id="cursus-inspector-pane" className="w-[340px] shrink-0 overflow-hidden border-l border-divider" style={{ width: workspace.layout.inspector }}>
              <Inspector plan={plan} baseline={baseline} scenario={scenario} selection={selection} onSelect={navigate} solving={!!solving}
                onBack={goBack} onForward={goForward} canGoBack={canGoBack} canGoForward={canGoForward}
                onMarkUnavailable={(id) => void applyEdit({ op: 'removeVehicle', vehicleId: id })}
                onRestoreVehicle={(id) => void applyEdit({ op: 'restoreVehicle', vehicleId: id })}
                onSetConstraint={(vehicleId, patch) => void applyEdit({ op: 'setVehicleConstraint', vehicleId, patch })}
                onClearConstraint={(vehicleId) => void applyEdit({ op: 'clearVehicleConstraint', vehicleId })}
                onPin={(orderNo, vehicleId) => void applyEdit({ op: 'pin', orderNo, vehicleId })}
                onUnpin={(orderNo) => void applyEdit({ op: 'unpin', orderNo })}
                onForbid={(orderNo, vehicleId) => void applyEdit({ op: 'forbid', orderNo, vehicleId })}
                onClearOverrides={() => void applyEdit({ op: 'clearOverrides' })}
                onSetSequence={(vehicleId, orderNos, locked) => void applyEdit({ op: 'setSequence', vehicleId, orderNos, ...(locked ? { locked: true } : {}) })}
                onClearSequence={(vehicleId) => void applyEdit({ op: 'clearSequence', vehicleId })} />
            </aside>
          )}
        </div>
      </div>

      {isReplan && plan.source === 'live' && (
        <CompareDialog
          open={compareOpen}
          onOpenChange={setCompareOpen}
          basePlanId={baseline.id}
          revisedPlanId={plan.id}
          scenarioLabel={scenario.label}
        />
      )}
      <ChangesDialog
        open={changesOpen} onOpenChange={setChangesOpen}
        plan={plan} scenario={scenario} dirty={dirty} solving={!!solving}
        onUndo={(edit) => void applyEdit(edit)}
        onDiscardAll={() => { setChangesOpen(false); resetToBaseline(); }}
        onReplan={() => { setChangesOpen(false); void replan(); }}
      />
      <WeekDialog open={weekOpen} onOpenChange={setWeekOpen} />
      <IssuesDialog open={issuesOpen} onOpenChange={setIssuesOpen} plan={plan} onSelect={navigate} />
      <ScenariosDialog open={scenariosOpen} onOpenChange={setScenariosOpen} dayId={dayId} currentScenarioId={scenario.id} onOpen={(id) => { if (okToSwitch()) void reopenPlan(id); }} onImport={(s) => void onImportScenario(s)} />
      <HelpOverlay open={helpOpen} onClose={closeHelp} />
      {toast && (
        <div role="status" className="pointer-events-none fixed bottom-16 left-1/2 z-40 -translate-x-1/2 rounded-md bg-graphite px-3.5 py-2 text-xs font-medium text-graphite-foreground shadow-lg">
          {toast}
        </div>
      )}
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} onAdmitted={(id) => void onAdmitted(id)} onDatasetsChanged={() => void onDatasetsChanged()} />
      <HistoryDialog open={historyOpen} onOpenChange={setHistoryOpen} dayId={dayId} currentPlanId={plan.id} onReopen={(id) => { if (okToSwitch()) void reopenPlan(id); }} />
    </TooltipProvider></StaleWorkspaceContext.Provider>
  );
}
