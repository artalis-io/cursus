import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import type { DaySummary, Plan, Scenario } from '../src/types';

const peer = process.env.CURSUS_ACCEPTANCE_PEER!;
const compose = JSON.parse(process.env.CURSUS_ACCEPTANCE_COMPOSE ?? 'null') as string[] | null;
const expectedOrders = ['PUBLIC-1', 'PUBLIC-2', 'PUBLIC-3', 'PUBLIC-5', 'PUBLIC-6', 'PUBLIC-7'];
type Job = { status: string; error?: string; planId?: string; scenarioRevision: number };

function dc(...args: string[]): string {
  if (!compose) throw Error('Use deploy/acceptance.py; never point this suite at a production endpoint');
  return execFileSync(compose[0], [...compose.slice(1), ...args], { encoding: 'utf8', timeout: 90_000 });
}
async function get<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  expect(response.status(), path).toBe(200);
  return response.json() as Promise<T>;
}
async function login(page: Page): Promise<string> {
  await page.addInitScript(() => { try { localStorage.setItem('otto.helpSeen', '1'); } catch { /* no storage on error documents */ } });
  await page.goto('/');
  await expect(page.getByRole('contentinfo', { name: 'Account and build' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Continue to Cursus' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Work email' }).fill('admin@acceptance.example.test');
  await page.getByRole('button', { name: /Email me a sign-in link/ }).click();
  await expect(page.getByRole('status')).toContainText('Check your inbox');
  // Delivery is disabled. Read the actual test-only outbox instead of mocking
  // authentication or sending a message. GET and form POST follow production.
  const { link } = JSON.parse(dc('run', '--rm', '-T', 'fixture', 'link').trim().split('\n').at(-1)!) as { link: string };
  await page.goto(link);
  await expect(page.getByRole('banner', { name: 'Cursus' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sign in to Cursus' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue to Cursus', exact: true })).toHaveCSS('background-color', 'rgb(45, 123, 85)');
  expect((await page.request.get('/api/auth/me')).status()).toBe(401);
  await page.getByRole('button', { name: 'Continue to Cursus', exact: true }).click();
  await expect(page.getByText('Served / Total')).toBeVisible();
  return link;
}
async function baseline(page: Page): Promise<Plan> {
  const days = await get<DaySummary[]>(page.request, '/api/days');
  expect(days).toHaveLength(2);
  const day = days.find(d => d.id === 'acceptance-day')!;
  return get<Plan>(page.request, `/api/plans/${day.baselinePlanId}`);
}
function assertPlan(plan: Plan): void {
  const assigned = plan.vehicles.flatMap(v => v.trips.flatMap(t => t.stops.map(s => s.orderNo)));
  const all = [...assigned, ...plan.unassigned.map(s => s.orderNo)];
  expect(all.sort()).toEqual([...expectedOrders].sort());
  expect(new Set(all).size).toBe(all.length);
  expect(plan.stats.servedOrders).toBe(assigned.length);
  expect(plan.stats.servedOrders).toBe(6); // known feasible public fixture; quality gate
  expect(plan.stats.totalOrders).toBe(6);
  expect(plan.unassigned).toHaveLength(0);
  expect(plan.provenance.validation.valid).toBe(true);
  expect(plan.provenance.validation.violations).toEqual([]);
  expect(Number.isFinite(plan.stats.totalDistanceKm)).toBe(true);
  expect(plan.stats.totalDistanceKm).toBeGreaterThan(0);
  for (const vehicle of plan.vehicles) {
    expect(vehicle.ref).toBe(`ACCEPT-${vehicle.id}`);
    for (const trip of vehicle.trips) {
      expect(trip.loadKg).toBeLessThanOrEqual(vehicle.capacityKg);
      expect(trip.stops.every(s => s.lateBySec === 0)).toBe(true);
    }
  }
  expect(plan.cost?.source).toBe('demo');
  expect(plan.cost?.total).toBeCloseTo((plan.cost?.fixed ?? 0) + (plan.cost?.variable ?? 0), 5);
}
async function shortBudget(page: Page) {
  await page.getByRole('button', { name: 'Solve settings' }).click();
  await page.getByRole('menu').locator('input[type=range]').fill('15');
  await page.keyboard.press('Escape');
}
async function finishSolve(page: Page, start: () => Promise<unknown>): Promise<Plan> {
  const submitted = page.waitForResponse(response => response.request().method() === 'POST' && /\/api\/scenarios\/[^/]+\/solve$/.test(new URL(response.url()).pathname));
  await start();
  const submission = await submitted;
  expect(submission.status()).toBe(202);
  const { jobId, scenarioId, scenarioRevision } = await submission.json() as { jobId: string; scenarioId: string; scenarioRevision: number };
  let job: Job;
  await expect.poll(async () => {
    job = await get<Job>(page.request, `${peer}/api/jobs/${jobId}`);
    if (job.status === 'failed') throw Error(`Native solve failed: ${job.error}`);
    return job.status;
  }, { timeout: 60_000, message: 'real native solver job must complete through the peer replica' }).toBe('completed');
  expect(job!.scenarioRevision).toBe(scenarioRevision);
  const plan = await get<Plan>(page.request, `${peer}/api/plans/${job!.planId}`);
  expect(plan.scenarioId).toBe(scenarioId);
  expect(plan.scenarioRevision).toBe(scenarioRevision);
  assertPlan(plan);
  // Wait for actual UI completion, including the comparison fetch.
  await expect(page.getByRole('dialog').getByText(/Plan comparison/)).toBeVisible();
  await expect(page.getByRole('dialog').getByText('Comparing…')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const handoff = await get<{ summary: { servedOrders: number; totalOrders: number; cost: { total: number } }; routes: { stops: { orderNo: string }[] }[] }>(page.request, `${peer}/api/plans/${plan.id}/handoff.json`);
  expect(handoff.summary.servedOrders).toBe(plan.stats.servedOrders);
  expect(handoff.summary.totalOrders).toBe(plan.stats.totalOrders);
  expect(handoff.summary.cost.total).toBe(Math.round(plan.cost!.total));
  expect(handoff.routes.flatMap(r => r.stops.map(s => s.orderNo)).sort()).toEqual([...expectedOrders].sort());
  const comparison = await get<{ deltas: { servedOrders: number; costTotal: number } }>(page.request,
    `/api/compare?base=${(await baseline(page)).id}&revised=${plan.id}`);
  expect(comparison.deltas.servedOrders).toBe(0);
  expect(Number.isFinite(comparison.deltas.costTotal)).toBe(true);
  return plan;
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  (page as Page & { runtimeErrors: string[] }).runtimeErrors = errors;
});
test.afterEach(async ({ page }) => {
  expect((page as Page & { runtimeErrors: string[] }).runtimeErrors).toEqual([]);
});

test('real authentication, shared sessions, origin checks, and tenant isolation', async ({ page }) => {
  for (const origin of ['', peer]) {
    expect((await page.request.get(`${origin}/api/days`)).status()).toBe(401);
    expect((await page.request.get(`${origin}/health/ready`)).status()).toBe(200);
  }
  const usedLink = await login(page);
  // Reopening an already-used emailed link must never create another session.
  const mobile = await page.context().browser()!.newContext({ viewport: { width: 375, height: 667 } });
  try {
    const confirmation = await mobile.newPage();
    await confirmation.goto(usedLink);
    await expect(confirmation.getByRole('heading', { name: 'Sign in to Cursus' })).toBeVisible();
    expect(await confirmation.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await confirmation.keyboard.press('Tab');
    await expect(confirmation.getByRole('button', { name: 'Continue to Cursus', exact: true })).toBeFocused();
    await confirmation.keyboard.press('Enter');
    await expect(confirmation.getByRole('alert')).toContainText('Link unavailable');
    expect((await confirmation.request.get('/api/auth/me')).status()).toBe(401);
    await confirmation.getByRole('textbox', { name: 'Work email' }).fill('admin@acceptance.example.test');
    await confirmation.getByRole('button', { name: /Email me a sign-in link/ }).click();
    await expect(confirmation.getByRole('status')).toContainText('Check your inbox');
    const { link } = JSON.parse(dc('run', '--rm', '-T', 'fixture', 'expire-link').trim().split('\n').at(-1)!) as { link: string };
    await confirmation.goto(link);
    await confirmation.getByRole('button', { name: 'Continue to Cursus', exact: true }).click();
    await expect(confirmation.getByRole('alert')).toContainText('Link unavailable');
    expect((await confirmation.request.get('/api/auth/me')).status()).toBe(401);
  } finally { await mobile.close(); }
  expect((await get<{ tenantId: string }>(page.request, `${peer}/api/auth/me`)).tenantId).toBe('acceptance');
  for (const path of ['/api/plans/foreign-plan', '/api/plans/foreign-plan/handoff.json', '/api/scenarios/foreign-scenario'])
    expect((await page.request.get(`${peer}${path}`)).status()).toBe(404);
  const blocked = await page.request.post('/api/scenarios', { headers: { origin: 'https://untrusted.example.test' }, data: { day: 'acceptance-day' } });
  expect(blocked.status()).toBe(403);
  assertPlan(await baseline(page));
});

test('account bar shows image provenance, fits desktop and mobile, and revokes the shared session on sign out', async ({ page }) => {
  await login(page);
  const me = await get<{ email: string; role: string; build: { version: string; revision: string } }>(page.request, '/api/auth/me');
  expect((await page.request.get('/api/auth/me')).headers()['cache-control']).toBe('private, no-store');
  expect(me.build.revision).toBe(process.env.CURSUS_ACCEPTANCE_REVISION);
  expect(me.build.revision).toMatch(/^[a-f0-9]{40}$/i);
  expect((await get<typeof me>(page.request, `${peer}/api/auth/me`)).build).toEqual(me.build);
  const bar = page.getByRole('contentinfo', { name: 'Account and build' });
  await expect(bar.getByText(me.email, { exact: true })).toBeVisible();
  await expect(bar.getByText('AD', { exact: true })).toBeVisible();
  await expect(bar.getByText('Admin', { exact: true })).toBeVisible();
  await expect(bar.getByLabel('Application build')).toHaveAttribute('title', `${me.build.version} · ${me.build.revision}`);
  await expect(bar.getByText(`v${me.build.version}`, { exact: true })).toBeVisible();
  await expect(bar.getByText(me.build.revision.slice(0, 7), { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('account-desktop.png') });
  for (const width of [1440, 375, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 667 });
    await expect(bar).toBeInViewport();
    await expect(bar.getByRole('button', { name: 'Sign out', exact: true })).toBeInViewport();
    expect(await bar.evaluate(el => {
      const footer = el.getBoundingClientRect();
      const workspace = document.querySelector('[data-testid="workspace-content"]')!.getBoundingClientRect();
      return el.scrollWidth <= el.clientWidth && footer.left >= 0 && footer.right <= innerWidth
        && footer.bottom <= innerHeight && workspace.bottom <= footer.top;
    })).toBe(true);
    if (width === 375) await page.screenshot({ path: test.info().outputPath('account-mobile.png') });
  }
  await expect(bar.getByText(me.email, { exact: true })).toHaveAttribute('title', me.email);
  expect(await bar.getByText(me.email, { exact: true }).evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('group', { name: 'Language', exact: true }).getByRole('button', { name: 'HU', exact: true }).click();
  await expect(page.getByRole('contentinfo', { name: 'Fiók és verzió' }).getByRole('button', { name: 'Kijelentkezés', exact: true })).toBeVisible();
  await page.getByRole('group', { name: 'Nyelv', exact: true }).getByRole('button', { name: 'EN', exact: true }).click();
  // A transient failure must not pretend to have signed the user out.
  await page.route('**/api/auth/logout', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }), { times: 1 });
  await bar.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(bar.getByRole('alert')).toContainText('Could not sign out');
  expect((await page.request.get(`${peer}/api/auth/me`)).status()).toBe(200);
  // The retry is real: shared PostgreSQL session revocation, no API mock.
  await bar.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Continue to Cursus' })).toBeVisible();
  await expect(bar).toHaveCount(0);
  for (const origin of ['', peer]) {
    expect((await page.request.get(`${origin}/api/auth/me`)).status()).toBe(401);
    expect((await page.request.get(`${origin}/api/days`)).status()).toBe(401);
  }
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Continue to Cursus' })).toBeVisible();
});

test('reorder requires recomputed preview and a correct native replan with peer export', async ({ page }) => {
  await login(page); await shortBudget(page);
  const base = await baseline(page);
  const vehicle = base.vehicles.find(v => v.trips[0]?.stops.length >= 2)!;
  await page.locator('aside').first().getByText(vehicle.ref, { exact: true }).click();
  const inspector = page.locator('aside').last();
  await inspector.getByRole('button', { name: /Trip 1/ }).click();
  const evaluated = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/evaluate'));
  await inspector.locator('ol li').first().locator('button[data-move$=":1"]').click();
  expect((await evaluated).status()).toBe(200);
  await expect(inspector.getByText('Preview of this order (recomputed). Apply it with Replan.')).toBeVisible();
  const plan = await finishSolve(page, () => page.getByRole('button', { name: 'Replan', exact: true }).click());
  const stops = plan.vehicles.find(v => v.id === vehicle.id)!.trips.flatMap(t => t.stops.map(s => s.orderNo));
  const original = vehicle.trips[0]!.stops.map(s => s.orderNo);
  expect(stops).toEqual([original[1], original[0], ...original.slice(2)]);
});

test('excluding a vehicle preserves service and stable identities through the real worker', async ({ page }) => {
  await login(page); await shortBudget(page);
  const vehicle = (await baseline(page)).vehicles[0]!;
  await page.locator('aside').first().getByText(vehicle.ref, { exact: true }).click();
  await page.getByRole('button', { name: `Mark ${vehicle.ref} unavailable` }).click();
  const plan = await finishSolve(page, () => page.getByRole('button', { name: 'Replan', exact: true }).click());
  expect(plan.vehicles.some(v => v.id === vehicle.id || v.ref === vehicle.ref)).toBe(false);
});

test('locking a route preserves its vehicle and exact stop order', async ({ page }) => {
  await login(page); await shortBudget(page);
  const vehicle = (await baseline(page)).vehicles[0]!;
  const original = vehicle.trips.flatMap(t => t.stops.map(s => s.orderNo));
  await page.locator('aside').first().getByText(vehicle.ref, { exact: true }).click();
  await page.getByRole('button', { name: 'Lock route', exact: true }).click();
  const plan = await finishSolve(page, () => page.getByRole('button', { name: 'Replan', exact: true }).click());
  expect(plan.vehicles.find(v => v.id === vehicle.id)!.trips.flatMap(t => t.stops.map(s => s.orderNo))).toEqual(original);
});

test('an immediate Replan waits for a delayed real edit response', async ({ page }) => {
  await login(page); await shortBudget(page);
  const vehicle = (await baseline(page)).vehicles[0]!;
  await page.locator('aside').first().getByText(vehicle.ref, { exact: true }).click();
  const inspector = page.locator('aside').last();
  await inspector.getByRole('button', { name: /Trip 1/ }).click();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let captured!: () => void;
  const intercepted = new Promise<void>(resolve => { captured = resolve; });
  await page.route('**/api/scenarios/*/edit', async route => { captured(); await held; await route.continue(); });
  const edited = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/edit'));
  await inspector.locator('ol li').first().locator('button[data-move$=":1"]').click();
  await intercepted;
  const solving = finishSolve(page, async () => {
    await page.getByRole('button', { name: /^(Optimize|Replan)$/ }).click();
    release();
  });
  const scenario = await (await edited).json() as Scenario;
  const plan = await solving;
  expect(plan.scenarioId).toBe(scenario.id);
  expect(plan.scenarioRevision).toBe(scenario.revision);
});

test('restart retains authentication, plans, and exports while the peer stays ready', async ({ page }) => {
  await login(page);
  const original = await baseline(page);
  dc('restart', '--timeout', '40', 'app-a');
  await expect.poll(async () => {
    try { return (await page.request.get('/health/ready')).status(); }
    catch { return 0; } // connection resets are expected while the process restarts
  }).toBe(200);
  expect((await page.request.get(`${peer}/health/ready`)).status()).toBe(200);
  const restored = await get<Plan>(page.request, `/api/plans/${original.id}`);
  expect(restored).toEqual(original);
  expect((await get<{ tenantId: string }>(page.request, '/api/auth/me')).tenantId).toBe('acceptance');
  const exportA = await get(page.request, `/api/plans/${original.id}/handoff.json`);
  const exportB = await get(page.request, `${peer}/api/plans/${original.id}/handoff.json`);
  expect(exportA).toEqual(exportB);
  await page.reload();
  await expect(page.getByText('Served / Total')).toBeVisible();
});

test('history, week, provenance, and upload render with real stateful responses', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Plans', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('Saved plans')).toBeVisible();
  await expect(page.getByRole('dialog').locator('[data-plan-id]').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Week', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('Week overview')).toBeVisible();
  await expect(page.getByRole('dialog').getByText(/Not found/)).toHaveCount(0);
  await page.keyboard.press('Escape');
  const summary = await get<{ sources: { sha256: string }[] }>(page.request, '/api/import/summary');
  await page.getByRole('button', { name: 'Data', exact: true }).click();
  const checksum = page.getByText(new RegExp(`sha ${summary.sources[0]!.sha256}`));
  await expect(checksum).toBeVisible();
  // Read both boxes in one frame; separate browser round trips can straddle
  // the dialog's entrance animation and compare different coordinate systems.
  const bounds = await checksum.evaluate(el => ({ text: el.getBoundingClientRect().right,
    card: el.parentElement!.getBoundingClientRect().right }));
  expect(bounds.text).toBeLessThanOrEqual(bounds.card + 1);
  await page.getByRole('tab', { name: 'Upload' }).click();
  await page.locator('input[type=file]').first().setInputFiles({ name: 'public-orders.csv', mimeType: 'text/csv',
    buffer: Buffer.from('order_no,customer,city,delivery_date,address\nPUBLIC-UPLOAD,Public fixture,Budapest,2026-05-06,Test utca 1\n') });
  await expect(page.getByText('Map columns')).toBeVisible();
  await expect(page.getByText('1 rows')).toBeVisible();
  expect(await page.locator('table select').count()).toBeGreaterThan(0);
  // An uploaded but unvalidated source must not become a solver dataset.
  expect(await get<unknown[]>(page.request, `${peer}/api/import/datasets`)).toHaveLength(1);
});
