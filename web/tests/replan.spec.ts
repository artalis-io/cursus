import { test, expect } from '@playwright/test';
import { loadApp, closePopover, selectVehicle } from './helpers';

/* Full integration: stage a removal, Replan (real Surge solve at a short budget),
 * and verify it applied + the comparison opened. Slow - runs an actual solve. */
test('replan applies a staged removal and opens the comparison', async ({ page }) => {
  test.setTimeout(120_000);
  await loadApp(page);

  // shortest solve budget for a fast test
  await page.getByRole('button', { name: 'Solve settings' }).click();
  await page.locator('input[type=range]').first().fill('15');
  await closePopover(page);

  // stage: remove RIC-124
  await selectVehicle(page, 'RIC-124');
  await page.getByRole('button', { name: /Mark RIC-124 unavailable/ }).click();

  // replan from the Changes dialog
  await page.getByRole('button', { name: /Changes/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: /Replan/ }).click();

  // wait out the solve
  await expect(page.getByText('Replanning')).toBeVisible();
  await expect(page.getByText('Replanning')).toHaveCount(0, { timeout: 90_000 });

  // comparison opened and RIC-124 is gone from the fleet
  await expect(page.getByText(/Plan comparison/)).toBeVisible();
  await page.getByRole('dialog').getByRole('button').first().click().catch(() => {}); // close dialog if needed
  await expect(page.locator('aside').first().getByText('RIC-124')).toHaveCount(0);
});
