import { useEffect, useState } from 'react';
import { FileSpreadsheet, ArrowRight, CheckCircle2, ShieldCheck } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { api, type ImportSummary, type RawSample, type CanonicalSample } from '@/lib/api';
import { OnboardPanel } from '@/components/OnboardPanel';
import { useT, describeApiError } from '@/i18n';

export function ImportDialog({ open, onOpenChange, onAdmitted, onDatasetsChanged }: { open: boolean; onOpenChange: (o: boolean) => void; onAdmitted?: (dayId: string) => void; onDatasetsChanged?: () => void }) {
  const t = useT();
  const [mode, setMode] = useState<'provenance' | 'upload'>('provenance');
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [rawFile, setRawFile] = useState('orders');
  const [raw, setRaw] = useState<RawSample | null>(null);
  const [canon, setCanon] = useState<CanonicalSample | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setErr(null);
    api.importSummary().then((s) => { if (alive) setSummary(s); }).catch((e) => { if (alive) setErr(describeApiError(e, t)); });
    api.importCanonical().then((c) => { if (alive) setCanon(c); }).catch((e) => { if (alive) setErr(describeApiError(e, t)); });
    return () => { alive = false; };
  }, [open, t]);
  useEffect(() => {
    if (!open) return;
    let alive = true;   // guard the last-write-wins race when switching raw file fast
    api.importRaw(rawFile).then((r) => { if (alive) setRaw(r); }).catch(() => { if (alive) setRaw(null); });
    return () => { alive = false; };
  }, [open, rawFile]);

  const audit = summary?.canonical.orders.audit;
  const shaMatch = summary && summary.canonical.orders.sourceSha256 && summary.sources.find((s) => s.kind === 'orders')?.sha256
    && summary.canonical.orders.sourceSha256.startsWith(summary.sources.find((s) => s.kind === 'orders')!.sha256!);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><FileSpreadsheet className="h-4 w-4" /> {t('import.title')}</DialogTitle></DialogHeader>
        <div className="flex items-center rounded-md border border-divider p-0.5 text-xs" role="tablist">
          {(['provenance', 'upload'] as const).map((m) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)}
              className={`rounded px-3 py-1 font-medium transition-colors ${mode === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'}`}>
              {t(m === 'provenance' ? 'import.tabProvenance' : 'import.tabUpload')}
            </button>
          ))}
        </div>
        {err && <p className="text-sm text-destructive">{err}</p>}
        {mode === 'upload' ? <OnboardPanel onAdmitted={onAdmitted} onDatasetsChanged={onDatasetsChanged} /> : !summary ? <p className="py-8 text-center text-sm text-muted-foreground">{t('import.loading')}</p> : (
          <ScrollArea className="max-h-[72vh]">
            <div className="space-y-4 pr-3">
              {/* Provenance summary */}
              <div className="grid grid-cols-3 gap-2">
                {summary.sources.map((s) => (
                  <div key={s.kind} className="rounded-md border border-divider bg-card p-2.5">
                    <div className="text-xs font-semibold">{s.label}</div>
                    <div className="tnum text-[11px] text-muted-foreground">{s.rawRows} rows · sha {s.sha256}</div>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {audit && (
                  <Badge variant="outline" className="gap-1"><CheckCircle2 className="h-3 w-3 text-primary" /> {t('import.nexusAudit', { a: audit.rows_accepted ?? 0, b: audit.rows_processed ?? 0, e: audit.validation?.errors ?? 0, w: audit.validation?.warnings ?? 0 })}</Badge>
                )}
                {shaMatch && <Badge variant="outline" className="gap-1"><ShieldCheck className="h-3 w-3 text-primary" /> {t('import.shaMatch')}</Badge>}
                <Badge variant="outline">{t('import.scope', { n: summary.scope.inScopeHungarian, a: summary.scope.day1, b: summary.scope.day2 })}</Badge>
              </div>

              {/* Pipeline */}
              <Section title={t('import.pipeline')}>
                <div className="flex flex-wrap items-stretch gap-1.5">
                  {summary.pipeline.map((p, i) => (
                    <div key={p.stage} className="flex items-center gap-1.5">
                      <div className="max-w-[200px] rounded border border-divider bg-muted/40 p-2">
                        <div className="text-[11px] font-semibold">{p.stage}</div>
                        <div className="text-[10px] leading-tight text-muted-foreground">{p.detail}</div>
                      </div>
                      {i < summary.pipeline.length - 1 && <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />}
                    </div>
                  ))}
                </div>
              </Section>

              {/* Rules */}
              <Section title={t('import.rules')}>
                <ul className="list-disc space-y-0.5 pl-5 text-xs text-foreground/80">
                  {summary.rules.map((r) => <li key={r}>{r}</li>)}
                </ul>
              </Section>

              {/* Raw -> canonical sample */}
              <Section title={t('import.rawCanonical')}>
                <div className="mb-1.5 flex gap-1">
                  {['orders', 'vehicles', 'routes'].map((f) => (
                    <button key={f} type="button" onClick={() => setRawFile(f)}
                      className={`rounded px-2 py-0.5 text-[11px] ${rawFile === f ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-accent'}`}>{t(`import.tab.${f}`)}</button>
                  ))}
                  <span className="ml-auto self-center text-[11px] text-muted-foreground">{t('import.excelHdr')}</span>
                </div>
                {raw && <MiniTable headers={raw.headers} rows={raw.rows} maxCols={8} />}

                {rawFile === 'orders' && canon && (
                  <>
                    <div className="mt-3 mb-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground"><ArrowRight className="h-3 w-3" /> {t('import.canonicalRecords', { sha: canon.sha256 ? t('import.provHashed') : '' })}</div>
                    <MiniTable headers={canon.fields} rows={canon.rows.map((r) => canon.fields.map((f) => String(r[f] ?? '')))} maxCols={9} />
                  </>
                )}
              </Section>
            </div>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
      {children}
    </div>
  );
}

function MiniTable({ headers, rows, maxCols }: { headers: string[]; rows: string[][]; maxCols: number }) {
  const cols = headers.slice(0, maxCols);
  return (
    <div className="overflow-x-auto rounded border border-divider">
      <table className="w-full border-collapse text-[10px]">
        <thead>
          <tr className="bg-muted/50">
            {cols.map((h, i) => <th key={i} className="border-b border-divider px-1.5 py-1 text-left font-medium text-muted-foreground">{h || '—'}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="odd:bg-card even:bg-muted/20">
              {cols.map((_, ci) => <td key={ci} className="tnum truncate whitespace-nowrap border-b border-divider px-1.5 py-1" style={{ maxWidth: 140 }}>{r[ci] ?? ''}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
