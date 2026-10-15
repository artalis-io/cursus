import { LogOut } from 'lucide-react';
import { useT } from '@/i18n';

export interface AccountUser {
  email: string;
  tenantId: string;
  tenantName?: string | null;
  role: 'admin';
  build?: { version: string; revision: string | null };
}

export function AccountBar({ user, signingOut, error, onSignOut }: {
  user: AccountUser; signingOut: boolean; error: boolean; onSignOut: () => void;
}) {
  const t = useT();
  const local = user.email.split('@')[0] ?? '';
  const parts = local.split(/[._+-]+/).filter(Boolean);
  const initials = (parts.length > 1 ? parts.slice(0, 2).map(p => Array.from(p)[0]).join('') : Array.from(local).slice(0, 2).join('')).toUpperCase();
  const revision = user.build?.revision;
  return <footer aria-label={t('account.label')} className="shrink-0 border-t border-white/10 bg-graphite text-graphite-foreground">
    {error && <p role="alert" className="px-4 pt-2 text-xs">{t('account.signOutError')}</p>}
    <div className="flex min-h-11 min-w-0 items-center gap-2 px-3 sm:gap-3 sm:px-4">
      <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-white/15 bg-white/10 text-[10px] font-semibold">{initials || '?'}</span>
      <span className="min-w-0 truncate text-xs" title={user.email}>{user.email}</span>
      <span className="hidden shrink-0 rounded border border-white/15 px-1.5 py-0.5 text-[10px] text-graphite-foreground/70 sm:inline">{t('account.admin')}</span>
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
