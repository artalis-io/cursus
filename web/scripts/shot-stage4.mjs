import { chromium } from 'playwright';
const URL = process.env.VIEWER_URL || 'http://localhost:5179';
const launch = { headless: true, args: ['--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist','--enable-unsafe-swiftshader'] };
if (process.env.PW_CHROMIUM) launch.executablePath = process.env.PW_CHROMIUM;
const b = await chromium.launch(launch);
const errs = [];
async function newPage(w,h){ const p = await b.newPage({ viewport:{width:w,height:h}, deviceScaleFactor:1 });
  p.on('console', m=>{ if(m.type()==='error') errs.push(m.text()); }); p.on('pageerror', e=>errs.push('PE '+e.message)); return p; }

// Responsive sizes
for (const [w,h,name] of [[1280,800,'07-overview-1280x800'],[1920,1080,'08-overview-1920x1080']]) {
  const p = await newPage(w,h);
  await p.goto(URL,{waitUntil:'networkidle'});
  await p.waitForSelector('text=RIC-124',{timeout:20000});
  await p.waitForTimeout(3000);
  await p.screenshot({ path:`screenshots/${name}.png` });
  console.log('wrote',name);
  await p.close();
}

// Save/reopen: replan -> compare -> close -> Plans dialog -> reopen baseline
const p = await newPage(1440,900);
await p.goto(URL,{waitUntil:'networkidle'});
await p.waitForSelector('text=RIC-124',{timeout:20000});
await p.waitForTimeout(2000);
await p.click('text=RIC-124');
await p.waitForSelector('text=/Mark RIC-124 unavailable/',{timeout:10000});
await p.click('text=/Mark RIC-124 unavailable/');
await p.waitForSelector('text=/Plan comparison/',{timeout:90000});
await p.keyboard.press('Escape');
await p.waitForTimeout(800);
await p.click('text=Plans');
await p.waitForSelector('text=Saved plans',{timeout:8000});
await p.waitForTimeout(600);
await p.screenshot({ path:'screenshots/09-history.png' });
console.log('wrote 09-history');
// reopen baseline (the "Reopen" button on the Baseline row)
await p.click('text=Baseline');  // badge; may need the Reopen button
// Click the Reopen button in the baseline row
const reopened = await p.$$('button:has-text("Reopen")');
if (reopened[0]) await reopened[0].click();
await p.waitForTimeout(1500);
const served = await p.textContent('body');
console.log('after reopen, served 117/117 present:', /117 \/ 117/.test(served||''));
await p.close();
console.log(errs.length ? 'ERRORS: '+[...new Set(errs)].slice(0,6).join(' | ') : 'no console errors');
await b.close();
