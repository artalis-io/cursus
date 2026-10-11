import { test, expect } from '@playwright/test';
import { loadApp, expectNoErrors } from './helpers';

test.describe('inspector navigation', () => {
  test('drills vehicle -> trip -> stop and back via breadcrumb', async ({ page }) => {
    await loadApp(page);
    const fleet = page.locator('aside').first();
    const inspector = page.locator('aside').last();

    // vehicle
    await fleet.getByText('RIC-124').click();
    await expect(inspector.getByText('Trips', { exact: true })).toBeVisible();

    // expand + select trip 1
    await fleet.getByRole('button', { name: 'Expand trips' }).first().click();
    await fleet.getByRole('button', { name: /^Trip 1/ }).first().click();
    await expect(inspector.getByText('Est. cost')).toBeVisible(); // enriched trip view
    await expect(inspector.getByText('Drive · wait')).toBeVisible();

    // drill into a stop
    await inspector.locator('ol button').first().click();
    await expect(inspector.getByText('Time window')).toBeVisible();
    await expect(inspector.getByText('Assignment')).toBeVisible();

    // breadcrumb back to trip
    await inspector.getByText(/trip 1 · stop/).click();
    await expect(inspector.getByText('Drive · wait')).toBeVisible();
    expectNoErrors(page);
  });

  test('back/forward buttons retrace the selection history', async ({ page }) => {
    await loadApp(page);
    const fleet = page.locator('aside').first();
    const inspector = page.locator('aside').last();
    await expect(inspector.getByRole('button', { name: 'Back' })).toBeDisabled();

    await fleet.getByText('RIC-124', { exact: true }).click();
    await fleet.getByRole('button', { name: 'Expand trips' }).first().click();
    await fleet.getByRole('button', { name: /^Trip 1/ }).first().click();
    await inspector.locator('ol button').first().click();
    await expect(inspector.getByText('Time window')).toBeVisible(); // stop

    await inspector.getByRole('button', { name: 'Back' }).click();
    await expect(inspector.getByText('Drive · wait')).toBeVisible();  // trip
    await inspector.getByRole('button', { name: 'Back' }).click();
    await expect(inspector.getByText('Trips', { exact: true })).toBeVisible(); // vehicle
    await inspector.getByRole('button', { name: 'Forward' }).click();
    await expect(inspector.getByText('Drive · wait')).toBeVisible();  // trip again
    expectNoErrors(page);
  });
});
