import { useEffect, useState, type ReactNode } from 'react';
import { ArrowRight, CheckCircle2, LoaderCircle, LockKeyhole, Mail, Route } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AccountBar, type AccountUser } from '@/components/AccountBar';
import { WorkspaceNameContext } from '@/workspace';
import { useI18n } from '@/i18n';
import { RoleContext } from '@/permissions';

export function AuthGate({ children }: { children: ReactNode }) {
  const { lang, setLang, t } = useI18n();
  const [user, setUser] = useState<AccountUser | null | undefined>(undefined);
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [logoutError, setLogoutError] = useState(false);
  const [workspaceBrand, setWorkspaceBrand] = useState(false);

  useEffect(() => {
    let alive = true;
    const refresh = () => { void fetch('/api/auth/me', { cache: 'no-store' }).then(async r => {
      if (r.ok) { const value = await r.json() as AccountUser; if (alive) setUser(value); }
      else if (r.status === 401 && alive) setUser(null);
      else if (alive) setUser(current => current === undefined ? null : current);
    }).catch(() => { if (alive) setUser(current => current === undefined ? null : current); }); };
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh);
    window.addEventListener('cursus:refresh-auth', refresh);
    fetch('/api/auth/workspace').then(async (r) => {
      if (!r.ok) return;
      const data = await r.json() as { branding?: { name?: string; icon?: string } | null };
      setWorkspaceBrand(data.branding?.name === 'Gyermelyi' && data.branding.icon === '/api/auth/workspace/icon');
    }).catch(() => { /* Branding failure must never block sign-in. */ });
    return () => { alive = false; window.clearInterval(timer); window.removeEventListener('focus', refresh); window.removeEventListener('cursus:refresh-auth', refresh); };
  }, []);

  if (user === undefined) return <div className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
    <LoaderCircle className="mr-2 h-4 w-4 animate-spin text-primary" /> {t('auth.loading')}
  </div>;
  async function logout() {
    setSigningOut(true); setLogoutError(false);
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST' });
      if (!response.ok) throw new Error('Sign out failed');
      setUser(null); setEmail(''); setSent(false);
    } catch { setLogoutError(true); }
    finally { setSigningOut(false); }
  }

  if (user) return <div className="flex h-full min-h-0 flex-col overflow-hidden">
    <WorkspaceNameContext.Provider value={user.tenantName?.trim() || null}>
      <RoleContext.Provider value={(user.effectiveRole || user.role) === 'admin' ? 'admin' : 'reviewer'}>
        <div data-testid="workspace-content" className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</div>
      </RoleContext.Provider>
    </WorkspaceNameContext.Provider>
    <AccountBar user={user} signingOut={signingOut} error={logoutError} onSignOut={() => void logout()} />
  </div>;

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const r = await fetch('/api/auth/magic-link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
      if (!r.ok) throw new Error(t('auth.error'));
      setSent(true);
    } catch { setError(t('auth.error')); }
    finally { setBusy(false); }
  }

  const invalid = new URLSearchParams(location.search).get('auth') === 'invalid';
  return <main className="relative min-h-screen overflow-hidden bg-background text-foreground">
    <div aria-hidden="true" className="absolute inset-0 opacity-40 [background-image:linear-gradient(hsl(var(--divider)/.35)_1px,transparent_1px),linear-gradient(90deg,hsl(var(--divider)/.35)_1px,transparent_1px)] [background-size:32px_32px]" />
    <div className="relative flex min-h-screen flex-col">
      <header className="flex h-14 shrink-0 items-center border-b border-graphite bg-graphite px-5 text-graphite-foreground sm:px-8">
        <div className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded bg-primary"><Route className="h-4 w-4" /></span>
          <span className="text-sm font-semibold tracking-wide">Cursus</span>
          <span className="hidden border-l border-graphite-muted/40 pl-2.5 text-xs text-graphite-muted sm:inline">{t('auth.dispatch')}</span>
        </div>
        <div className="ml-auto flex items-center gap-2 text-[11px] uppercase tracking-wider text-graphite-muted">
          <span className="hidden h-1.5 w-1.5 rounded-full bg-primary sm:block" /><span className="hidden sm:inline">{t('auth.secure')}</span>
          <div role="group" aria-label={t('lang.switch')} className="ml-3 flex rounded border border-graphite-muted/40 p-0.5 normal-case tracking-normal">
            {(['en', 'hu'] as const).map(value => <button key={value} type="button" aria-pressed={lang === value} onClick={() => setLang(value)} className={`rounded px-2 py-1 ${lang === value ? 'bg-primary text-white' : 'text-graphite-muted'}`}>{value.toUpperCase()}</button>)}
          </div>
        </div>
      </header>

      <div className="flex flex-1 items-center justify-center px-4 py-10 sm:px-6">
        <section aria-labelledby="login-title" className="w-full max-w-[440px] overflow-hidden rounded-lg border border-divider bg-card shadow-[0_18px_60px_-28px_rgba(38,35,29,0.45)]">
          <div className="border-b border-divider px-6 py-6 sm:px-8 sm:py-7">
            {workspaceBrand && <div className="mb-5 flex items-center gap-3.5">
              <img src="/api/auth/workspace/icon" alt="Gyermelyi" width={56} height={56} className="h-14 w-14 shrink-0 object-contain" />
              <span className="text-sm font-semibold">{t('auth.workspace')}</span>
            </div>}
            {!workspaceBrand && <div className="mb-5 flex h-10 w-10 items-center justify-center rounded-md border border-primary/25 bg-primary/10 text-primary">
              <LockKeyhole className="h-5 w-5" />
            </div>}
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">{t('auth.authorized')}</p>
            <h1 id="login-title" className="mt-2 text-2xl font-semibold tracking-tight">{t('auth.title')}</h1>
            <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">{t('auth.description')}</p>
          </div>

          <div className="px-6 py-6 sm:px-8 sm:py-7">
            {invalid && <div role="alert" className="mb-5 border-l-2 border-destructive bg-destructive/10 px-3 py-2.5 text-sm text-foreground">
              <span className="font-medium">{t('auth.unavailable')}</span> {t('auth.invalid')}
            </div>}
            {sent ? <div role="status" className="rounded-md border border-primary/30 bg-primary/10 p-4">
              <div className="flex gap-3">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                <div><p className="text-sm font-semibold">{t('auth.inbox')}</p><p className="mt-1 text-sm leading-5 text-muted-foreground">{t('auth.sent')}</p></div>
              </div>
              <Button type="button" variant="outline" size="sm" className="mt-4 w-full bg-card" onClick={() => setSent(false)}>{t('auth.other')}</Button>
            </div> :
              <form className="space-y-4" onSubmit={submit}>
                <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground" htmlFor="cursus-login-email">{t('auth.email')}</label>
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input id="cursus-login-email" className="h-10 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary focus:ring-1 focus:ring-primary" type="email" inputMode="email" autoCapitalize="none" autoComplete="email" placeholder="name@company.com" required value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
                {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                <Button className="h-10 w-full" disabled={busy}>{busy ? <><LoaderCircle className="animate-spin" /> {t('auth.sending')}</> : <>{t('auth.send')} <ArrowRight /></>}</Button>
              </form>}
            <div className="mt-6 flex items-start gap-2 border-t border-divider pt-4 text-xs leading-5 text-muted-foreground">
              <LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {t('auth.help')}
            </div>
          </div>
        </section>
      </div>
    </div>
  </main>;
}
