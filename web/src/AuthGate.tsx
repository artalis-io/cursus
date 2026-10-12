import { useEffect, useState, type ReactNode } from 'react';

interface User { email: string; tenantId: string; role: 'admin' }

export function AuthGate({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/auth/me').then(async (r) => setUser(r.ok ? await r.json() as User : null)).catch(() => setUser(null));
  }, []);

  if (user === undefined) return <div className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">Loading Cursus…</div>;
  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    setUser(null);
    setEmail('');
    setSent(false);
  }

  if (user) return <>
    {children}
    <button
      className="fixed bottom-4 right-4 z-50 rounded border border-border bg-card px-3 py-2 text-xs text-muted-foreground shadow hover:text-foreground"
      onClick={logout}
      title={`Signed in as ${user.email}`}
    >Sign out</button>
  </>;

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
  return <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
    <section className="w-full max-w-md rounded-lg border border-border bg-card p-8 shadow-xl">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">Cursus</p>
      <h1 className="mt-3 text-2xl font-semibold">Dispatch workspace</h1>
      <p className="mt-2 text-sm text-muted-foreground">Sign in with an approved email address. The link is valid for ten minutes and can be used once.</p>
      {invalid && <p className="mt-4 rounded border border-destructive/40 bg-destructive/10 p-3 text-sm">That sign-in link is invalid or expired.</p>}
      {sent ? <p className="mt-6 rounded border border-primary/40 bg-primary/10 p-4 text-sm">If this address is approved, a sign-in link has been sent.</p> :
        <form className="mt-6 space-y-4" onSubmit={submit}>
          <label className="block text-sm font-medium">Email
            <input className="mt-2 w-full rounded border border-border bg-background px-3 py-2 outline-none focus:border-primary" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <button className="w-full rounded bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-60" disabled={busy}>{busy ? 'Sending…' : 'Email me a sign-in link'}</button>
        </form>}
    </section>
  </main>;
}
