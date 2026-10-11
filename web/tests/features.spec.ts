import { test, expect } from '@playwright/test';
import { loadApp, expectNoErrors, closePopover, selectVehicle } from './helpers';

test.describe('tier-2 features', () => {
  test('issues panel surfaces advisories and locates them', async ({ page }) => {
    await loadApp(page);
    // the day-1 baseline is fully served (no unassigned/hard), but has access
    // advisories (oversize / tail-lift), which the panel surfaces.
    await page.getByRole('button', { name: 'Issues', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Plan issues')).toBeVisible();
    await expect(dialog.getByText('Advisories')).toBeVisible();
    await expect(dialog.getByText('needs tail lift').first()).toBeVisible();
    // clicking a row locates it (dialog closes)
    await dialog.getByRole('button').filter({ hasText: 'needs tail lift' }).first().click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expectNoErrors(page);
  });

  test('help overlay auto-shows on first run and the ? button reopens it', async ({ page }) => {
    // first run: no 'otto.helpSeen' -> the overlay auto-shows and explains the layout
    await page.addInitScript(() => { try { localStorage.removeItem('otto.helpSeen'); } catch { /* ignore */ } });
    await page.goto('/');
    await expect(page.getByText('Plan controls')).toBeVisible();
    await expect(page.getByText('Inspector', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Got it' }).click();
    await expect(page.getByText('Plan controls')).toHaveCount(0);
    // reopen from the ? button
    await page.getByRole('button', { name: 'Help & tour' }).click();
    await expect(page.getByText('Plan controls')).toBeVisible();
  });

  test('scenarios workspace lists the day and compares selected', async ({ page }) => {
    await loadApp(page);
    await page.getByRole('button', { name: 'Scenarios' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('What-if scenarios')).toBeVisible();
    await expect(dialog.getByText(/served/).first()).toBeVisible();   // base KPI row
    const checks = dialog.locator('input[type=checkbox]:not([disabled])');
    if (await checks.count() >= 2) {
      await checks.nth(0).check();
      await checks.nth(1).check();
      await expect(dialog.getByText(/Compare \(2\)/)).toBeVisible();
      await expect(dialog.getByText('Vehicles')).toBeVisible();
    }
    expectNoErrors(page);
  });

  test('export menu offers driver sheets and a re-importable handoff', async ({ page }) => {
    await loadApp(page);
    await page.getByRole('button', { name: 'Export' }).click();
    await expect(page.getByText('Hand back to your system')).toBeVisible();
    await expect(page.getByText('Routes (CSV, re-importable)')).toBeVisible();
    await expect(page.getByText('Dispatch plan (JSON)')).toBeVisible();
    await closePopover(page);
    expectNoErrors(page);
  });

  test('week view shows combined totals and per-vehicle utilization', async ({ page }) => {
    await loadApp(page);
    await page.getByRole('button', { name: 'Week' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Week overview')).toBeVisible();
    await expect(dialog.getByText('262/263')).toBeVisible();   // orders across both days
    await expect(dialog.getByText('Per-vehicle utilization')).toBeVisible();
    await expect(dialog.getByText('both days').first()).toBeVisible();
    expectNoErrors(page);
  });

  test('constraint advisories: filter chip and inspector block', async ({ page }) => {
    await loadApp(page);
    await expect(page.getByText(/Has advisories/)).toBeVisible();
    // RIX-419 has access advisories
    await selectVehicle(page, 'RIX-419');
    await expect(page.locator('aside').last().getByText('Access advisories')).toBeVisible();
    expectNoErrors(page);
  });

  test('timeline playback advances the clock', async ({ page }) => {
    await loadApp(page);
    await selectVehicle(page, 'RIC-124'); // show a vehicle working day
    await page.getByRole('button', { name: 'Play' }).click();
    await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
    const seek = page.getByRole('slider', { name: 'Seek' });
    const v1 = Number(await seek.inputValue());
    await page.waitForTimeout(1500);
    const v2 = Number(await seek.inputValue());
    expect(v2).toBeGreaterThan(v1);
    expectNoErrors(page);
  });

  test('timeline is keyboard-operable: scrubber always present, fleet rows activate', async ({ page }) => {
    await loadApp(page);
    // the scrubber is available before pressing play (keyboard users can seek)
    await expect(page.getByRole('slider', { name: 'Seek' })).toBeVisible();
    // a fleet-overview row is a button; focus RIC-124 and activate it by keyboard
    const row = page.getByRole('button', { name: /^RIC-124:/ });
    await row.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText(/RIC-124 · working day/)).toBeVisible();
    expectNoErrors(page);
  });

  test('solve settings offer objective and budget', async ({ page }) => {
    await loadApp(page);
    await page.getByRole('button', { name: 'Solve settings' }).click();
    await expect(page.getByText('Fewest vehicles')).toBeVisible();
    await expect(page.getByText('Least distance')).toBeVisible();
    await expect(page.getByText('Run full budget')).toBeVisible();
    await closePopover(page);
    expectNoErrors(page);
  });
});
