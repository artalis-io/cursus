import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Play, RotateCcw, Loader2, Repeat, GitCompareArrows, Database, History, Settings2, X, FileText, FileSpreadsheet, FileJson, SlidersHorizontal, CalendarRange, AlertTriangle, GitBranch, HelpCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, ApiError } from '@/lib/api';
import { useI18n, useT } from '@/i18n';
import type { DaySummary, Objective, Plan, Scenario } from '@/types';
import type { JobView } from '@/App';
import { WorkspaceNameContext } from '@/workspace';
import { usePermission, RoleContext, PermissionsContext } from '@/permissions';
import {WorkspaceNavigation,WorkspaceMenu,WorkspaceMenuItem,useAnchoredPanel,type WorkspaceCommand} from '@/components/WorkspaceNavigation';

/* Localize the planning-day label from its ISO date (e.g. "kedd, 2026. május 6."
 * in Hungarian) rather than using the backend's fixed English label. */
function fmtDay(iso: string, lang: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(lang === 'hu' ? 'hu-HU' : 'en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

/* A tiny popover: a trigger plus an absolutely-positioned panel with a backdrop
 * that closes on outside click. Avoids pulling in a dropdown primitive. */
function Popover({ open, onClose, align = 'right', children }: { open: boolean; onClose: () => void; align?: 'left' | 'right'; children: React.ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  useAnchoredPanel(open,panel);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    // Close after an outside click has reached its intended control. A fixed
    // backdrop used to swallow the first click on Optimize, forcing a second.
    const onMouseDown = (e: MouseEvent) => { if (!panel.current?.contains(e.target as Node)) onClose(); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onMouseDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onMouseDown); };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div ref={panel} role="menu" className={`absolute top-full z-50 mt-1.5 ${align === 'right' ? 'right-0' : 'left-0'} max-h-[65vh] min-w-[220px] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-md border border-divider bg-card p-2 text-foreground shadow-lg`}>
      {children}
    </div>
  );
}

export function TopBar({
  days, dayId, onDayChange, scenario, plan, job, solving, exportPending = false,
  objective, onObjectiveChange, budgetSec, onBudgetChange, fullBudget, onFullBudgetChange, changesCount, dirty,
  onOptimize, onCancel, onReset, onOpenChanges, showCompare, onCompare, onOpenImport, onOpenHistory, onOpenWeek, onOpenIssues, issuesCount, onOpenScenarios, onOpenHelp,
  onOpenProfiles,onOpenHandoff,onOpenInputUpdates,onOpenReview,
}: {
  days: DaySummary[]; dayId: string; onDayChange: (id: string) => void;
  scenario: Scenario; plan: Plan; job: JobView | null; solving: boolean;
  exportPending?: boolean;
  objective: Objective; onObjectiveChange: (o: Objective) => void;
  budgetSec: number; onBudgetChange: (n: number) => void; fullBudget: boolean; onFullBudgetChange: (b: boolean) => void; changesCount: number; dirty: boolean;
  onOptimize: () => void; onCancel: () => void; onReset: () => void; onOpenChanges: () => void;
  showCompare: boolean; onCompare: () => void; onOpenImport: () => void; onOpenHistory: () => void; onOpenWeek: () => void;
  onOpenIssues: () => void; issuesCount: number; onOpenScenarios: () => void; onOpenHelp: () => void;
  onOpenReview:()=>void;
  onOpenProfiles?:()=>void;
  onOpenHandoff?:()=>void;
  onOpenInputUpdates?:()=>void;
}) {
  const { lang, setLang } = useI18n();
  const t = useT();
  const canEdit = usePermission('optimization.submit');
  const role = useContext(RoleContext), permissions = useContext(PermissionsContext);
  const canCancel = usePermission('optimization.cancel');
  const workspaceName = useContext(WorkspaceNameContext);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportError, setExportError] = useState('');
  const [exportBusy, setExportBusy] = useState(false);
  const exportGeneration = useRef(0);
  useLayoutEffect(() => {
    const generation = ++exportGeneration.current;
    setExportError(''); setExportBusy(false); setExportOpen(false);
    return () => { exportGeneration.current = generation + 1; };
  }, [plan.id, exportPending]);
  const isReplan = scenario.kind === 'copy';
  const termOk = plan.provenance.termination === 'OK';
  const invalid = !plan.provenance.validation.valid;

  function downloadUrl(url: string) {
    const a = document.createElement('a');
    a.href = url; a.download = ''; a.click();
  }
  function openRouteSheets() { window.open(api.routeSheetUrl(plan.id), '_blank', 'noopener'); }
  async function downloadApproved() {
    if (exportPending) return;
    const generation = exportGeneration.current;
    setExportBusy(true); setExportError('');
    try {
      const document = await api.approvedHandoff(plan.id, plan.scenarioRevision);
      if (generation !== exportGeneration.current) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' }));
      const anchor = window.document.createElement('a');
      anchor.href = url; anchor.download = `cursus-${plan.id.replace(/[^a-zA-Z0-9_-]/g, '_')}-approved.json`; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportOpen(false);
    } catch (error) {
      if (generation === exportGeneration.current) setExportError(t(error instanceof ApiError && error.status === 409 ? 'export.notApproved' : 'export.failed'));
    } finally { if (generation === exportGeneration.current) setExportBusy(false); }
  }

  const icon=(Icon:typeof Database)=><Icon className="h-4 w-4"/>;
  const prepare:WorkspaceCommand[]=[{label:t('topbar.data'),onSelect:onOpenImport,icon:icon(Database)},
    ...(onOpenProfiles?[{label:t('nav.profiles'),onSelect:onOpenProfiles,icon:icon(SlidersHorizontal)}]:[]),
    ...(onOpenInputUpdates?[{label:t('nav.inputUpdates'),onSelect:onOpenInputUpdates,disabled:solving||dirty,icon:icon(Repeat)}]:[])];
  const planning:WorkspaceCommand[]=[{label:t('topbar.issues'),onSelect:onOpenIssues,count:issuesCount,icon:icon(AlertTriangle)},
    ...(changesCount>0?[{label:t('topbar.changes'),onSelect:onOpenChanges,count:changesCount,icon:icon(SlidersHorizontal)}]:[]),
    ...(showCompare?[{label:t('topbar.compare'),onSelect:onCompare,disabled:solving,icon:icon(GitCompareArrows)}]:[]),
    ...(canEdit&&isReplan?[{label:t('topbar.reset'),onSelect:onReset,disabled:solving,icon:icon(RotateCcw)}]:[])];
  const library:WorkspaceCommand[]=[{label:t('topbar.scenarios'),onSelect:onOpenScenarios,icon:icon(GitBranch)},
    {label:t('topbar.plans'),onSelect:onOpenHistory,icon:icon(History)},{label:t('topbar.week'),onSelect:onOpenWeek,icon:icon(CalendarRange)}];
  const review=<WorkspaceMenu label={t('nav.review')} open={exportOpen} onOpenChange={setExportOpen} disabled={exportPending}>
    <WorkspaceMenuItem label={t('nav.approval')} onSelect={onOpenReview} icon={<FileText className="h-4 w-4"/>}/>
    {onOpenHandoff&&<WorkspaceMenuItem label={t('nav.handoff')} onSelect={onOpenHandoff} icon={<FileJson className="h-4 w-4"/>}/>}
            <div className="space-y-0.5">
              <div className="px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t('export.forDrivers')}</div>
              <MenuItem icon={<FileText className="h-4 w-4" />} label={t('export.routesheet')} onClick={() => { setExportOpen(false); openRouteSheets(); }} />
              <MenuItem icon={<FileSpreadsheet className="h-4 w-4" />} label={t('export.csv')} onClick={() => { setExportOpen(false); downloadUrl(api.exportCsvUrl(plan.id)); }} />
              <div className="px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t('export.handoffGroup')}</div>
              <MenuItem icon={<FileSpreadsheet className="h-4 w-4" />} label={t('export.routes')} onClick={() => { setExportOpen(false); downloadUrl(api.routesCsvUrl(plan.id)); }} />
              <MenuItem icon={<FileJson className="h-4 w-4" />} label={t('export.handoff')} onClick={() => { setExportOpen(false); downloadUrl(api.handoffJsonUrl(plan.id)); }} />
              <WorkspaceMenuItem label={t('export.approved')} icon={<FileJson className="h-4 w-4"/>} disabled={exportBusy} closeOnSelect={false} onSelect={()=>void downloadApproved()}/>
              <p className="max-w-[280px] px-2 py-1 text-xs text-muted-foreground">{t('export.statusNote')}</p>
              {exportError && <p role="alert" className="max-w-[280px] px-2 py-1 text-xs text-destructive">{exportError}</p>}
            </div>
  </WorkspaceMenu>;
  return (
    <header className="shrink-0 bg-graphite px-4 text-graphite-foreground">
      <div className="flex min-h-12 min-w-0 flex-wrap items-center gap-2 py-1.5">
      <div className="flex shrink-0 items-baseline gap-2">
        <span className="text-lg font-bold tracking-tight">Cursus</span>
        {workspaceName ? <div role="group" aria-label={t('workspace.current')} className="flex min-w-0 items-baseline gap-2">
          <span aria-hidden="true" className="text-sm text-graphite-muted">/</span>
          <span title={workspaceName} className="max-w-[120px] truncate text-sm font-medium text-graphite-foreground/80 sm:max-w-[180px]">{workspaceName}</span>
        </div> : <span className="text-sm font-medium text-graphite-muted">{t('brand.sub')}</span>}
      </div>

      <div className="flex items-center rounded-md border border-white/15 bg-white/5 p-0.5" role="group" aria-label={t('lang.switch')}>
        {(['en', 'hu'] as const).map((l) => (
          <button key={l} type="button" onClick={() => setLang(l)}
            aria-pressed={lang === l}
            className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${lang === l ? 'bg-white/15 text-graphite-foreground' : 'text-graphite-muted hover:text-graphite-foreground'}`}>
            {t(l === 'en' ? 'lang.en' : 'lang.hu')}
          </button>
        ))}
      </div>

      <div className="w-full min-w-0 max-w-full sm:w-[230px] xl:max-w-[300px] xl:flex-1">
        <Select value={dayId} onValueChange={onDayChange} disabled={solving}>
          <SelectTrigger className="h-8 border-white/15 bg-white/5 text-graphite-foreground">
            <SelectValue placeholder={t('topbar.selectDay')} />
          </SelectTrigger>
          <SelectContent>
            {days.map((d) => (
              <SelectItem key={d.id} value={d.id}>
                {fmtDay(d.isoDate, lang)} · {t('topbar.ordersSuffix', { n: d.orders ?? '—' })}
                {d.archived?` · ${lang==='hu'?'archivált':'archived'}`:d.datasetLabel?` · ${d.datasetLabel}`:''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isReplan ? (
        <Badge variant="warning" className="max-w-full min-w-0 truncate sm:max-w-[140px]" title={scenario.label}>
          {scenario.label}{changesCount > 0 ? ` · ${t('topbar.editsN', { n: changesCount })}` : ''}
        </Badge>
      ) : (
        <Badge variant={invalid ? 'destructive' : plan.source === 'saved' ? 'outline' : 'default'} title="Plan source / validation / Surge termination" className={invalid ? '' : 'border-white/20 text-graphite-foreground'}>
          {plan.source === 'saved' ? t('topbar.baseline') : t('topbar.live')} · {invalid ? t('topbar.invalid') : termOk ? 'OK' : plan.provenance.termination}
        </Badge>
      )}
      {isReplan && invalid && <Badge variant="destructive">{t('topbar.invalid')}</Badge>}

        <Button type="button" variant="graphite" size="sm" className="shrink-0 border border-white/15" onClick={onOpenHelp} aria-label={t('help.title')}><HelpCircle aria-hidden className="h-4 w-4"/>{t('nav.help')}</Button>
        <WorkspaceNavigation prepare={prepare} planning={planning} library={library} review={review} contextKey={`${plan.id}/${scenario.id}/${role}/${permissions?.join(',')}/${exportPending}`} pending={exportPending} issuesCount={issuesCount}/>
        <div className="ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-1.5">
        {changesCount>0&&<Button type="button" variant="graphite" size="sm" className="max-w-[120px] border border-warning/60 text-warning" title={t('status.changes',{n:changesCount})} onClick={onOpenChanges}>
          <span className="truncate">{t('topbar.changes')} ({changesCount})</span>
        </Button>}
        {/* Solve settings (objective + time budget) */}
        {canEdit && <div className="relative">
          <Button variant="graphite" size="icon" className="h-8 w-8 border border-white/15" title={t('topbar.settings')} aria-label={t('topbar.settings')}
            onClick={() => setSettingsOpen((o) => !o)} disabled={solving}>
            <Settings2 className="h-4 w-4" />
          </Button>
          <Popover open={settingsOpen} onClose={() => setSettingsOpen(false)}>
            <div className="space-y-3">
              <div>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t('topbar.objective')}</div>
                <div className="space-y-1">
                  {(['vehicles', 'distance'] as const).map((o) => (
                    <button key={o} type="button" onClick={() => onObjectiveChange(o)}
                      className={`w-full rounded border px-2 py-1.5 text-left text-xs transition-colors ${objective === o ? 'border-primary bg-primary/10' : 'border-divider hover:bg-accent'}`}>
                      <div className="font-medium">{t(o === 'vehicles' ? 'obj.vehicles' : 'obj.distance')}</div>
                      <div className="text-[10px] text-muted-foreground">{t(o === 'vehicles' ? 'obj.vehiclesHint' : 'obj.distanceHint')}</div>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="mb-1 flex items-baseline justify-between text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <span>{t('topbar.budget')}</span><span className="tnum text-foreground">{budgetSec}s</span>
                </div>
                <input type="range" min={15} max={240} step={5} value={budgetSec}
                  onChange={(e) => onBudgetChange(Number(e.target.value))} className="w-full accent-[var(--primary)]" />
              </div>
              <label className="flex cursor-pointer items-start gap-2 text-xs">
                <input type="checkbox" checked={fullBudget} onChange={(e) => onFullBudgetChange(e.target.checked)} className="mt-0.5 accent-[var(--primary)]" />
                <span>
                  <span className="font-medium">{t('topbar.fullBudget')}</span>
                  <span className="block text-[10px] text-muted-foreground">{t('topbar.fullBudgetHint')}</span>
                </span>
              </label>
            </div>
          </Popover>
        </div>}

        {/* Keep this footprint constant: conditionally inserting Cancel and
            allowing the timer label to grow used to shift the entire toolbar. */}
        {canEdit ? <div className="flex w-[190px] shrink-0 items-center gap-1.5">
          {solving ? (
            <Button variant="default" size="sm" disabled className="w-[152px] shrink-0 overflow-hidden">
              <Loader2 className="h-4 w-4 animate-spin" /> {isReplan ? t('topbar.replanning') : t('topbar.optimizing')} {job ? `${job.elapsedSec.toFixed(0)}s` : ''}
            </Button>
          ) : (
            <Button variant="default" size="sm" onClick={onOptimize} className={`w-[152px] shrink-0 ${dirty ? 'ring-2 ring-warning/60' : ''}`}>
              {isReplan ? <Repeat className="h-4 w-4" /> : <Play className="h-4 w-4" />} {isReplan ? t('topbar.replan') : t('topbar.optimize')}
            </Button>
          )}
          {canCancel && <Button variant="graphite" size="icon" aria-label={t('topbar.cancel')} onClick={onCancel} title={t('topbar.cancel')}
            disabled={!solving} aria-hidden={!solving}
            className={`h-8 w-8 shrink-0 border border-white/15 ${solving ? '' : 'invisible'}`}>
            <X className="h-4 w-4" />
          </Button>}
        </div> : <span className="px-2 text-xs text-graphite-foreground/80">{t('account.readOnly')}</span>}

        </div>
      </div>
    </header>
  );
}

function MenuItem({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return <WorkspaceMenuItem icon={icon} label={label} onSelect={onClick}/>;
}
