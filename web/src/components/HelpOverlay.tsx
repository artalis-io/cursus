import { useEffect } from 'react';
import { X } from 'lucide-react';
import { useT } from '@/i18n';

/* A one-shot annotated overlay over the live layout: dark backdrop + callout
 * cards anchored to each region (top bar, fleet, map, inspector, timeline).
 * Shown on first run and from the TopBar '?'. Click anywhere / Esc to dismiss. */
export function HelpOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;

  const Card = ({ n, k, className }: { n: number; k: string; className: string }) => (
    <div className={`absolute w-64 rounded-lg border border-divider bg-card p-3 shadow-xl ${className}`}>
      <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold">
        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] text-primary-foreground">{n}</span>
        {t(`help.${k}.t`)}
      </div>
      <p className="text-[11px] leading-snug text-muted-foreground">{t(`help.${k}.b`)}</p>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[1px]" onClick={onClose} role="dialog" aria-label={t('help.title')}>
      <Card n={1} k="topbar" className="left-1/2 top-16 -translate-x-1/2" />
      <Card n={2} k="fleet" className="left-4 top-1/4" />
      <Card n={3} k="map" className="left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" />
      <Card n={4} k="inspector" className="right-4 top-1/4" />
      <Card n={5} k="timeline" className="bottom-56 left-1/2 -translate-x-1/2" />
      <button type="button" onClick={onClose}
        className="absolute bottom-7 left-1/2 -translate-x-1/2 rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground shadow-lg hover:bg-primary/90">
        {t('help.gotit')}
      </button>
      <button type="button" onClick={onClose} aria-label={t('help.close')}
        className="absolute right-4 top-4 rounded-full bg-card p-1.5 text-muted-foreground shadow hover:text-foreground">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
