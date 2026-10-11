import { defineConfig } from '@playwright/test';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/*
 * UI tests run against an already-running dispatch app (Vite dev on :5179 by
 * default, or the backend-served SPA via VIEWER_URL). The backend (:8091),
 * Carta (:8097) and Velo (:8082) must be up - the tests exercise real solves
 * and geometry. Software WebGL (SwiftShader) renders the MapLibre map headless.
 *
 *   npm run test:ui                       # against http://localhost:5179
 *   VIEWER_URL=http://localhost:8091 npm run test:ui
 */

/* Playwright's bundled chromium version drifts with the npm package, but the
 * machine often only has an older cached chrome-headless-shell build. Rather
 * than force a re-download, point at whatever headless-shell is actually in the
 * cache. PW_CHROMIUM overrides; set it explicitly to pin a specific build. */
function cachedHeadlessShell(): string | undefined {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    join(homedir(), 'Library/Caches/ms-playwright'),   // macOS
    join(homedir(), '.cache/ms-playwright'),           // Linux
    join(homedir(), 'AppData/Local/ms-playwright'),    // Windows
  ].filter((r): r is string => !!r && existsSync(r));
  const bins = ['chrome-headless-shell', 'chrome-headless-shell.exe', 'headless_shell', 'headless_shell.exe'];
  for (const root of roots) {
    // newest build first (chromium_headless_shell-<n>, numerically descending)
    const dirs = readdirSync(root)
      .filter((d) => d.startsWith('chromium_headless_shell-'))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const dir of dirs) {
      for (const platform of safeReaddir(join(root, dir))) {
        for (const bin of bins) {
          const p = join(root, dir, platform, bin);
          if (existsSync(p)) return p;
        }
      }
    }
  }
  return undefined;
}
function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir).filter((d) => statSync(join(dir, d)).isDirectory()); } catch { return []; }
}
export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.VIEWER_URL || 'http://localhost:5179',
    viewport: { width: 1440, height: 900 },
    actionTimeout: 20_000,
    launchOptions: {
      ...((): { executablePath?: string } => { const p = cachedHeadlessShell(); return p ? { executablePath: p } : {}; })(),
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
    },
  },
});
