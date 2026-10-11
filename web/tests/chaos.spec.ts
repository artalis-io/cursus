import { test, expect, type Page } from '@playwright/test';

/* Chaos monkey: drive random, reversible UI actions and watch for crashes,
 * uncaught exceptions, console errors, 5xx responses and dead-ends. Gated on
 * CHAOS=1 so it does not run in the normal suite (slow, exploratory). Seeded so
 * a failing run is reproducible; every error is tagged with the action trail.
 *
 *   CHAOS=1 CHAOS_STEPS=120 CHAOS_SEED=1 npx playwright test chaos.spec.ts
 *
 * Deliberately avoids: Optimize/Replan (slow solves), data upload/admit, dataset
 * delete, and export downloads. */

test.skip(process.env.CHAOS !== '1', 'set CHAOS=1 to run the chaos monkey');
test.setTimeout(600_000);

// Small seeded PRNG (mulberry32) so a run is reproducible from CHAOS_SEED.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

test('chaos monkey finds no crashes, uncaught errors or dead-ends', async ({ page }) => {
  const STEPS = Number(process.env.CHAOS_STEPS ?? 120);
  const SEED = Number(process.env.CHAOS_SEED ?? 1);
  const rand = rng(SEED);
  const pick = <T>(xs: T[]): T | undefined => xs.length ? xs[Math.floor(rand() * xs.length)] : undefined;

  const trail: string[] = [];
  const recent = () => trail.slice(-6).join(' -> ');
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const serverErrors: string[] = [];
  const overflowHits: string[] = [];
  let rateLimited = 0;

  page.on('pageerror', (e) => pageErrors.push(`${e.message} :: after [${recent()}]`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/ReadPixels|WebGL|willReadFrequently|Download the React/i.test(t)) return; // benign renderer noise
    consoleErrors.push(`${t.slice(0, 200)} :: after [${recent()}]`);
  });
  page.on('response', (r) => {
    const s = r.status();
    if (s === 429) { rateLimited++; return; }
    if (s >= 500 && r.url().includes('/api/')) serverErrors.push(`${s} ${r.request().method()} ${new URL(r.url()).pathname} :: after [${recent()}]`);
  });

  // Auto-accept native confirms (e.g. discard-staged-edits on day/scenario switch).
  page.on('dialog', (d) => void d.accept().catch(() => {}));

  await page.addInitScript(() => { try { localStorage.setItem('otto.helpSeen', '1'); } catch { /* ignore */ } });
  await page.goto('/');
  await expect(page.getByText('Served / Total')).toBeVisible();
  await expect(page.getByText('RIC-124').first()).toBeVisible();
  await page.waitForTimeout(2000);

  const leftAside = () => page.locator('aside').first();
  const inspector = () => page.locator('aside').last();
  const clickRandVisible = async (loc: ReturnType<Page['locator']>, max = 12): Promise<boolean> => {
    const n = Math.min(await loc.count(), max);
    if (n === 0) return false;
    const el = loc.nth(Math.floor(rand() * n));
    if (!(await el.isVisible().catch(() => false))) return false;
    await el.click({ timeout: 2500, trial: false });
    return true;
  };

  // Each action is reversible / non-destructive and tolerant of "nothing to do".
  const actions: { name: string; run: () => Promise<void> }[] = [
    { name: 'open-issues', run: async () => { await page.getByRole('button', { name: /Issues/ }).first().click({ timeout: 2500 }); } },
    { name: 'open-scenarios', run: async () => { await page.getByRole('button', { name: /Scenarios/ }).first().click({ timeout: 2500 }); } },
    { name: 'open-week', run: async () => { await page.getByRole('button', { name: /^Week$/ }).first().click({ timeout: 2500 }); } },
    { name: 'open-plans', run: async () => { await page.getByRole('button', { name: /Plans/ }).first().click({ timeout: 2500 }); } },
    { name: 'open-data', run: async () => { await page.getByRole('button', { name: /^Data$/ }).first().click({ timeout: 2500 }); } },
    { name: 'open-help', run: async () => { await page.getByRole('button', { name: /Help|\?/ }).first().click({ timeout: 2500 }); } },
    { name: 'open-changes', run: async () => { const b = page.getByRole('button', { name: /Changes/ }); if (await b.count()) await b.first().click({ timeout: 2500 }); } },
    { name: 'esc', run: async () => { await page.keyboard.press('Escape'); } },
    { name: 'dialog-random-button', run: async () => {
      const dlg = page.getByRole('dialog');
      if (!(await dlg.count())) return;
      // avoid destructive labels inside dialogs
      const btns = dlg.locator('button:visible').filter({ hasNotText: /Delete|Remove|Admit|Import|Export/ });
      await clickRandVisible(btns, 10);
    } },
    { name: 'select-vehicle', run: async () => { await clickRandVisible(leftAside().locator('div.rounded-md >> span.font-semibold'), 12); } },
    { name: 'expand-vehicle', run: async () => { await clickRandVisible(leftAside().getByRole('button', { name: /Expand trips|Collapse trips/ }), 12); } },
    { name: 'select-trip', run: async () => { await clickRandVisible(inspector().getByRole('button', { name: /Trip \d/ }), 6); } },
    { name: 'select-stop', run: async () => { await clickRandVisible(inspector().locator('ol li button').filter({ hasNot: page.locator('[data-move]') }), 10); } },
    { name: 'reorder-stop', run: async () => { await clickRandVisible(inspector().locator('button[data-move]'), 10); } },
    { name: 'mark-unavailable', run: async () => { const b = inspector().getByRole('button', { name: /Mark .* unavailable/ }); if (await b.count()) await b.first().click({ timeout: 2500 }); } },
    { name: 'restore-vehicle', run: async () => { const b = page.getByRole('button', { name: /Restore/ }); if (await b.count()) await b.first().click({ timeout: 2500 }); } },
    { name: 'lock-route', run: async () => { const b = inspector().getByRole('button', { name: /Lock route|Route locked/ }); if (await b.count()) await b.first().click({ timeout: 2500 }); } },
    { name: 'filter-chip', run: async () => { await clickRandVisible(leftAside().locator('button.rounded-full'), 4); } },
    { name: 'search', run: async () => { const i = leftAside().locator('input[type=text], input:not([type])').first(); if (await i.count()) { await i.fill(pick(['ric', 'buda', 'kft', '', 'xyz']) ?? ''); } } },
    { name: 'lang-toggle', run: async () => { await clickRandVisible(page.locator('[aria-label="Switch language"] button, header button'), 2); } },
    { name: 'solve-settings', run: async () => { await page.getByRole('button', { name: /Solve settings/ }).first().click({ timeout: 2500 }); const r = page.locator('input[type=range]').first(); if (await r.count()) await r.fill(String(15 + Math.floor(rand() * 200))); } },
    { name: 'timeline-play', run: async () => { const b = page.getByRole('button', { name: /^Play$|^Pause$/ }); if (await b.count()) await b.first().click({ timeout: 2500 }); } },
    { name: 'timeline-seek', run: async () => { const r = page.getByRole('slider', { name: 'Seek' }); if (await r.count()) await r.first().fill(String(20000 + Math.floor(rand() * 60000))); } },
    { name: 'timeline-fleet-row', run: async () => { await clickRandVisible(page.getByRole('button', { name: /:\s*\d+ trips/ }), 12); } },
    { name: 'map-zoom', run: async () => { await clickRandVisible(page.getByRole('button', { name: /Zoom in|Zoom out|Fit plan/ }), 3); } },
    { name: 'map-click', run: async () => { const c = page.locator('canvas.maplibregl-canvas').first(); if (await c.count()) { const box = await c.boundingBox(); if (box) await page.mouse.click(box.x + box.width * rand(), box.y + box.height * rand()); } } },
    { name: 'export-menu', run: async () => { await page.getByRole('button', { name: /Export/ }).first().click({ timeout: 2500 }); } },
    { name: 'reset-baseline', run: async () => { const b = page.getByRole('button', { name: /Baseline|Reset/ }); if (await b.count()) await b.first().click({ timeout: 2500 }); } },
    { name: 'collapse-panels', run: async () => { await clickRandVisible(page.getByRole('button', { name: /fleet panel|inspector/ }), 2); } },
  ];

  let deadStep = -1;
  for (let i = 0; i < STEPS; i++) {
    const a = pick(actions)!;
    trail.push(a.name);
    try {
      await a.run();
      await page.waitForTimeout(120 + Math.floor(rand() * 180));
    } catch {
      // an un-actionable element / timeout is not itself a bug; dismiss stray UI
      await page.keyboard.press('Escape').catch(() => {});
    }
    // liveness (language-independent): the top header must survive every action,
    // and the ErrorBoundary fallback must not have replaced the app.
    const crashed = await page.getByText('Something went wrong').isVisible().catch(() => false);
    const alive = await page.locator('header').first().isVisible().catch(() => false);
    if (crashed || !alive) { deadStep = i; break; }
    // UX invariant: no content should spill past a panel's right edge (the
    // recurring overflow bug class, e.g. the inspector). Checks the side panels
    // and any open dialog; a child whose right edge is >6px past its panel's is
    // a real overflow (truncating children clip within and do not trigger this).
    const spill = await page.evaluate(() => {
      const panels = [...document.querySelectorAll('aside'), ...document.querySelectorAll('[role=dialog]')] as HTMLElement[];
      for (const p of panels) {
        const pr = p.getBoundingClientRect().right;
        for (const el of Array.from(p.querySelectorAll('*')) as HTMLElement[]) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.right > pr + 6) return `${el.tagName}.${String(el.className).slice(0, 36)} +${Math.round(r.right - pr)}px :: ${(el.textContent || '').trim().slice(0, 30)}`;
        }
      }
      return '';
    }).catch(() => '');
    if (spill) { const line = `${spill} :: after [${recent()}]`; if (!overflowHits.includes(line)) overflowHits.push(line); }
  }

  // eslint-disable-next-line no-console
  console.log([
    `\n===== CHAOS REPORT (seed=${SEED}, steps=${STEPS}) =====`,
    `actions run: ${trail.length}`,
    `rate-limited (429) responses: ${rateLimited}`,
    `page (uncaught) errors: ${pageErrors.length}`,
    ...pageErrors.map((e) => `  ! ${e}`),
    `console errors: ${consoleErrors.length}`,
    ...consoleErrors.slice(0, 40).map((e) => `  - ${e}`),
    `server 5xx: ${serverErrors.length}`,
    ...serverErrors.map((e) => `  x ${e}`),
    `horizontal-overflow hits: ${overflowHits.length}`,
    ...overflowHits.slice(0, 20).map((e) => `  > ${e}`),
    deadStep >= 0 ? `DEAD: app shell vanished at step ${deadStep} after [${trail.slice(-6).join(' -> ')}]` : 'app shell survived all steps',
    `last trail: ${trail.slice(-15).join(' -> ')}`,
    '==============================================\n',
  ].join('\n'));

  expect(deadStep, 'app shell vanished (crash)').toBe(-1);
  expect(pageErrors, `uncaught exceptions:\n${pageErrors.join('\n')}`).toHaveLength(0);
  expect(serverErrors, `server 5xx:\n${serverErrors.join('\n')}`).toHaveLength(0);
  expect(consoleErrors, `console errors:\n${consoleErrors.join('\n')}`).toHaveLength(0);
  expect(overflowHits, `horizontal overflow:\n${overflowHits.join('\n')}`).toHaveLength(0);
});
