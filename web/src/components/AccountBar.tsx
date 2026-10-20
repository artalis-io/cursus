import { LogOut } from 'lucide-react';
import { useState } from 'react';
import { useT } from '@/i18n';

export interface AccountUser {
  email: string;
  tenantId: string;
  tenantName?: string | null;
  role: 'admin' | 'reviewer';
  effectiveRole?: 'admin' | 'reviewer';
  viewingAs?: 'reviewer' | null;
  build?: { version: string; revision: string | null };
}

export function AccountBar({ user, signingOut, error, onSignOut }: {
  user: AccountUser; signingOut: boolean; error: boolean; onSignOut: () => void;
}) {
  const t = useT();
  const [switching, setSwitching] = useState(false);
  const [viewError, setViewError] = useState(false);
  async function switchView() {
    setSwitching(true); setViewError(false);
    try {
      const response = await fetch('/api/auth/view-as', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: user.viewingAs ? null : 'reviewer' }) });
      if (!response.ok) throw new Error('View change failed');
      // Reload clears staged edits and any cached Admin-only views.
      window.location.reload();
    } catch { setViewError(true); setSwitching(false); }
  }
  const local = user.email.split('@')[0] ?? '';
  const parts = local.split(/[._+-]+/).filter(Boolean);
  const initials = (parts.length > 1 ? parts.slice(0, 2).map(p => Array.from(p)[0]).join('') : Array.from(local).slice(0, 2).join('')).toUpperCase();
  const revision = user.build?.revision;
  return <footer aria-label={t('account.label')} className="shrink-0 border-t border-white/10 bg-graphite text-graphite-foreground">
    {error && <p role="alert" className="px-4 pt-2 text-xs">{t('account.signOutError')}</p>}
    {viewError && <p role="alert" className="px-4 pt-2 text-xs">{t('account.viewError')}</p>}
    <div className="grid min-h-11 min-w-0 grid-cols-[auto_minmax(0,1fr)_auto_auto_auto] items-center gap-2 px-3 sm:flex sm:gap-3 sm:px-4">
      <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-white/15 bg-white/10 text-[10px] font-semibold">{initials || '?'}</span>
      <span className="min-w-0 truncate text-xs" title={user.email}>{user.email}</span>
      <span className="shrink-0 rounded border border-white/15 px-1.5 py-0.5 text-[10px] text-graphite-foreground/70">{t(user.role === 'admin' ? 'account.admin' : 'account.reviewer')}</span>
      {user.role === 'admin' && <button type="button" disabled={switching} onClick={() => void switchView()} aria-pressed={!!user.viewingAs} className="order-last col-span-5 mb-2 w-full shrink-0 rounded border border-primary/50 px-2 py-1 text-xs focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50 sm:order-none sm:mb-0 sm:w-auto">{t(user.viewingAs ? 'account.returnAdmin' : 'account.viewReviewer')}</button>}
      {user.viewingAs && <span role="status" className="order-last col-span-5 mb-2 w-full text-xs text-graphite-foreground sm:order-none sm:mb-0 sm:w-auto">{t('account.viewingReviewer')}</span>}
      <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[10px] text-graphite-foreground/70" aria-label={t('account.build')} title={revision ? `${user.build?.version} · ${revision}` : t('account.unknownBuild')}>
        {user.build && <span className="hidden sm:inline">v{user.build.version}</span>}
        <span className="font-mono">{revision ? revision.slice(0, 7) : t('account.unknownBuild')}</span>
      </span>
      <button type="button" onClick={onSignOut} disabled={signingOut}
        className="ml-1 flex min-h-11 shrink-0 items-center gap-1.5 border-l border-white/15 pl-3 text-xs text-graphite-foreground/80 hover:text-graphite-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary disabled:opacity-50">
        <LogOut aria-hidden="true" className="h-3.5 w-3.5" />{signingOut ? t('account.signingOut') : t('account.signOut')}
      </button>
    </div>
  </footer>;
}
