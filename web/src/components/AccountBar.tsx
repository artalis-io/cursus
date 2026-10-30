import { LogOut } from 'lucide-react';
import { useRef, useState } from 'react';
import { useT } from '@/i18n';
import type { Role, Permission } from '../../../server/src/roles';

export interface AccountUser {
  features?: {planningProfiles?:boolean;acknowledgedHandoff?:boolean;inputUpdates?:boolean};
  email: string;
  tenantId: string;
  tenantName?: string | null;
  role: Role;
  effectiveRole?: Role;
  permissions?: readonly Permission[];
  viewingAs?: 'planner' | 'reviewer' | null;
  build?: { version: string; revision: string | null };
}

export function AccountBar({ user, signingOut, error, onSignOut }: {
  user: AccountUser; signingOut: boolean; error: boolean; onSignOut: () => void;
}) {
  const t = useT();
  const [switching, setSwitching] = useState(false);
  const [viewError, setViewError] = useState(false);
  const previewPending = useRef(false);
  async function switchView(role: 'planner' | 'reviewer' | null) {
    // State disables the buttons on render; this lock covers same-frame events.
    if (previewPending.current) return;
    previewPending.current = true;
    setSwitching(true); setViewError(false);
    try {
      const response = await fetch('/api/auth/view-as', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role }) });
      if (!response.ok) throw new Error('View change failed');
      // Reload clears staged edits and any cached Admin-only views.
      window.location.reload();
    } catch { previewPending.current = false; setViewError(true); setSwitching(false); }
  }
  const local = user.email.split('@')[0] ?? '';
  const parts = local.split(/[._+-]+/).filter(Boolean);
  const initials = (parts.length > 1 ? parts.slice(0, 2).map(p => Array.from(p)[0]).join('') : Array.from(local).slice(0, 2).join('')).toUpperCase();
  const revision = user.build?.revision;
  // Effective permissions deliberately omit role.preview in preview mode.
  // The real Admin identity must retain the explicit escape hatch.
  const canPreview = user.role === 'admin' && (!!user.viewingAs || (user.permissions?.includes('role.preview') ?? true));
  return <footer aria-label={t('account.label')} className="shrink-0 border-t border-white/10 bg-graphite text-graphite-foreground">
    {error && <p role="alert" className="px-4 pt-2 text-xs">{t('account.signOutError')}</p>}
    {viewError && <p role="alert" className="px-4 pt-2 text-xs">{t('account.viewError')}</p>}
    <div className="grid min-h-11 min-w-0 grid-cols-[auto_minmax(0,1fr)_auto_auto_auto] items-center gap-2 px-3 sm:flex sm:gap-3 sm:px-4">
      <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-white/15 bg-white/10 text-[10px] font-semibold">{initials || '?'}</span>
      <span className="min-w-0 truncate text-xs" title={user.email}>{user.email}</span>
      <span className="shrink-0 rounded border border-white/15 px-1.5 py-0.5 text-[10px] text-graphite-foreground/70">{t(user.role === 'admin' ? 'account.admin' : user.role === 'planner' ? 'account.planner' : 'account.reviewer')}</span>
      {canPreview && <div className="order-last col-span-5 mb-2 flex w-full shrink-0 gap-2 sm:order-none sm:mb-0 sm:w-auto">
        {user.viewingAs ? <button type="button" disabled={switching} onClick={() => void switchView(null)} className="flex-1 rounded border border-primary/50 px-2 py-1 text-xs disabled:opacity-50">{t('account.returnAdmin')}</button>
          : (['planner', 'reviewer'] as const).map(role => <button key={role} type="button" disabled={switching} onClick={() => void switchView(role)} className="flex-1 rounded border border-primary/50 px-2 py-1 text-xs disabled:opacity-50">{t(role === 'planner' ? 'account.viewPlanner' : 'account.viewReviewer')}</button>)}
      </div>}
      {user.viewingAs && <span role="status" className="order-last col-span-5 mb-2 w-full text-xs text-graphite-foreground sm:order-none sm:mb-0 sm:w-auto">{t(user.viewingAs === 'planner' ? 'account.viewingPlanner' : 'account.viewingReviewer')}</span>}
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
