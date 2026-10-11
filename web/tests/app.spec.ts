import { test, expect } from '@playwright/test';
import { loadApp, expectNoErrors } from './helpers';

test.describe('app shell', () => {
  test('loads the plan with KPIs including estimated cost', async ({ page }) => {
    await loadApp(page);
    await expect(page.getByText('Served / Total')).toBeVisible();
    await expect(page.getByText('117 / 117')).toBeVisible();
    await expect(page.getByText('Est. cost')).toBeVisible();
    await expect(page.getByText('Vehicles used')).toBeVisible();
    expectNoErrors(page);
  });

  test('switches language EN -> HU', async ({ page }) => {
    await loadApp(page);
    await page.getByRole('button', { name: 'HU', exact: true }).click();
    await expect(page.getByText('Kiszolgált / Összes')).toBeVisible(); // "Served / Total" in Hungarian
    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await expect(page.getByText('Served / Total')).toBeVisible();
    expectNoErrors(page);
  });

  test('export menu offers route sheets, CSV and JSON', async ({ page }) => {
    await loadApp(page);
    await page.getByRole('button', { name: /Export/ }).click();
    await expect(page.getByText('Driver route sheets')).toBeVisible();
    await expect(page.getByText('Stops (CSV)')).toBeVisible();
    await expect(page.getByText('Plan (JSON)')).toBeVisible();
  });
});
