import {test,expect,type Page} from '@playwright/test';

/** Exercise presentation of stale policy evidence without changing fleet settings. */
export async function stalePolicyResponse(page:Page){
 await page.route('**/api/plans/*/manual-context',async route=>{
  const response=await route.fetch();
  if(!response.ok())throw Error('Manual context must be available for the regression fixture');
  await route.fulfill({response,json:{...await response.json(),requiresRevalidation:true}});
 });
}
export async function compactHeaderChecks(page:Page){
 const header=page.locator('header').filter({has:page.getByRole('navigation',{name:/^(Workspace tools|Munkaterület eszközei)$/})});
 for(const [lang,width,nav,optimize] of [
  ['en',1440,'Workspace tools',/^(Optimize|Replan)$/],
  ['hu',1920,'Munkaterület eszközei',/^(Optimalizálás|Újratervezés)$/],
 ] as const){
  await page.setViewportSize({width,height:900});await page.getByRole('button',{name:lang.toUpperCase(),exact:true}).click();
  const controls=[header.getByText('Cursus',{exact:true}),header.getByRole('combobox'),header.getByRole('navigation',{name:nav}).getByRole('button').first(),header.getByRole('button',{name:optimize})];
  const boxes=await Promise.all(controls.map(async c=>{await expect(c).toBeVisible();return (await c.boundingBox())!;}));
  expect(Math.max(...boxes.map(b=>b.y+b.height/2))-Math.min(...boxes.map(b=>b.y+b.height/2))).toBeLessThan(3);
  expect((await header.boundingBox())!.height).toBeLessThanOrEqual(52);
  await page.screenshot({path:test.info().outputPath(`compact-header-${lang}.png`)});
  for(const viewport of [375,768,1024]){
   await page.setViewportSize({width:viewport,height:850});
   const buttons=header.getByRole('navigation',{name:nav}).getByRole('button');
   for(let i=0;i<await buttons.count();i++){
    const trigger=buttons.nth(i);await expect(trigger).toBeVisible();
    await trigger.click();const menu=page.getByRole('menu');await expect(menu).toBeVisible();
    const box=(await menu.boundingBox())!;expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(viewport+1);
    await page.keyboard.press('Escape');await expect(menu).toHaveCount(0);
   }
   const box=(await header.boundingBox())!;expect(await header.evaluate(el=>el.scrollWidth)).toBeLessThanOrEqual(box.width+1);
  }
 }
 await page.getByRole('button',{name:'EN',exact:true}).click();await page.setViewportSize({width:1440,height:900});
}
export async function dismissPolicyChecks(page:Page){
 const notice=page.getByTestId('policy-notice');await expect(notice).toBeVisible();
 await expect(page.getByText('Revalidation required',{exact:true})).toBeVisible();
 const dismiss=notice.getByRole('button',{name:'Dismiss settings notice',exact:true});
 await dismiss.focus();await page.keyboard.press('Enter');await expect(notice).toHaveCount(0);
 await expect(page.getByText('Revalidation required',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'HU',exact:true}).click();await expect(notice).toHaveCount(0);
 await page.getByRole('button',{name:'EN',exact:true}).click();
 await page.reload();await expect(notice).toBeVisible();
}
