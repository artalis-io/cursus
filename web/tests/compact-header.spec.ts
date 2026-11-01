import {test,expect,type Page} from '@playwright/test';
import {manualFixture} from '../../server/src/state/manual-fixture';
import {compactHeaderChecks,dismissPolicyChecks} from './compact-header';

async function publicWorkspace(page:Page,stale=false){
 const f=manualFixture(),plan={...f.parent,source:'saved',scenarioRevision:1},scenario={...f.scenario,kind:'base'};
 for(const v of plan.vehicles)for(const trip of v.trips)trip.geometry={type:'LineString',coordinates:[[19,47],[19.1,47.1]]};
 const days=[{id:scenario.day,isoDate:'2026-05-06',orders:117,baseScenarioId:scenario.id,baselinePlanId:plan.id},
  {id:'second-day',isoDate:'2026-05-07',orders:146,baseScenarioId:'second-scenario',baselinePlanId:'second-plan'}];
 await page.addInitScript(()=>{localStorage.setItem('otto.helpSeen','1');localStorage.setItem('otto.lang','en');});
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(route.request().method()!=='GET')throw Error('Presentation tests must not mutate application state');
  let value:unknown;
  if(path==='/api/auth/me')value={email:'admin@example.test',tenantId:'public',tenantName:'Acceptance workspace',role:'admin'};
  else if(path==='/api/auth/workspace')value={};
  else if(path==='/api/days')value=days;
  else if(path.endsWith('/manual-context'))value={enabled:false,requiresRevalidation:stale};
  else if(path.startsWith('/api/scenarios/'))value=path.includes('second-scenario')?{...scenario,id:'second-scenario',day:'second-day'}:scenario;
  else if(path==='/api/plans/'+plan.id)value=plan;
  else if(path==='/api/plans/second-plan')value={...plan,id:'second-plan',scenarioId:'second-scenario'};
  else if(path.endsWith('/workflow'))value={state:'draft',version:0,currentRevision:1,scenarioRevision:1,planSha256:'a'.repeat(64),actor:null,at:null,blockers:[]};
  else return route.fulfill({status:404,json:{error:'Unavailable in public presentation fixture'}});
  await route.fulfill({json:value});
 });
 await page.goto('/');await expect(page.getByText('Served / Total',{exact:true})).toBeVisible();
}
test('compact header keeps desktop context and commands on one row with reachable responsive menus',async({page})=>{
 await publicWorkspace(page);await compactHeaderChecks(page);
});
test('settings notice dismissal preserves revalidation and resets for a different plan',async({page})=>{
 await publicWorkspace(page,true);await dismissPolicyChecks(page);
 const notice=page.getByTestId('policy-notice');await notice.getByRole('button',{name:'Dismiss settings notice'}).click();
 await page.locator('header').getByRole('combobox').click();await page.getByRole('option',{name:/146 orders/}).click();
 await expect(notice).toBeVisible();await expect(page.getByText('Revalidation required',{exact:true})).toBeVisible();
});
