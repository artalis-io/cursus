import {expect,test,type Page} from '@playwright/test';
import {publicWorkspace} from './public-workspace';

export function planningRecoveryCases(){
 test('Stop remains visible when freshness becomes unverified and route editing is paused',async({page})=>{
  const {scenario,plan}=await publicWorkspace(page);let stopped=false,unverified=false;
  await page.route('**/api/jobs/active',route=>route.fulfill({json:[]}));
  await page.route(`**/api/scenarios/${scenario.id}`,route=>unverified?route.fulfill({status:503,json:{error:'Temporarily unavailable'}}):route.fulfill({json:scenario}));
  await page.route('**/api/scenarios/*/solve',route=>route.fulfill({status:202,json:{jobId:'running-job'}}));
  await page.route('**/api/jobs/running-job',async route=>{
   if(route.request().method()==='DELETE'){stopped=true;return route.fulfill({json:{cancelled:true,status:'cancelled'}});}
   await route.fulfill({json:{id:'running-job',scenarioId:scenario.id,status:stopped?'cancelled':'running',elapsedSec:10}});
  });
  await page.getByRole('button',{name:'Optimize',exact:true}).click();
  await expect(page.getByRole('button',{name:'Cancel',exact:true})).toBeEnabled();
  unverified=true;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('button',{name:'Cancel',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();await expect.poll(()=>stopped).toBe(true);
  await expect(page.locator('header').getByRole('button',{name:/^Optimizing/})).toHaveCount(0);
  unverified=false;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('button',{name:'Optimize',exact:true})).toBeEnabled();
  await page.locator('aside').first().locator('[data-inspect-vehicle]').getByText(plan.vehicles[0].ref,{exact:true}).click();
  await page.locator('aside').last().getByRole('button',{name:/Trip 1/}).click();
  await expect(page.locator('aside').last().locator('[draggable="true"]')).toHaveCount(2);
 });

 test('server discovery reconnects without local storage; navigating away retains Open and Stop',async({page})=>{
  const {scenario,days,plan}=await publicWorkspace(page);let active=true;
  await page.route('**/api/jobs/active',route=>route.fulfill({json:active?[{id:'durable-job',scenarioId:scenario.id,dayId:days[0].id,referencePlanId:plan.id,status:'running',elapsedSec:20}]:[]}));
  await page.route('**/api/jobs/durable-job',async route=>{
   if(route.request().method()==='DELETE'){active=false;return route.fulfill({json:{cancelled:true,status:'cancelled'}});}
   await route.fulfill({json:{id:'durable-job',scenarioId:scenario.id,status:active?'running':'cancelled',elapsedSec:20}});
  });
  await page.evaluate(()=>Object.keys(localStorage).filter(k=>k==='otto.activeJob'||k.startsWith('cursus.activeJob.v2:')).forEach(k=>localStorage.removeItem(k)));await page.reload();
  await expect(page.getByRole('button',{name:'Cancel',exact:true})).toBeEnabled();
  await page.locator('header').getByRole('combobox').click();
  await page.getByRole('option',{name:/7 May 2026/}).click();
  await expect(page.getByText('Optimization continues in the background.',{exact:true})).toBeVisible({timeout:10000});
  await expect(page.getByRole('button',{name:'Open optimization',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();await expect.poll(()=>active).toBe(false);
  await expect(page.getByText('Optimization continues in the background.',{exact:true})).toHaveCount(0);
 });
}

export function manualDestinationCases(){
 test('Move is available without dragging; search and an explicit round determine the exact preview destination',async({page})=>{
  const {plan,scenario}=await publicWorkspace(page);
  const source=plan.vehicles[0],target={...source,id:42,ref:'SEARCH-042',trips:[
   {...source.trips[0],index:0,manualTripId:'round-a',startSec:28800,endSec:32400,stops:[]},
   {...source.trips[0],index:1,manualTripId:'round-b',startSec:43200,endSec:46800,stops:[]},
  ]};
  await page.route('**/manual-context',route=>route.fulfill({json:{enabled:true,datasetSha256:'a'.repeat(64),fleet:[source,target],actors:{}}}));
  await page.reload();await expect(page.getByText('Served / Total',{exact:true})).toBeVisible();
  await page.locator('aside').first().locator('[data-inspect-vehicle]').getByText(source.ref,{exact:true}).click();
  await page.locator('aside').last().getByRole('button',{name:/Trip 1/}).click();
  await page.locator('aside').last().locator('ol li > button').first().click();
  await page.getByRole('button',{name:'Move to vehicle…',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Manual planning',exact:true});
  await dialog.getByRole('searchbox',{name:'Search vehicles',exact:true}).fill('SEARCH-042');
  const vehicle=dialog.getByRole('combobox',{name:'Vehicle',exact:true});
  await expect(vehicle.locator('option')).toHaveCount(2);await vehicle.selectOption('42');
  await expect(dialog.getByRole('button',{name:'Calculate preview',exact:true})).toBeDisabled();
  await dialog.getByRole('combobox',{name:'Trip',exact:true}).selectOption('round-b');
  await expect(dialog.getByRole('region',{name:'Destination',exact:true})).toContainText('SEARCH-042');
  await expect(dialog.getByRole('region',{name:'Destination',exact:true})).toContainText('Trip 2');
  let body:Record<string,unknown>|null=null;
  await page.route('**/manual-preview',async route=>{body=route.request().postDataJSON();await route.fulfill({json:{stats:plan.stats,cost:plan.cost,validation:{valid:true,violations:[]}}});});
  await dialog.getByRole('button',{name:'Calculate preview',exact:true}).click();
  await expect.poll(()=>body!==null).toBe(true);
  expect((body as unknown as {batch:{commands:Array<{vehicleId:number;tripId:string}>}}).batch.commands[0]).toMatchObject({vehicleId:42,tripId:'round-b'});
  await expect(dialog.getByTestId('manual-preview')).toBeVisible();
 });
}
