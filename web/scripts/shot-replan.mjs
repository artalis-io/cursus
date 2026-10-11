import { chromium } from 'playwright';
const URL = process.env.VIEWER_URL || 'http://localhost:5179';
const OUT = 'screenshots';
const launch = { headless: true, args: ['--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist','--enable-unsafe-swiftshader'] };
if (process.env.PW_CHROMIUM) launch.executablePath = process.env.PW_CHROMIUM;
const b = await chromium.launch(launch);
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errs = [];
p.on('console', m => { if (m.type()==='error') errs.push(m.text()); });
p.on('pageerror', e => errs.push('PAGEERROR '+e.message));
await p.goto(URL, { waitUntil: 'networkidle' });
await p.waitForSelector('text=RIC-124', { timeout: 20000 });
await p.waitForTimeout(2500);
// Select the vehicle, then mark it unavailable & replan from the inspector.
await p.click('text=RIC-124');
await p.waitForSelector('text=/Mark RIC-124 unavailable/', { timeout: 10000 });
console.log('clicking replan…');
await p.click('text=/Mark RIC-124 unavailable/');
// top bar should show Replanning with elapsed
await p.waitForSelector('text=/Replanning/', { timeout: 8000 }).catch(()=>{});
await p.waitForTimeout(1500);
await p.screenshot({ path: `${OUT}/03-replanning.png` });
console.log('wrote 03-replanning.png (solving)');
// wait for comparison dialog
await p.waitForSelector('text=/Plan comparison/', { timeout: 90000 });
await p.waitForTimeout(800);
await p.screenshot({ path: `${OUT}/04-comparison.png` });
console.log('wrote 04-comparison.png');
// close dialog -> revised plan with KPI deltas
await p.keyboard.press('Escape');
await p.waitForTimeout(1500);
await p.screenshot({ path: `${OUT}/05-revised.png` });
console.log('wrote 05-revised.png');
console.log(errs.length ? 'CONSOLE ERRORS:\n  '+[...new Set(errs)].slice(0,8).join('\n  ') : 'no console errors');
await b.close();
