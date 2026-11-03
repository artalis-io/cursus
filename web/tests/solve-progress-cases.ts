import {test,expect} from '@playwright/test';
import {publicWorkspace} from './public-workspace';
export function solveProgressCases(){
test('presentation: presets show their real budgets in EN/HU and respect server limits',async({page})=>{
 await publicWorkspace(page,false,600);
 await page.getByRole('button',{name:'Solve settings',exact:true}).click();
 for(const [label,seconds] of [['Quick',30],['Standard',240],['Thorough',600]] as const){
  await page.getByRole('radio',{name:new RegExp(label)}).click();
  await expect(page.getByRole('slider',{name:'Time budget',exact:true})).toHaveValue(String(seconds));
 }
 await page.keyboard.press('Escape');await page.getByRole('button',{name:'HU',exact:true}).click();
 await page.getByRole('button',{name:'Megoldási beállítások',exact:true}).click();
 await expect(page.getByRole('radio',{name:/Alapos/})).toHaveAttribute('aria-checked','true');
});

test('presentation: a lower server cap disables expensive presets instead of raising concurrency or limits',async({page})=>{
 await publicWorkspace(page,false,120);await page.getByRole('button',{name:'Solve settings',exact:true}).click();
 await expect(page.getByRole('radio',{name:/Thorough/})).toBeDisabled();await expect(page.getByRole('radio',{name:/Standard/})).toBeDisabled();
 await expect(page.getByRole('slider',{name:'Time budget',exact:true})).toHaveAttribute('max','120');
});

test('presentation: single submission, queued clock, reload, cancellation retry and candidate publication preserve the saved plan',async({page})=>{
 const {plan,scenario}=await publicWorkspace(page);
 let posts=0,cancels=0,phase='pending',submittedAt=Date.now();
 const candidate={...plan,id:'candidate',source:'live',stats:{...plan.stats,totalDistanceKm:99}};
 await page.route('**/api/scenarios/*/solve',async route=>{posts++;submittedAt=Date.now();await route.fulfill({status:202,json:{jobId:`job-${posts}`,status:'pending'}});});
 await page.route('**/api/jobs/job-*',async route=>{
  if(route.request().method()==='DELETE'){
   cancels++;if(cancels===1)return route.fulfill({status:503,json:{error:'Temporary cancellation outage'}});
   phase='cancelled';return route.fulfill({json:{cancelled:true,status:'cancelled'}});
  }
  await route.fulfill({json:{id:new URL(route.request().url()).pathname.split('/').at(-1),scenarioId:scenario.id,status:phase,elapsedSec:(Date.now()-submittedAt)/1000,planId:phase==='completed'?'candidate':null}});
 });
 await page.route('**/api/plans/candidate*',route=>route.fulfill({json:candidate}));
 const optimize=page.getByRole('button',{name:'Optimize',exact:true});
 await optimize.evaluate(el=>{(el as HTMLButtonElement).click();(el as HTMLButtonElement).click();});
 await expect.poll(()=>posts).toBe(1);
 const queued=page.locator('header').getByRole('button',{name:/^Queued ·/});await expect(queued).toBeVisible();
 const first=await queued.getAttribute('aria-label');await expect(queued).not.toHaveAttribute('aria-label',first!);
 await page.reload();await expect(queued).toBeVisible();await expect(page.getByText('2 / 2',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await expect(page.getByRole('alert')).toBeVisible();await expect(queued).toBeVisible();
 await page.getByRole('button',{name:'Cancel',exact:true}).click();await expect(optimize).toBeVisible();
 await expect(page.getByText('2 / 2',{exact:true})).toBeVisible();expect(posts).toBe(1);
 phase='running';await optimize.click();await expect(page.getByRole('button',{name:/^Optimizing/})).toBeVisible();
 phase='completed';await page.getByText('Candidate ready',{exact:true}).waitFor();
 await page.keyboard.press('Escape');await expect(page.getByText('New candidate — the previous plan is still displayed.',{exact:true})).toBeVisible();
 await expect(page.locator('[data-kpi="distance"] [data-kpi-value]')).toContainText('5 km');
});

}
