import { test, expect } from '@playwright/test';

test('authentication gate initializes and protected APIs reject anonymous access', async ({ page }) => {
  const protectedResponse = await page.request.get('/api/days');
  expect(protectedResponse.status()).toBe(401);

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Continue to Cursus' })).toBeVisible();
  await expect(page.getByText(/Sign in with an approved email address/)).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Work email' })).toBeVisible();
  await expect(page.getByText('Secure workspace')).toBeVisible();
});

test('magic-link request confirmation stays within the login experience', async ({ page }) => {
  await page.route('**/api/auth/magic-link', (route) => route.fulfill({ status: 202, contentType: 'application/json', body: '{}' }));
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Work email' }).fill('approved@example.test');
  await page.getByRole('button', { name: /Email me a sign-in link/ }).click();
  await expect(page.getByRole('status')).toContainText('Check your inbox');
  await expect(page.getByRole('button', { name: 'Use another email' })).toBeVisible();
});

test('invalid-link recovery remains usable at a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto('/?auth=invalid');
  await expect(page.getByRole('alert')).toContainText('invalid or expired');
  await expect(page.getByRole('textbox', { name: 'Work email' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Email me a sign-in link/ })).toBeVisible();
});
