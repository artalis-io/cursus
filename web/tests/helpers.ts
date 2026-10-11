import { type Page, expect } from '@playwright/test';

/** Load the app and wait until the plan is rendered (KPIs + a known vehicle). */
export async function loadApp(page: Page): Promise<void> {
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(`PAGEERROR ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  (page as unknown as { __errs: string[] }).__errs = errs;
  // Suppress the first-run help overlay (it would block interactions); the
  // dedicated help test clears this to exercise it.
  await page.addInitScript(() => { try { localStorage.setItem('otto.helpSeen', '1'); } catch { /* ignore */ } });
  await page.goto('/');
  await expect(page.getByText('Served / Total')).toBeVisible();
  await expect(page.getByText('RIC-124').first()).toBeVisible();
  await page.waitForTimeout(2500); // tiles + fitAll settle
}

/** Assert no runtime/console errors accumulated during the test. */
export function expectNoErrors(page: Page): void {
  const errs = (page as unknown as { __errs?: string[] }).__errs ?? [];
  expect(errs, `console/page errors:\n${errs.join('\n')}`).toHaveLength(0);
}

/** Select a vehicle from the fleet panel (scoped to avoid the timeline's SVG label). */
export async function selectVehicle(page: Page, ref: string): Promise<void> {
  await page.locator('aside').first().getByText(ref, { exact: true }).click();
}

/** Close any open popover (Export / Settings) by clicking its backdrop. */
export async function closePopover(page: Page): Promise<void> {
  const bd = page.locator('div.fixed.inset-0');
  if (await bd.count()) { await bd.first().click({ position: { x: 700, y: 500 } }); await page.waitForTimeout(150); }
}
