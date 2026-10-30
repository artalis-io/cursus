// Design-artifact checks only. Does not launch Cursus, use credentials or call APIs.
// Usage: node docs/mockups/check-workflow.cjs /external/output/directory
const {chromium}=require('../../web/node_modules/@playwright/test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const output=path.resolve(process.argv[2]||'/tmp/cursus-workspace-design');
fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});
 const context=await browser.newContext({viewport:{width:1440,height:1080},offline:true});
 const page=await context.newPage(),errors=[],requests=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('request',r=>{if(/^https?:/.test(r.url()))requests.push(r.url());});
 let cases=0;
 try{
  await page.goto(pathToFileURL(path.join(__dirname,'workflow-workspace.html')).href);
  for(const lang of ['en','hu']){
   if(await page.locator('html').getAttribute('lang')!==lang)await page.locator('#language').click();
   for(const role of ['Admin','Planner','Reviewer']){
    await page.locator('#role').selectOption(role);
    for(const state of ['blocked','clean','pending','candidate','reviewed','approved','archived']){
     await page.locator('#state').selectOption(state);
     for(const view of ['prepare','plan','review']){
      await page.locator(`[data-view="${view}"]`).click();
      assert.equal(await page.locator(`#${view}`).isVisible(),true);
      assert.equal(await page.locator(`[data-view="${view}"]`).getAttribute('aria-pressed'),'true');
      assert.equal(await page.locator('#state').inputValue(),state,'navigation preserves example state');
      assert.equal(await page.locator('#role').inputValue(),role,'navigation does not change role');
      if(role==='Reviewer'||state==='archived'){
       assert.equal(await page.locator('[data-edit]:not(:disabled)').count(),0);
       if(view==='plan')assert.equal(await page.locator('#primary-action').isDisabled(),true);
      }
      if(view==='review'&&state==='reviewed')assert.equal(await page.locator('#primary-action').isDisabled(),role!=='Admin');
      if(['pending','candidate','archived'].includes(state))assert.equal(await page.locator(state==='candidate'&&view==='plan'?'#candidate':'#critical').isVisible(),true,'critical status remains across views without duplicate full panels');
      if(state==='pending')assert.match(await page.locator('#identity-detail').textContent(),/11.*12/,'saved and scenario revisions are distinct');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
      if(view==='plan'&&['clean','blocked'].includes(state)){
       const chrome=await page.evaluate(()=>document.querySelector('.workspace').getBoundingClientRect().top-document.querySelector('.top').getBoundingClientRect().bottom);
       assert.ok(chrome<=220,`normal planning chrome ${chrome}px must leave room for routes/map`);
      }
      cases++;
     }
    }
   }
   await page.locator('#role').selectOption('Planner');await page.locator('#state').selectOption('blocked');
   for(const view of ['prepare','plan','review']){
    await page.locator(`[data-view="${view}"]`).click();
    await page.screenshot({path:path.join(output,`${view}.${lang}.png`),fullPage:true});
   }
   await page.setViewportSize({width:375,height:812});
   for(const view of ['prepare','plan','review']){
    await page.locator(`[data-view="${view}"]`).click();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,`${lang} ${view} fits a narrow viewport`);
    await page.screenshot({path:path.join(output,`${view}.mobile.${lang}.png`),fullPage:true});
   }
   await page.setViewportSize({width:1440,height:1080});
  }
  await page.locator('#role').selectOption('Admin');await page.locator('#state').selectOption('candidate');await page.locator('[data-view="plan"]').click();
  assert.equal(await page.locator('#candidate').isVisible(),true);
  await page.screenshot({path:path.join(output,'candidate.hu.png'),fullPage:true});
  await page.locator('[data-note]').first().click();assert.equal(await page.locator('#message').isVisible(),true);
  await page.locator('#library').click();await page.keyboard.press('Escape');assert.equal(await page.locator('#library').getAttribute('aria-expanded'),'false');
  assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
  const report={status:'passed',artifactOnly:true,source:'docs/mockups/workflow-workspace.html',stateRoleLanguageViewCases:cases,narrowCases:6,screenshots:13,networkRequests:0,javascriptErrors:0,applicationTestsRun:false,productionChanges:false};
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
