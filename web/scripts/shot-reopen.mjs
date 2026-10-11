import { chromium } from 'playwright';
const URL='http://localhost:5179';
const launch={headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist','--enable-unsafe-swiftshader']};
if(process.env.PW_CHROMIUM) launch.executablePath=process.env.PW_CHROMIUM;
const b=await chromium.launch(launch);
const p=await b.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
await p.goto(URL,{waitUntil:'networkidle'});
await p.waitForSelector('text=RIC-124',{timeout:20000}); await p.waitForTimeout(2000);
const before = await p.textContent('body'); console.log('fresh load shows 117/117:', /117 \/ 117/.test(before));
await p.click('text=Plans');
await p.waitForSelector('text=Saved plans',{timeout:8000}); await p.waitForTimeout(500);
// reopen the Live plan row
const btns = await p.$$('button:has-text("Reopen")');
console.log('reopen buttons available:', btns.length);
if (btns.length) { await btns[btns.length-1].click(); }  // the live row
await p.waitForTimeout(2500);
const after = await p.textContent('body');
console.log('after reopen live shows 113/117:', /113 \/ 117/.test(after));
console.log(errs.length?'ERRORS '+errs.slice(0,4).join(' | '):'no page errors');
await b.close();
