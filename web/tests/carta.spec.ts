import { test, expect } from '@playwright/test';
import { loadApp, expectNoErrors } from './helpers';

test('Carta serves and renders the affected Hungary low-zoom tile', async ({ page }) => {
  const response = await page.request.get('/tiles/5/17/11.pbf');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('application/vnd.mapbox-vector-tile');
  expect((await response.body()).length).toBeGreaterThan(200_000);

  await loadApp(page);
  const canvas = page.locator('canvas.maplibregl-canvas');
  await expect(canvas).toBeVisible();
  await expect.poll(async () => canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    return c.width > 0 && c.height > 0;
  })).toBeTruthy();
  expectNoErrors(page);
});
