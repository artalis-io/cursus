import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Opt-in: run only against a disposable local Gyermelyi-branded image with
// authentication required. Never requests an email or consumes a live token.
test.skip(process.env.CURSUS_TEST_GYERMELYI_BRANDING !== '1', 'requires isolated branded runtime');

test('packaged runtime serves local customer artwork without relaxing authentication', async ({ page }) => {
  const response = await page.request.get('/api/auth/workspace?tenant=other');
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ branding: { name: 'Gyermelyi', icon: '/api/auth/workspace/icon' } });
  const image = await page.request.get('/api/auth/workspace/icon');
  expect(image.headers()['content-type']).toBe('image/png');
  expect(await image.body()).toEqual(readFileSync(new URL('../../server/assets/gyermelyi.png', import.meta.url)));
  for (const path of ['/api/days', '/api/auth/me', '/api/scenarios']) expect((await page.request.get(path)).status()).toBe(401);
  const external: string[] = [];
  page.on('request', r => { if (new URL(r.url()).hostname === 'gyermelyi.hu') external.push(r.url()); });
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.getByRole('img', { name: 'Gyermelyi', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Work email' })).toBeEditable();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.goto('/api/auth/verify?token=not-a-live-token');
    await expect(page.getByRole('img', { name: 'Gyermelyi', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue to Cursus', exact: true })).toBeVisible();
    expect(await page.locator('form').getAttribute('method')).toBe('post');
  }
  expect(external).toEqual([]);
});
