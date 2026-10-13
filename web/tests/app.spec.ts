import { test, expect } from '@playwright/test';
import { loadApp, expectNoErrors } from './helpers';

test.describe('app shell', () => {
  test('both planning days expose road geometry for every route', async ({ page }) => {
    await loadApp(page);
    const days = await page.request.get('/api/days').then((r) => r.json()) as { id: string; baselinePlanId: string }[];
    expect(days.map((d) => d.id)).toEqual(expect.arrayContaining(['day1', 'day2']));
    for (const dayId of ['day1', 'day2']) {
      const day = days.find((candidate) => candidate.id === dayId)!;
      const response = await page.request.get(`/api/plans/${day.baselinePlanId}`);
      expect(response.ok(), `${dayId} plan response`).toBeTruthy();
      const plan = await response.json() as {
        stats: { servedOrders: number; totalOrders: number };
        unassigned: unknown[];
        vehicles: { trips: { geometry: { coordinates?: unknown[] } | null }[] }[];
      };
      const expected = dayId === 'day1' ? 117 : 146;
      expect(plan.stats, `${dayId} served count`).toMatchObject({ servedOrders: expected, totalOrders: expected });
      expect(plan.unassigned, `${dayId} has no unassigned loads`).toHaveLength(0);
      const trips = plan.vehicles.flatMap((vehicle) => vehicle.trips);
      expect(trips.length, `${dayId} has routes`).toBeGreaterThan(0);
      expect(trips.filter((trip) => (trip.geometry?.coordinates?.length ?? 0) >= 2).length,
        `${dayId} every route has road geometry`).toBe(trips.length);
    }
    expectNoErrors(page);
  });

  test('loads the plan with KPIs including estimated cost', async ({ page }) => {
    await loadApp(page);
    await expect(page.getByText('Served / Total')).toBeVisible();
    await expect(page.getByText('117 / 117')).toBeVisible();
    await expect(page.getByText('Est. cost')).toBeVisible();
    await expect(page.getByText('Vehicles used')).toBeVisible();
    expectNoErrors(page);
  });

  test('day two reports all 146 loads served in the UI', async ({ page }) => {
    await loadApp(page);
    await page.getByRole('combobox').first().click();
    await page.getByRole('option', { name: /146 orders/ }).click();
    await expect(page.getByText('146 / 146')).toBeVisible();
    await page.getByRole('button', { name: /Unassigned orders/ }).click();
    await expect(page.getByText('All orders assigned.')).toBeVisible();
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
