import { test, expect } from '@playwright/test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { loadApp, closePopover, expectNoErrors } from './helpers';

/* End-to-end loops that run real Surge/Nexus work (slow). Short solve budget via
 * the settings slider so each solve finishes quickly. */

async function setShortBudget(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: 'Solve settings' }).click();
  await page.locator('input[type=range]').first().fill('15');
  await closePopover(page);
}

test('Optimize the base day: the live plan is saved, listed in Plans, and reopenable', async ({ page }) => {
  test.setTimeout(120_000);
  await loadApp(page);
  await setShortBudget(page);

  await page.getByRole('button', { name: 'Optimize', exact: true }).click();
  await expect(page.getByText('Optimizing')).toBeVisible();
  await expect(page.getByText('Optimizing')).toHaveCount(0, { timeout: 90_000 });
  // the fresh live plan reports a solve time
  await expect(page.getByText('Solve time')).toBeVisible();

  // Plans dialog lists the saved plans for the day; reopen one
  await page.getByRole('button', { name: 'Plans' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Saved plans')).toBeVisible();
  await dialog.getByRole('button', { name: /Reopen|Open/ }).first().click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
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
