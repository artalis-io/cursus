import { test, expect } from '@playwright/test';
import { loadApp, closePopover, selectVehicle } from './helpers';

/* Full integration: stage a removal, Replan (real Surge solve at a short budget),
 * and verify it applied + the comparison opened. Slow - runs an actual solve. */
test('replan applies a staged removal and opens the comparison', async ({ page }) => {
  test.setTimeout(120_000);
  await loadApp(page);

  // shortest solve budget for a fast test
  await page.getByRole('button', { name: 'Solve settings' }).click();
  await page.getByRole('menu').locator('input[type=range]').fill('15');
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
  const comparison = page.getByRole('dialog');
  await expect(comparison.getByText(/Plan comparison/)).toBeVisible();
  await expect(comparison.getByText('Served orders')).toBeVisible();
  await expect(comparison.getByText('Comparing…')).toHaveCount(0);
  await expect(comparison.getByText(/Not found/)).toHaveCount(0);
  await comparison.getByRole('button').first().click().catch(() => {}); // close dialog if needed
  await expect(page.locator('aside').first().getByText('RIC-124')).toHaveCount(0);
});

/* Regression: a stop edit is persisted asynchronously. Clicking the primary
 * action in the same turn must wait for that edit and solve the returned copy,
 * never the stale base scenario. */
test('immediate Optimize after a stop reorder solves the edited scenario', async ({ page }) => {
  test.setTimeout(120_000);
  await loadApp(page);
  await page.getByRole('button', { name: 'Solve settings' }).click();
  await page.getByRole('menu').locator('input[type=range]').fill('15');
  await closePopover(page);

  const picked = await page.evaluate(async () => {
    const days = await (await fetch('/api/days')).json();
    const d1 = days.find((d: { id: string }) => d.id === 'day1') ?? days[0];
    const plan = await (await fetch(`/api/plans/${d1.baselinePlanId}`)).json();
    const vehicle = plan.vehicles.find((v: { trips: { stops: unknown[] }[] }) => v.trips[0]?.stops.length >= 2);
    return { ref: vehicle.ref as string };
  });
  await selectVehicle(page, picked.ref);
  const inspector = page.locator('aside').last();
  await inspector.getByRole('button', { name: /Trip 1/ }).click();

  const editedResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST' && /\/api\/scenarios\/[^/]+\/edit$/.test(new URL(response.url()).pathname));
  const solveRequest = page.waitForRequest((request) =>
    request.method() === 'POST' && /\/api\/scenarios\/[^/]+\/solve$/.test(new URL(request.url()).pathname));
  await inspector.locator('ol li').first().locator('button[data-move$=":1"]').click();
  // Deliberately do not wait for the edit response or React rerender.
  await page.getByRole('button', { name: /^(Optimize|Replan)$/ }).click();

  const edited = await (await editedResponse).json() as { id: string };
  const solve = await solveRequest;
  expect(new URL(solve.url()).pathname).toBe(`/api/scenarios/${edited.id}/solve`);
  await expect(page.getByText('Replanning')).toHaveCount(0, { timeout: 90_000 });
  await expect(page.getByRole('dialog').getByText(/Plan comparison/)).toBeVisible();
});
