import { useEffect, useState, type ReactNode } from 'react';
import { ArrowRight, CheckCircle2, LoaderCircle, LockKeyhole, Mail, Route } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AccountBar, type AccountUser } from '@/components/AccountBar';
import { WorkspaceNameContext } from '@/workspace';

export function AuthGate({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AccountUser | null | undefined>(undefined);
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [logoutError, setLogoutError] = useState(false);

  useEffect(() => {
    fetch('/api/auth/me').then(async (r) => setUser(r.ok ? await r.json() as AccountUser : null)).catch(() => setUser(null));
  }, []);

  if (user === undefined) return <div className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
    <LoaderCircle className="mr-2 h-4 w-4 animate-spin text-primary" /> Loading Cursus…
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
      <div data-testid="workspace-content" className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</div>
    </WorkspaceNameContext.Provider>
    <AccountBar user={user} signingOut={signingOut} error={logoutError} onSignOut={() => void logout()} />
  </div>;

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const r = await fetch('/api/auth/magic-link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
      if (!r.ok) throw new Error('Unable to request a sign-in link.');
      setSent(true);
    } catch (err) { setError((err as Error).message); }
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
          <span className="hidden border-l border-graphite-muted/40 pl-2.5 text-xs text-graphite-muted sm:inline">Dispatch planning</span>
        </div>
        <div className="ml-auto flex items-center gap-2 text-[11px] uppercase tracking-wider text-graphite-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-primary" /> Secure workspace
        </div>
      </header>

      <div className="flex flex-1 items-center justify-center px-4 py-10 sm:px-6">
        <section aria-labelledby="login-title" className="w-full max-w-[440px] overflow-hidden rounded-lg border border-divider bg-card shadow-[0_18px_60px_-28px_rgba(38,35,29,0.45)]">
          <div className="border-b border-divider px-6 py-6 sm:px-8 sm:py-7">
            <div className="mb-5 flex h-10 w-10 items-center justify-center rounded-md border border-primary/25 bg-primary/10 text-primary">
              <LockKeyhole className="h-5 w-5" />
            </div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">Authorized access</p>
            <h1 id="login-title" className="mt-2 text-2xl font-semibold tracking-tight">Continue to Cursus</h1>
            <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">Sign in with an approved email address to open the dispatch workspace.</p>
          </div>

          <div className="px-6 py-6 sm:px-8 sm:py-7">
            {invalid && <div role="alert" className="mb-5 border-l-2 border-destructive bg-destructive/10 px-3 py-2.5 text-sm text-foreground">
              <span className="font-medium">Link unavailable.</span> That sign-in link is invalid or expired. Request a new one below.
            </div>}
            {sent ? <div role="status" className="rounded-md border border-primary/30 bg-primary/10 p-4">
              <div className="flex gap-3">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                <div><p className="text-sm font-semibold">Check your inbox</p><p className="mt-1 text-sm leading-5 text-muted-foreground">If this address is approved, a sign-in link has been sent. It expires in ten minutes and works once.</p></div>
              </div>
              <Button type="button" variant="outline" size="sm" className="mt-4 w-full bg-card" onClick={() => setSent(false)}>Use another email</Button>
            </div> :
              <form className="space-y-4" onSubmit={submit}>
                <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground" htmlFor="cursus-login-email">Work email</label>
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input id="cursus-login-email" className="h-10 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary focus:ring-1 focus:ring-primary" type="email" inputMode="email" autoCapitalize="none" autoComplete="email" placeholder="name@company.com" required value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
                {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                <Button className="h-10 w-full" disabled={busy}>{busy ? <><LoaderCircle className="animate-spin" /> Sending link…</> : <>Email me a sign-in link <ArrowRight /></>}</Button>
              </form>}
            <div className="mt-6 flex items-start gap-2 border-t border-divider pt-4 text-xs leading-5 text-muted-foreground">
              <LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Passwordless access. Links expire after ten minutes and can only be used once.
            </div>
          </div>
        </section>
      </div>
    </div>
  </main>;
}
