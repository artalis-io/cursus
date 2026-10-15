import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  testDir: './acceptance',
  timeout: 120_000,
  retries: 0,
  workers: 1,
  maxFailures: 1,
  outputDir: process.env.CURSUS_ACCEPTANCE_OUTPUT_DIR ?? 'test-results/acceptance',
  expect: { timeout: 30_000 },
  reporter: [['list'], ['json', { outputFile: process.env.CURSUS_ACCEPTANCE_BROWSER_REPORT }]],
  use: { ...base.use, baseURL: process.env.VIEWER_URL, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
