import {selectWorkspaceAction} from './workspace-navigation';
import { test, expect } from '@playwright/test';
import type { Plan } from '../src/types';

test('hard access violations cannot be labelled Baseline OK in EN or HU', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('otto.helpSeen', '1'); localStorage.setItem('otto.lang', 'en');
  });
  await page.route('**/api/plans/*', async route => {
    if (route.request().method() !== 'GET') return route.abort();
    const response = await route.fetch();
    const plan = await response.json() as Plan;
    if (!plan.vehicles?.length) return route.fulfill({ response });
    plan.source = 'saved'; plan.provenance.termination = 'OK';
    plan.provenance.validation = { valid: false, violations: [{ type: 'VEHICLE_SIZE', soft: false,
      vehicle_id: plan.vehicles[0]!.id, actual: 24, limit: 7.5 }] };
    await route.fulfill({ response, json: plan });
  });
  await page.goto('/');
  await expect(page.getByText('Baseline · Constraint violation', { exact: true })).toBeVisible();
  await expect(page.getByText('Baseline · OK', { exact: true })).toHaveCount(0);
  await selectWorkspaceAction(page,'Issues');
  await expect(page.getByRole('dialog')).toContainText('Constraint violations');
  await expect(page.getByRole('dialog').getByText(/24t.*7.5t/)).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'HU', exact: true }).click();
  await expect(page.getByText('Alapterv · Korlátsértés', { exact: true })).toBeVisible();
});
