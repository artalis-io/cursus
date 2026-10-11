import { chromium } from 'playwright';
const URL = process.env.VIEWER_URL || 'http://127.0.0.1:8099';
const OUT = process.env.OUT || 'screenshots';
const launch = { headless: true, args: ['--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist','--enable-unsafe-swiftshader'] };
if (process.env.PW_CHROMIUM) launch.executablePath = process.env.PW_CHROMIUM;
const b = await chromium.launch(launch);
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errs = []; p.on('console', m => { if (m.type()==='error') errs.push(m.text()); }); p.on('pageerror', e => errs.push('PAGEERROR '+e.message));
const shot = async (n) => { await p.screenshot({ path: `${OUT}/${n}.png` }); console.log('wrote', n); };
const closePopover = async () => { const bd = p.locator('div.fixed.inset-0'); if (await bd.count()) { await bd.first().click({ position: { x: 700, y: 500 } }); await p.waitForTimeout(200); } };

await p.goto(URL, { waitUntil: 'networkidle' });
await p.waitForSelector('text=Served / Total', { timeout: 20000 });
await p.waitForSelector('text=RIC-124', { timeout: 20000 });
await p.waitForTimeout(3800);
await shot('11-overview-cost');

await p.click('[title="Solve settings"]'); await p.waitForTimeout(400);
await shot('12-solve-settings');
await closePopover();

await p.click('[title="Export"]'); await p.waitForTimeout(300);
await shot('13-export-menu');
await closePopover();

// overrides: select a stop, pin it, capture the pending-edits state
await p.click('text=RIC-124'); await p.waitForTimeout(1200);
await p.locator('g[style*="cursor: pointer"]').first().click({ timeout: 5000 });
await p.waitForTimeout(1000);
const pinBtn = p.locator('button', { hasText: 'Pin to' }).first();
if (await pinBtn.count()) { await pinBtn.click(); await p.waitForTimeout(1500); }
await shot('14-overrides');

// printable driver route sheet (its own HTML page)
await p.goto(`${URL}/api/plans/day1-baseline/routesheet.html`, { waitUntil: 'networkidle' });
await p.waitForTimeout(600);
await shot('15-route-sheet');

console.log(errs.length ? 'CONSOLE ERRORS: '+[...new Set(errs)].slice(0,8).join(' | ') : 'no console errors');
await b.close();
