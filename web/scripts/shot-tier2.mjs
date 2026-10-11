import { chromium } from 'playwright';
const URL = process.env.VIEWER_URL || 'http://127.0.0.1:8099';
const OUT = process.env.OUT || 'screenshots';
const launch = { headless: true, args: ['--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist','--enable-unsafe-swiftshader'] };
if (process.env.PW_CHROMIUM) launch.executablePath = process.env.PW_CHROMIUM;
const b = await chromium.launch(launch);
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const shot = async (n) => { await p.screenshot({ path: `${OUT}/${n}.png` }); console.log('wrote', n); };
const sel = async (ref) => p.locator('aside').first().getByText(ref, { exact: true }).click();

await p.goto(URL, { waitUntil: 'networkidle' });
await p.waitForSelector('text=RIC-124', { timeout: 20000 }); await p.waitForTimeout(3500);

// 16 trip details
await sel('RIC-124'); await p.waitForTimeout(600);
await p.locator('aside').first().getByRole('button', { name: 'Expand trips' }).first().click();
await p.locator('aside').first().getByRole('button', { name: /^Trip 1/ }).first().click();
await p.waitForTimeout(1200); await shot('16-trip-details');

// 17 edit stack: stage removal + constraint, open Changes
await sel('RIC-124'); await p.waitForTimeout(400);
await p.getByRole('button', { name: /Mark RIC-124 unavailable/ }).click(); await p.waitForTimeout(500);
await sel('RIX-419'); await p.waitForTimeout(400);
await p.getByRole('button', { name: /Edit constraints/ }).click(); await p.waitForTimeout(300);
await p.locator('input[type=number]').first().fill('9000'); await p.locator('input[type=number]').first().blur(); await p.waitForTimeout(500);
await p.getByRole('button', { name: /Changes/ }).click(); await p.waitForTimeout(600); await shot('17-edit-stack');
await p.keyboard.press('Escape'); await p.waitForTimeout(300);

// 18 constraint advisories (RIX-419 still selected shows advisories)
await sel('RIX-419'); await p.waitForTimeout(800); await shot('18-constraints');

// 19 week view
await p.getByRole('button', { name: 'Week' }).click(); await p.waitForTimeout(900); await shot('19-week');
await p.keyboard.press('Escape'); await p.waitForTimeout(300);

// 20 playback mid-sweep
await sel('NWZ-634').catch(() => sel('RIX-419')); await p.waitForTimeout(600);
await p.getByRole('button', { name: 'Play' }).click(); await p.waitForTimeout(2200); await shot('20-playback');

console.log('done');
await b.close();
