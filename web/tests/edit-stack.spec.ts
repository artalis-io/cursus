import { test, expect } from '@playwright/test';
import { loadApp, expectNoErrors, selectVehicle } from './helpers';

test.describe('staged edit stack', () => {
  test('mark-unavailable stacks (no auto-solve) and the Changes dialog lists + undoes it', async ({ page }) => {
    await loadApp(page);
    await selectVehicle(page, 'RIC-124');
    await page.getByRole('button', { name: /Mark RIC-124 unavailable/ }).click();

    // it must NOT have started a solve
    await expect(page.getByText('Optimizing')).toHaveCount(0);
    // staged indicators
    await expect(page.getByText(/staged change\(s\)/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Changes/ })).toBeVisible();

    // open the Changes dialog -> RIC-124 under Removed vehicles
    await page.getByRole('button', { name: /Changes/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Removed vehicles')).toBeVisible();
    await expect(dialog.getByText('RIC-124')).toBeVisible();

    // undo it
    await dialog.getByRole('button', { name: 'Undo' }).first().click();
    await expect(dialog.getByText('No staged changes.')).toBeVisible();
    expectNoErrors(page);
  });

  test('drag-to-reassign stages a pin onto the drop-target vehicle', async ({ page }) => {
    await loadApp(page);
    // Pick a real order + a different target vehicle from the loaded plan, then
    // dispatch a native drop onto the target card (HTML5 DnD, deterministic).
    const picked = await page.evaluate(async () => {
      const days = await (await fetch('/api/days')).json();
      const d1 = days.find((d: { id: string }) => d.id === 'day1') ?? days[0];
      const plan = await (await fetch(`/api/plans/${d1.baselinePlanId}`)).json();
      const v0 = plan.vehicles[0], v1 = plan.vehicles[1];
      return { order: v0.trips[0].stops[0].orderNo as string, target: v1.ref as string };
    });
    const dropped = await page.evaluate(({ order, target, MIME }) => {
      const fleet = document.querySelectorAll('aside')[0];
      const refSpan = [...fleet!.querySelectorAll('span')].find((s) => s.textContent?.trim() === target);
      const card = refSpan?.closest('div.rounded-md');
      if (!card) return false;
      const dt = new DataTransfer();
      dt.setData(MIME, order);
      card.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      card.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return true;
    }, { ...picked, MIME: 'application/x-otto-order' });
    expect(dropped).toBe(true);

    // A toast confirms the staged edit (feedback for the tune loop).
    await expect(page.getByText(/Pinned #.*applies on Replan/)).toBeVisible();
    // The pin must stage (not auto-solve) and show the target vehicle.
    await expect(page.getByText('Optimizing')).toHaveCount(0);
    await expect(page.getByText(/staged change\(s\)/)).toBeVisible();
    await page.getByRole('button', { name: /Changes/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(picked.target)).toBeVisible();
    expectNoErrors(page);
  });

  test('real HTML5 drag reassigns a stop to another vehicle', async ({ page }) => {
    await loadApp(page);
    await selectVehicle(page, 'RIC-124');
    await page.locator('aside').last().getByRole('button', { name: /Trip 1/ }).click();
    const stop = page.locator('aside').last().locator('ol li button[draggable="true"]').first();
    await expect(stop).toBeVisible();
    const target = page.locator('aside').first().getByText('RIX-419', { exact: true });
    await stop.dragTo(target); // real HTML5 DnD (dragstart/dragover/drop), not a synthetic event
    await expect(page.getByText(/Pinned #.*applies on Replan/)).toBeVisible();
    await expect(page.getByText(/staged change\(s\)/)).toBeVisible();
    expectNoErrors(page);
  });

  test('drag-to-reorder within a trip stages a stop-order change', async ({ page }) => {
    await loadApp(page);
    const picked = await page.evaluate(async () => {
      const days = await (await fetch('/api/days')).json();
      const d1 = days.find((d: { id: string }) => d.id === 'day1') ?? days[0];
      const plan = await (await fetch(`/api/plans/${d1.baselinePlanId}`)).json();
      const v = plan.vehicles.find((x: { trips: { stops: unknown[] }[] }) => x.trips[0] && x.trips[0].stops.length >= 2);
      return { ref: v.ref as string, orders: v.trips[0].stops.map((s: { orderNo: string }) => s.orderNo) as string[] };
    });
    await selectVehicle(page, picked.ref);
    await page.locator('aside').last().getByRole('button', { name: /Trip 1/ }).click();
    // reorder: drop the 2nd stop onto the 1st (move it to the front)
    const reordered = await page.evaluate((order1) => {
      const li = document.querySelectorAll('aside')[1]!.querySelectorAll('ol li')[0] as HTMLElement | undefined;
      if (!li) return false;
      const dt = new DataTransfer();
      dt.setData('application/x-otto-order', order1);
      li.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      li.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return true;
    }, picked.orders[1]);
    expect(reordered).toBe(true);

    await expect(page.getByText('Optimizing')).toHaveCount(0);
    await expect(page.getByText(/staged change\(s\)/)).toBeVisible();
    // the reorder is reflected in the list immediately + a hint shows: first the
    // "Reordered" pending note, then (once the backend recomputes) a "Preview".
    await expect(page.locator('aside').last().getByText(/Reordered|Preview/)).toBeVisible();
    const firstStop = page.locator('aside').last().locator('ol li').first();
    await expect(firstStop).toContainText(/^1\./); // renumbered to the new position
    await page.getByRole('button', { name: /Changes/ }).click();
    await expect(page.getByRole('dialog').getByText('Stop order')).toBeVisible();
    expectNoErrors(page);
  });

  test('keyboard reorder: the move-down arrow restages the stop order (no mouse)', async ({ page }) => {
    await loadApp(page);
    const picked = await page.evaluate(async () => {
      const days = await (await fetch('/api/days')).json();
      const d1 = days.find((d: { id: string }) => d.id === 'day1') ?? days[0];
      const plan = await (await fetch(`/api/plans/${d1.baselinePlanId}`)).json();
      const v = plan.vehicles.find((x: { trips: { stops: unknown[] }[] }) => x.trips[0] && x.trips[0].stops.length >= 2);
      return { ref: v.ref as string };
    });
    await selectVehicle(page, picked.ref);
    const inspector = page.locator('aside').last();
    await inspector.getByRole('button', { name: /Trip 1/ }).click();
    // activate the first stop's "move later" arrow via the keyboard
    const moveDown = inspector.locator('ol li').first().locator('button[data-move$=":1"]');
    await moveDown.focus();
    await page.keyboard.press('Enter');
    // the reorder stages (no auto-solve) and shows in the Changes dialog
    await expect(page.getByText('Optimizing')).toHaveCount(0);
    await expect(page.getByText(/staged change\(s\)/)).toBeVisible();
    await expect(inspector.getByText(/Reordered|Preview/)).toBeVisible();
    await page.getByRole('button', { name: /Changes/ }).click();
    await expect(page.getByRole('dialog').getByText('Stop order')).toBeVisible();
    expectNoErrors(page);
  });

  test('staging a reorder previews the new distance/cost in the top KPIs', async ({ page }) => {
    await loadApp(page);
    // a longer trip, so moving a stop several places is not a symmetric no-op
    const picked = await page.evaluate(async () => {
      const days = await (await fetch('/api/days')).json();
      const d1 = days.find((d: { id: string }) => d.id === 'day1') ?? days[0];
      const plan = await (await fetch(`/api/plans/${d1.baselinePlanId}`)).json();
      const v = plan.vehicles.find((x: { trips: { stops: unknown[] }[] }) => x.trips[0] && x.trips[0].stops.length >= 6);
      return { ref: v.ref as string };
    });
    await selectVehicle(page, picked.ref);
    const inspector = page.locator('aside').last();
    await inspector.getByRole('button', { name: /Trip 1/ }).click();
    // focus the first stop's move-down arrow and press it several times; focus
    // follows the moved stop, so it marches down the route (a real distance change).
    const down = inspector.locator('ol li').first().locator('button[data-move$=":1"]');
    await down.focus();
    for (let i = 0; i < 4; i++) await page.keyboard.press('Enter');
    // the top KPI strip reflects the staged reorder as a preview (not only on Replan)
    await expect(page.getByText(/preview · Replan to apply/).first()).toBeVisible();
    expectNoErrors(page);
  });

  test('staging a reorder draws a ghost on the map (legend appears)', async ({ page }) => {
    await loadApp(page);
    const picked = await page.evaluate(async () => {
      const days = await (await fetch('/api/days')).json();
      const d1 = days.find((d: { id: string }) => d.id === 'day1') ?? days[0];
      const plan = await (await fetch(`/api/plans/${d1.baselinePlanId}`)).json();
      const v = plan.vehicles.find((x: { trips: { stops: unknown[] }[] }) => x.trips[0] && x.trips[0].stops.length >= 2);
      return { ref: v.ref as string };
    });
    await selectVehicle(page, picked.ref);
    const inspector = page.locator('aside').last();
    await inspector.getByRole('button', { name: /Trip 1/ }).click();
    await inspector.locator('ol li').first().locator('button[data-move$=":1"]').click();
    // the map shows the staged change as a ghost; its legend chip is plain DOM
    await expect(page.getByText(/Dashed = staged change/)).toBeVisible();
    expectNoErrors(page);
  });

  test('lock-and-resolve: locking a vehicle route stages a sequence', async ({ page }) => {
    await loadApp(page);
    await selectVehicle(page, 'RIC-124');
    const inspector = page.locator('aside').last();
    await inspector.getByRole('button', { name: 'Lock route' }).click();
    await expect(inspector.getByRole('button', { name: /Route locked/ })).toBeVisible();
    await expect(page.getByText(/staged change\(s\)/)).toBeVisible();
    await page.getByRole('button', { name: /Changes/ }).click();
    await expect(page.getByRole('dialog').getByText('Stop order')).toBeVisible();
    expectNoErrors(page);
  });

  test('vehicle constraint edit stacks', async ({ page }) => {
    await loadApp(page);
    await selectVehicle(page, 'RIX-419');
    await page.getByRole('button', { name: /Edit constraints/ }).click();
    const capKg = page.locator('input[type=number]').first();
    await capKg.fill('9000');
    await capKg.blur();
    await expect(page.getByRole('button', { name: /Changes/ })).toBeVisible();
    await page.getByRole('button', { name: /Changes/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Vehicle constraints')).toBeVisible();
    await expect(dialog.getByText(/9000/)).toBeVisible();
    expectNoErrors(page);
  });
});
