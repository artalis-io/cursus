import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { magicLinkConfirmation } from '../../server/src/magic-link';

const icon = readFileSync(new URL('../../server/assets/gyermelyi.png', import.meta.url));

for (const mobile of [false, true]) {
  test(`Gyermelyi login branding loads locally and keeps sign-in usable (${mobile ? 'mobile' : 'desktop'})`, async ({ page }) => {
    if (mobile) await page.setViewportSize({ width: 375, height: 667 });
    const errors: string[] = [], external: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (new URL(r.url()).hostname === 'gyermelyi.hu') external.push(r.url()); });
    await page.route('**/api/auth/me', route => route.fulfill({ status: 401, json: { error: 'authentication required' } }));
    await page.route('**/api/auth/workspace', route => route.fulfill({ json: { branding: { name: 'Gyermelyi', icon: '/api/auth/workspace/icon' } } }));
    await page.route('**/api/auth/workspace/icon', route => route.fulfill({ contentType: 'image/png', body: icon }));
    await page.route('**/api/auth/magic-link', route => route.fulfill({ status: 202, json: { accepted: true } }));
    await page.goto('/');
    const image = page.getByRole('img', { name: 'Gyermelyi', exact: true });
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth === 512)).toBe(true);
    await expect(page.getByText('Gyermelyi workspace')).toBeVisible();
    await page.getByRole('textbox', { name: 'Work email' }).fill('user@example.test');
    await page.getByRole('button', { name: /Email me a sign-in link/ }).click();
    await expect(page.getByRole('status')).toContainText('Check your inbox');
    await expect(image).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]); expect(external).toEqual([]);
  });
}

for (const mode of ['generic', 'unavailable', 'untrusted']) {
  test(`login stays generic and usable when branding is ${mode}`, async ({ page }) => {
    await page.route('**/api/auth/me', route => route.fulfill({ status: 401, json: {} }));
    await page.route('**/api/auth/workspace', route => mode === 'unavailable'
      ? route.abort() : route.fulfill({ json: { branding: mode === 'generic' ? null : { name: 'Gyermelyi', icon: 'https://gyermelyi.hu/untrusted.png' } } }));
    await page.goto('/?auth=invalid');
    await expect(page.getByRole('heading', { name: 'Continue to Cursus' })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('invalid or expired');
    await expect(page.getByRole('img', { name: 'Gyermelyi' })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Work email' })).toBeEditable();
  });
}

test('Gyermelyi magic-link confirmation remains self-contained on mobile and desktop', async ({ page }) => {
  const external: string[] = [];
  page.on('request', r => { if (/^https?:/.test(r.url()) && new URL(r.url()).hostname === 'gyermelyi.hu') external.push(r.url()); });
  await page.route('**/api/auth/verify?*', route => route.fulfill({ contentType: 'text/html', body: magicLinkConfirmation('not-a-live-token', 'Gyermelyi') }));
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/api/auth/verify?token=not-a-live-token');
    await expect(page.getByRole('img', { name: 'Gyermelyi', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue to Cursus', exact: true })).toBeVisible();
    expect(await page.locator('form').getAttribute('method')).toBe('post');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  expect(external).toEqual([]);
});

test('Hungarian login language persists through confirmation and invalid-link recovery', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.route('**/api/auth/me', route => route.fulfill({ status: 401, json: {} }));
  await page.route('**/api/auth/workspace', route => route.fulfill({ json: { branding: { name: 'Gyermelyi', icon: '/api/auth/workspace/icon' } } }));
  await page.route('**/api/auth/workspace/icon', route => route.fulfill({ contentType: 'image/png', body: icon }));
  await page.route('**/api/auth/magic-link', route => route.fulfill({ status: 202, json: {} }));
  await page.goto('/');
  await page.getByRole('button', { name: 'HU', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tovább a Cursusba' })).toBeVisible();
  await expect(page.getByText('Gyermelyi munkatér')).toBeVisible();
  await page.getByRole('textbox', { name: 'Munkahelyi e-mail-cím' }).fill('user@example.test');
  await page.getByRole('button', { name: 'Belépési hivatkozást kérek' }).click();
  await expect(page.getByRole('status')).toContainText('Ellenőrizze a postaládáját');
  await page.goto('/?auth=invalid');
  await expect(page.getByRole('alert')).toContainText('érvénytelen vagy lejárt');
  await expect(page.locator('html')).toHaveAttribute('lang', 'hu');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.route('**/api/auth/verify?*', route => route.fulfill({ contentType: 'text/html', body: magicLinkConfirmation('test-only', 'Gyermelyi', 'hu') }));
  await page.goto('/api/auth/verify?token=test-only&lang=hu');
  await expect(page.getByRole('heading', { name: 'Belépés a Cursusba' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Tovább a Cursusba' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
