import {expect,type Page} from '@playwright/test';
import {publicPlan} from './public-plan';
export async function publicWorkspace(page:Page,stale=false,maxSeconds=600){
 const f=publicPlan(),plan={...f.parent,source:'saved',scenarioRevision:1},scenario={...f.scenario,kind:'base'};
 for(const v of plan.vehicles)for(const trip of v.trips)trip.geometry={type:'LineString',coordinates:[[19,47],[19.1,47.1]]};
 const days=[{id:scenario.day,isoDate:'2026-05-06',orders:117,baseScenarioId:scenario.id,baselinePlanId:plan.id},
  {id:'second-day',isoDate:'2026-05-07',orders:146,baseScenarioId:'second-scenario',baselinePlanId:'second-plan'}];
 await page.addInitScript(()=>{localStorage.setItem('otto.helpSeen','1');localStorage.setItem('otto.lang','en');});
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(route.request().method()!=='GET')throw Error('Presentation tests must not mutate application state');
  let value:unknown;
  if(path==='/api/auth/me')value={email:'admin@example.test',tenantId:'public',tenantName:'Acceptance workspace',role:'admin',solveLimits:{maxSeconds}};
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
 return {plan,scenario,days};
}
