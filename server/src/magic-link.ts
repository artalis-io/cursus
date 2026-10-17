import type { FastifyInstance } from 'fastify';
import { gyermelyiIcon, workspaceBranding } from './workspace-branding.js';

/** Accept only the browser form encoding used by the confirmation page. */
export function registerMagicLinkFormParser(app: FastifyInstance): void {
  app.addContentTypeParser('application/x-www-form-urlencoded', {
    parseAs: 'string',
    bodyLimit: 1024,
  }, (_request, body, done) => done(null, body));
}

/**
 * Render an explicit confirmation step for an emailed magic link.
 *
 * Email security scanners routinely follow GET links. Consuming the token from
 * a GET would let a scanner steal the one-time credential before the user can
 * use it. Only the form's deliberate POST is allowed to consume the token.
 */
export function magicLinkLanguage(value: unknown, acceptLanguage = ''): 'en' | 'hu' {
  if (value === 'en' || value === 'hu') return value;
  return /^hu\b/i.test(acceptLanguage.trim()) ? 'hu' : 'en';
}

export function magicLinkConfirmation(token: string, tenantName = '', lang: 'en' | 'hu' = 'en'): string {
  const action = `/api/auth/verify?token=${encodeURIComponent(token)}`;
  const branding = workspaceBranding(tenantName);
  const hu = lang === 'hu';
  const copy = hu ? {
    title: 'Belépés a Cursusba', dispatch: 'Fuvarszervezés', secure: 'Biztonságos munkatér', workspace: 'Gyermelyi munkatér',
    authorized: 'Engedélyezett hozzáférés', description: 'A fuvarszervezési munkatér már csak egy lépésre van. Erősítse meg alább a biztonságos bejelentkezést.',
    button: 'Tovább a Cursusba', help: 'Ez az egyszer használható hivatkozás az igényléstől számított tíz percig érvényes. Ez a megerősítő lépés megakadályozza, hogy az e-mail-biztonsági ellenőrzők Ön előtt használják fel.',
    back: 'Új belépési hivatkozás kérése', language: 'Nyelv',
  } : {
    title: 'Sign in to Cursus', dispatch: 'Dispatch planning', secure: 'Secure workspace', workspace: 'Gyermelyi workspace',
    authorized: 'Authorized access', description: 'Your dispatch workspace is one step away. Confirm below to securely complete your sign-in.',
    button: 'Continue to Cursus', help: 'This one-time link expires ten minutes after it was requested. This extra step keeps email security scanners from using your link before you do.',
    back: 'Request a new sign-in link', language: 'Language',
  };
  const customer = branding ? `<div class="customer"><img src="data:image/png;base64,${gyermelyiIcon().toString('base64')}" alt="Gyermelyi" width="56" height="56"><span>${copy.workspace}</span></div>` : '';
  return `<!doctype html>
<html lang="${lang}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="referrer" content="no-referrer">
    <title>${copy.title}</title>
    <style>
      /* Match web/src/index.css's warm ivory, graphite and deep-green theme.
         Keep this credential-bearing page self-contained: no scripts, CDN or
         authenticated SPA assets are needed to confirm a link. */
      :root { color-scheme: light; --background: hsl(44 38% 93%); --foreground: hsl(40 10% 18%); --card: hsl(44 36% 95%); --primary: hsl(151 46% 33%); --muted: hsl(40 8% 42%); --divider: hsl(42 14% 78%); }
      * { box-sizing: border-box; }
      body { margin: 0; color: var(--foreground); background: var(--background); font-family: Inter, ui-sans-serif, system-ui, sans-serif; font-size: 14px; -webkit-font-smoothing: antialiased; }
      .shell { min-height: 100vh; min-height: 100svh; display: flex; flex-direction: column; background-image: linear-gradient(hsl(42 14% 78% / .14) 1px, transparent 1px), linear-gradient(90deg, hsl(42 14% 78% / .14) 1px, transparent 1px); background-size: 32px 32px; }
      header { height: 56px; flex-shrink: 0; display: flex; align-items: center; gap: 10px; padding: 0 32px; background: hsl(40 8% 12%); color: hsl(44 30% 92%); }
      .brand { font-weight: 600; letter-spacing: .04em; }
      .brand-mark { display: grid; place-items: center; width: 28px; height: 28px; background: var(--primary); border-radius: 4px; }
      svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; flex-shrink: 0; }
      .brand-mark svg { width: 16px; height: 16px; }
      .subtitle { border-left: 1px solid hsl(40 6% 55% / .4); padding-left: 10px; font-size: 12px; color: hsl(40 6% 55%); }
      .secure { margin-left: auto; color: hsl(40 6% 55%); font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
      .secure::before { content: ''; display: inline-block; width: 6px; height: 6px; margin-right: 8px; border-radius: 50%; background: var(--primary); }
      main { flex: 1; display: flex; align-items: center; justify-content: center; padding: 40px 24px; }
      section { width: 100%; max-width: 440px; border: 1px solid var(--divider); border-radius: 8px; background: var(--card); box-shadow: 0 18px 60px -28px rgb(38 35 29 / .45); overflow: hidden; }
      .intro, .actions { padding: 28px 32px; }
      .intro { border-bottom: 1px solid var(--divider); }
      .lock { display: grid; place-items: center; width: 40px; height: 40px; margin-bottom: 20px; border: 1px solid hsl(151 46% 33% / .25); border-radius: 6px; background: hsl(151 46% 33% / .1); color: var(--primary); }
      .eyebrow { margin: 0; color: var(--primary); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .18em; }
      .customer { display: flex; align-items: center; gap: 14px; margin-bottom: 20px; font-weight: 600; }
      .customer img { display: block; object-fit: contain; flex-shrink: 0; }
      .languages { position: absolute; top: 14px; right: 32px; display: flex; gap: 10px; }
      .shell { position: relative; }
      .secure { margin-right: 100px; }
      .languages a { color: hsl(44 30% 92%); padding: 4px; text-underline-offset: 4px; }
      .languages a[aria-current] { color: white; font-weight: 700; }
      h1 { margin: 8px 0; font-size: 24px; font-weight: 600; letter-spacing: -.025em; }
      p { margin: 0; color: var(--muted); line-height: 1.7; }
      button { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; min-height: 44px; padding: 10px 16px; border: 0; border-radius: 6px; background: var(--primary); color: hsl(44 40% 97%); font: inherit; font-weight: 500; cursor: pointer; }
      button:hover { background: hsl(151 46% 28%); }
      :focus-visible { outline: 2px solid var(--primary); outline-offset: 4px; }
      .help { margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--divider); font-size: 12px; }
      .back { display: inline-block; margin-top: 12px; color: var(--primary); text-underline-offset: 3px; font-size: 12px; }
      @media (max-width: 480px) { header { padding: 0 20px; } .subtitle, .secure { display: none; } .languages { right: 20px; } main { padding: 32px 16px; } .intro, .actions { padding: 24px; } }
    </style>
  </head>
  <body>
    <div class="shell">
      <header aria-label="Cursus">
        <span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="6" cy="18" r="3"/><circle cx="18" cy="6" r="3"/><path d="M6 15V6a3 3 0 0 1 3-3h1M18 9v9a3 3 0 0 1-3 3h-1"/></svg></span>
        <span class="brand">Cursus</span><span class="subtitle">${copy.dispatch}</span>
        <span class="secure">${copy.secure}</span>
      </header>
      <main>
        <section aria-labelledby="confirmation-title">
          <div class="intro">
            ${customer}
            ${branding ? '' : '<div class="lock" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4M12 15v3"/></svg></div>'}
            <p class="eyebrow">${copy.authorized}</p>
            <h1 id="confirmation-title">${copy.title}</h1>
            <p>${copy.description}</p>
          </div>
          <div class="actions">
            <form method="post" action="${action}" enctype="application/x-www-form-urlencoded">
              <button type="submit">${copy.button} <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 12h14m-6-6 6 6-6 6"/></svg></button>
            </form>
            <p class="help">${copy.help}</p>
            <a class="back" href="/">${copy.back}</a>
          </div>
        </section>
      </main>
      <nav class="languages" aria-label="${copy.language}"><a href="${action}&amp;lang=en"${hu ? '' : ' aria-current="page"'}>EN</a><a href="${action}&amp;lang=hu"${hu ? ' aria-current="page"' : ''}>HU</a></nav>
    </div>
  </body>
</html>`;
}
