import { useCallback, useEffect, useState } from 'react';
import { GitBranch, Trash2, Pencil, FolderOpen, Download, Upload } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { km, money } from '@/lib/format';
import { api, type ScenarioSummary } from '@/lib/api';
import { useT, describeApiError } from '@/i18n';
import type { Scenario } from '@/types';

/* The what-if workspace: the day's scenarios (base + edited copies) with their
 * latest result. Rename to tell them apart, open to switch to one, delete
 * copies, and select 2-3 to compare their KPIs side by side. */
export function ScenariosDialog({ open, onOpenChange, dayId, currentScenarioId, onOpen, onImport }: {
  open: boolean; onOpenChange: (o: boolean) => void; dayId: string; currentScenarioId: string;
  onOpen: (planId: string) => void; onImport: (s: Scenario) => void;
}) {
  const t = useT();
  const [list, setList] = useState<ScenarioSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');

  const refresh = useCallback(() => {
    api.scenariosForDay(dayId).then(setList).catch((e) => setErr(describeApiError(e, t)));
  }, [dayId, t]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setErr(null); setList(null); setSel(new Set()); setEditing(null);
    api.scenariosForDay(dayId).then((x) => { if (alive) setList(x); }).catch((e) => { if (alive) setErr(describeApiError(e, t)); });
    return () => { alive = false; };
  }, [open, dayId, t]);

  const toggleSel = (id: string) => setSel((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else if (n.size < 3) n.add(id); return n; });
  const rename = async (id: string) => {
    const label = editLabel.trim(); setEditing(null);
    if (!label) return;
    try { await api.renameScenario(id, label); refresh(); } catch (e) { setErr(describeApiError(e, t)); }
  };
  const del = async (id: string) => {
    if (!window.confirm(t('scenarios.deleteConfirm'))) return;
    try { await api.deleteScenario(id); setSel((p) => { const n = new Set(p); n.delete(id); return n; }); refresh(); }
    catch (e) { setErr(describeApiError(e, t)); }
  };
  const exportOne = async (id: string, label: string) => {
    try {
      const bundle = await api.exportScenario(id);
      const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url; a.download = `scenario-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40) || id}.json`;
      a.click(); URL.revokeObjectURL(url);
    } catch (e) { setErr(describeApiError(e, t)); }
  };
  const importFile = async (file: File) => {
    try {
      const bundle = JSON.parse(await file.text());
      const s = await api.importScenario(bundle);
      onImport(s); onOpenChange(false);
    } catch (e) { setErr(e instanceof SyntaxError ? t('scenarios.importBad') : describeApiError(e, t)); }
  };

  const selected = (list ?? []).filter((s) => sel.has(s.id) && s.latest);
  const currency = selected.find((s) => s.latest?.currency)?.latest?.currency ?? 'HUF';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="h-4 w-4" /> {t('scenarios.title')}
            <label className="ml-auto mr-6 inline-flex cursor-pointer items-center gap-1 rounded border border-divider px-2 py-0.5 text-[11px] font-normal text-muted-foreground hover:bg-accent">
              <Upload className="h-3 w-3" /> {t('scenarios.import')}
              <input type="file" accept="application/json,.json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ''; }} />
            </label>
          </DialogTitle>
        </DialogHeader>
        {err && <p className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">{err}</p>}

        {selected.length >= 2 && <CompareTable selected={selected} currency={currency} t={t} />}

        <ScrollArea className="max-h-[56vh]">
          <div className="space-y-1.5 pr-3">
            {list == null ? <p className="py-8 text-center text-sm text-muted-foreground">{t('week.loading')}</p>
              : list.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">{t('scenarios.none')}</p>
              : list.map((s) => {
                const L = s.latest;
                const isCurrent = s.id === currentScenarioId;
                return (
                  <div key={s.id} className={`rounded-md border px-2.5 py-2 ${isCurrent ? 'border-ring ring-1 ring-ring' : 'border-divider'}`}>
                    <div className="flex items-center gap-2">
                      <input type="checkbox" checked={sel.has(s.id)} onChange={() => toggleSel(s.id)} disabled={!L} className="h-3.5 w-3.5 shrink-0" aria-label={t('scenarios.select')} />
                      {editing === s.id ? (
                        <Input autoFocus value={editLabel} onChange={(e) => setEditLabel(e.target.value)}
                          onBlur={() => void rename(s.id)} onKeyDown={(e) => { if (e.key === 'Enter') void rename(s.id); if (e.key === 'Escape') setEditing(null); }}
                          className="h-6 flex-1 text-xs" />
                      ) : (
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">{s.label}</span>
                      )}
                      {s.kind === 'base' && <Badge variant="outline" className="shrink-0 text-[9px]">{t('scenarios.base')}</Badge>}
                      {isCurrent && <Badge variant="default" className="shrink-0 bg-primary text-[9px]">{t('scenarios.current')}</Badge>}
                      {s.kind === 'copy' && editing !== s.id && (
                        <button type="button" onClick={() => { setEditing(s.id); setEditLabel(s.label); }} aria-label={t('scenarios.rename')} className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"><Pencil className="h-3 w-3" /></button>
                      )}
                      {L && !isCurrent && (
                        <button type="button" onClick={() => { onOpen(L.planId); onOpenChange(false); }} aria-label={t('scenarios.open')} title={t('scenarios.open')} className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"><FolderOpen className="h-3.5 w-3.5" /></button>
                      )}
                      <button type="button" onClick={() => void exportOne(s.id, s.label)} aria-label={t('scenarios.export')} title={t('scenarios.export')} className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"><Download className="h-3.5 w-3.5" /></button>
                      {s.kind === 'copy' && (
                        <button type="button" onClick={() => void del(s.id)} aria-label={t('scenarios.delete')} className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-6 text-[11px] text-muted-foreground">
                      {s.changesCount > 0 && <span>{t('scenarios.changes', { n: s.changesCount })}</span>}
                      {L ? (
                        <>
                          <span className="tnum">{t('scenarios.served', { s: L.servedOrders, n: L.totalOrders })}</span>
                          <span className="tnum">{t('scenarios.veh', { n: L.vehiclesUsed })}</span>
                          <span className="tnum">{km(L.totalDistanceKm)}</span>
                          {L.cost != null && <span className="tnum">{money(L.cost, L.currency ?? 'HUF', true)}</span>}
                          {L.unassigned > 0 && <span className="tnum text-warning">{t('scenarios.unassigned', { n: L.unassigned })}</span>}
                        </>
                      ) : <span className="italic">{t('scenarios.notSolved')}</span>}
                    </div>
                  </div>
                );
              })}
          </div>
        </ScrollArea>
        <p className="text-[10px] text-muted-foreground">{t('scenarios.hint')}</p>
      </DialogContent>
    </Dialog>
  );
}

function CompareTable({ selected, currency, t }: { selected: ScenarioSummary[]; currency: string; t: ReturnType<typeof useT> }) {
  type Row = { key: string; label: string; vals: number[]; fmt: (n: number) => string; best: 'min' | 'max' };
  const L = selected.map((s) => s.latest!);
  const rows: Row[] = [
    { key: 'served', label: t('scenarios.rowServed'), vals: L.map((x) => x.servedOrders), fmt: (n) => String(n), best: 'max' },
    { key: 'veh', label: t('scenarios.rowVehicles'), vals: L.map((x) => x.vehiclesUsed), fmt: (n) => String(n), best: 'min' },
    { key: 'km', label: t('scenarios.rowDistance'), vals: L.map((x) => x.totalDistanceKm), fmt: (n) => km(n), best: 'min' },
    { key: 'unassigned', label: t('scenarios.rowUnassigned'), vals: L.map((x) => x.unassigned), fmt: (n) => String(n), best: 'min' },
  ];
  if (L.every((x) => x.cost != null)) rows.splice(3, 0, { key: 'cost', label: t('scenarios.rowCost'), vals: L.map((x) => x.cost!), fmt: (n) => money(n, currency, true), best: 'min' });

  return (
    <div className="mb-2 overflow-x-auto rounded-md border border-divider">
      <table className="w-full border-collapse text-[11px]">
        <thead className="bg-muted/50">
          <tr>
            <th className="px-2 py-1 text-left font-medium text-muted-foreground">{t('scenarios.compare', { n: selected.length })}</th>
            {selected.map((s) => <th key={s.id} className="px-2 py-1 text-right font-medium">{s.label.length > 18 ? s.label.slice(0, 17) + '…' : s.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const target = r.best === 'max' ? Math.max(...r.vals) : Math.min(...r.vals);
            const hasSpread = new Set(r.vals).size > 1;
            return (
              <tr key={r.key} className="border-t border-divider">
                <td className="px-2 py-1 text-muted-foreground">{r.label}</td>
                {r.vals.map((v, i) => (
                  <td key={i} className={`tnum px-2 py-1 text-right ${hasSpread && v === target ? 'font-semibold text-primary' : ''}`}>{r.fmt(v)}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
