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
await p.waitForSelector('text=Served / Total', { timeout: 20000 });
await p.waitForSelector('text=RIC-124', { timeout: 20000 });
await p.waitForTimeout(3500); // tiles + fitAll settle
await p.screenshot({ path: `${OUT}/01-overview.png` });
console.log('wrote 01-overview.png');
// Coordinated selection: click the first fleet vehicle card.
await p.click('text=RIC-124');
await p.waitForTimeout(2000);
await p.screenshot({ path: `${OUT}/02-vehicle-selected.png` });
console.log('wrote 02-vehicle-selected.png');
console.log(errs.length ? 'CONSOLE ERRORS:\n  '+[...new Set(errs)].slice(0,8).join('\n  ') : 'no console errors');
await b.close();
