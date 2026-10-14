import { test, expect } from '@playwright/test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { loadApp, closePopover, expectNoErrors } from './helpers';

/* End-to-end loops that run real Surge/Nexus work (slow). Short solve budget via
 * the settings slider so each solve finishes quickly. */

async function setShortBudget(page: import('@playwright/test').Page, close = true): Promise<void> {
  await page.getByRole('button', { name: 'Solve settings' }).click();
  await page.getByRole('menu').locator('input[type=range]').fill('15');
  if (close) await closePopover(page);
}

test('Optimize the base day: the live plan is saved, listed in Plans, and reopenable', async ({ page }) => {
  test.setTimeout(120_000);
  await loadApp(page);
  // Keep settings open: the same click must both dismiss it and start solving.
  // The former full-screen backdrop swallowed this first Optimize click.
  await setShortBudget(page, false);

  await page.getByRole('button', { name: 'Optimize', exact: true }).click();
  await expect(page.getByText('Optimizing')).toBeVisible();
  await expect(page.getByRole('button', { name: /Optimizing [1-9]\d*s/ })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText('Optimizing')).toHaveCount(0, { timeout: 90_000 });
  // the fresh live plan reports a solve time
  await expect(page.getByText('Solve time')).toBeVisible();

  // Plans dialog lists the saved plans for the day. Simulate a transient Velo
  // miss on the first baseline fetch; reopening must refetch missing geometry.
  const days = await (await page.request.get('/api/days')).json() as { id: string; baselinePlanId: string }[];
  const baselineId = days.find((d) => d.id === 'day1')!.baselinePlanId;
  let baselineFetches = 0;
  let completeGeometrySeen = false;
  await page.route(`**/api/plans/${baselineId}`, async (route) => {
    baselineFetches++;
    const response = await route.fetch();
    const body = await response.json();
    if (baselineFetches === 1) {
      for (const vehicle of body.vehicles ?? []) for (const trip of vehicle.trips ?? []) trip.geometry = null;
    } else {
      const trips = (body.vehicles ?? []).flatMap((vehicle: { trips?: { stops?: unknown[]; geometry?: { coordinates?: unknown[] } | null }[] }) => vehicle.trips ?? []);
      completeGeometrySeen = trips.every((trip: { stops?: unknown[]; geometry?: { coordinates?: unknown[] } | null }) =>
        (trip.stops?.length ?? 0) === 0 || (trip.geometry?.coordinates?.length ?? 0) >= 2);
    }
    await route.fulfill({ response, json: body });
  });
  await page.getByRole('button', { name: 'Plans' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Saved plans')).toBeVisible();
  await dialog.locator(`[data-plan-id="${baselineId}"]`).getByRole('button').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => baselineFetches).toBeGreaterThanOrEqual(2);
  expect(completeGeometrySeen).toBe(true);
  expectNoErrors(page);
});

const RAW = process.env.DISPATCH_SAMPLE_ORDERS ?? join(homedir(), 'artalis.io/data/dataset/raw/orders_raw.csv');

test('Bring-your-own-data: upload -> admit -> solve the new day', async ({ page }) => {
  test.setTimeout(300_000);
  test.skip(!existsSync(RAW), 'raw dataset not present');
  await loadApp(page);

  // upload -> map (auto) -> reconcile -> geocode
  await page.getByRole('button', { name: 'Data' }).click();
  await page.getByRole('tab', { name: 'Upload' }).click();
  await page.locator('input[type=file]').first().setInputFiles(RAW);
  await expect(page.getByText('Map columns')).toBeVisible();
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.getByText('Reconcile passed')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Geocode addresses' }).click();
  await expect(page.getByText(/\d+\/\d+ resolved/)).toBeVisible({ timeout: 90_000 });

  // admit (background job: geocode -> matrix -> request -> register); on done the
  // dialog closes and the first new day loads
  await page.getByRole('button', { name: /^Admit/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 180_000 });

  // the admitted day loads with an empty baseline; optimize it into a real plan
  await setShortBudget(page);
  await page.getByRole('button', { name: 'Optimize', exact: true }).click();
  await expect(page.getByText('Optimizing')).toBeVisible();
  await expect(page.getByText('Optimizing')).toHaveCount(0, { timeout: 120_000 });
  await expect(page.getByText('Solve time')).toBeVisible();

  // cleanup: remove the admitted dataset so the test doesn't accumulate state
  await page.getByRole('button', { name: 'Data' }).click();
  await page.getByRole('tab', { name: 'Upload' }).click();
  const del = page.getByRole('button', { name: 'Delete' }).first();
  if (await del.count()) {
    page.once('dialog', (d) => void d.accept());
    await del.click();
  }
});
