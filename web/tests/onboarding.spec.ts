import { test, expect } from '@playwright/test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { loadApp, expectNoErrors } from './helpers';

const RAW = process.env.DISPATCH_SAMPLE_ORDERS ?? join(homedir(), 'artalis.io/data/dataset/raw/orders_raw.csv');
const VEH = process.env.DISPATCH_SAMPLE_VEHICLES ?? join(homedir(), 'artalis.io/data/dataset/raw/vehicles_raw.csv');

test('onboarding shows a progress stepper (upload -> admit)', async ({ page }) => {
  await loadApp(page);
  await page.getByRole('button', { name: 'Data' }).click();
  await page.getByRole('tab', { name: 'Upload' }).click();
  const steps = page.getByRole('navigation', { name: 'Onboarding progress' });
  await expect(steps).toBeVisible();
  await expect(steps.getByText('Geocode')).toBeVisible();
  await expect(steps.getByText('Admit')).toBeVisible();
  // the first step is "current" until a file is uploaded
  await expect(steps.locator('[aria-current="step"]')).toContainText('Upload');
  expectNoErrors(page);
});

test.describe('data onboarding (M1)', () => {
  test.skip(!existsSync(RAW), 'raw dataset not present');

  test('upload a CSV, auto-map columns, pass the reconcile gate', async ({ page }) => {
    test.setTimeout(90_000);
    await loadApp(page);
    await page.getByRole('button', { name: 'Data' }).click();
    await page.getByRole('tab', { name: 'Upload' }).click();
    await expect(page.getByText('Choose file')).toBeVisible();

    await page.locator('input[type=file]').setInputFiles(RAW);
    await expect(page.getByText('Map columns')).toBeVisible();
    await expect(page.getByText(/\d+ rows/).first()).toBeVisible();

    // auto-suggest should have mapped the required fields (order_no, customer, city)
    const mapped = await page.locator('table select').evaluateAll((els) => els.filter((e) => (e as HTMLSelectElement).value !== '').length);
    expect(mapped).toBeGreaterThanOrEqual(3);

    await page.getByRole('button', { name: 'Validate' }).click();
    await expect(page.getByText('Reconcile passed')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/Canonical records/)).toBeVisible();
    expectNoErrors(page);
  });

  test('geocode the mapped orders and preview tiers on a map', async ({ page }) => {
    test.setTimeout(120_000);
    await loadApp(page);
    await page.getByRole('button', { name: 'Data' }).click();
    await page.getByRole('tab', { name: 'Upload' }).click();
    await page.locator('input[type=file]').setInputFiles(RAW);
    await expect(page.getByText('Map columns')).toBeVisible();
    await page.getByRole('button', { name: 'Validate' }).click();
    await expect(page.getByText('Reconcile passed')).toBeVisible({ timeout: 60_000 });

    await page.getByRole('button', { name: 'Geocode addresses' }).click();
    await expect(page.getByText(/\d+\/\d+ resolved/)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('dialog').locator('canvas.maplibregl-canvas')).toBeVisible();
    expectNoErrors(page);
  });

  test('offer an optional custom fleet after geocoding', async ({ page }) => {
    test.setTimeout(120_000);
    test.skip(!existsSync(VEH), 'vehicles file not present');
    await loadApp(page);
    await page.getByRole('button', { name: 'Data' }).click();
    await page.getByRole('tab', { name: 'Upload' }).click();
    await page.locator('input[type=file]').setInputFiles(RAW);
    await expect(page.getByText('Map columns')).toBeVisible();
    await page.getByRole('button', { name: 'Validate' }).click();
    await expect(page.getByText('Reconcile passed')).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Geocode addresses' }).click();
    await expect(page.getByText(/\d+\/\d+ resolved/)).toBeVisible({ timeout: 60_000 });

    // the admit box offers an optional custom fleet; uploading a vehicles file
    // reveals its id + capacity mapping (auto-suggested).
    await expect(page.getByText('Custom fleet (optional)')).toBeVisible();
    await page.locator('input[type=file]').last().setInputFiles(VEH);
    await expect(page.getByText('Vehicle id')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Capacity (kg)')).toBeVisible();
    expectNoErrors(page);
  });
});
