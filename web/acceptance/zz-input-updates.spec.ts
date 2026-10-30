import {test,expect,type Page} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import type {Plan,DaySummary,Scenario} from '../src/types';

const compose=JSON.parse(process.env.CURSUS_ACCEPTANCE_COMPOSE??'null') as string[]|null;
function fixture(action:string){if(!compose)throw Error('Isolated acceptance Compose required');return JSON.parse(execFileSync(compose[0]!,[...compose.slice(1),'run','--rm','-T','fixture',action],{encoding:'utf8',timeout:60000}).trim().split('\n').at(-1)!);}
async function login(page:Page,email='admin@acceptance.example.test'){
 await page.addInitScript(()=>{localStorage.setItem('otto.helpSeen','1');});await page.goto('/');
 await page.getByRole('textbox',{name:'Work email'}).fill(email);await page.getByRole('button',{name:/Email me a sign-in link/}).click();
 await expect(page.getByRole('status')).toContainText('Check your inbox');await page.goto(fixture('link').link);
 await page.getByRole('button',{name:'Continue to Cursus',exact:true}).click();await expect(page.getByText('Served / Total')).toBeVisible();
}

test('reviewed snapshot update preserves manual delivery identity, recalculates KPIs, reloads and replans through the real worker',async({page},testInfo)=>{
 await login(page);
 const origin=new URL(page.url()).origin,days=await (await page.request.get('/api/days')).json() as DaySummary[];
 const oldDay=days.find(d=>d.id==='acceptance-day-two')!;
 const base=await (await page.request.get(`/api/plans/${oldDay.baselinePlanId}?geometry=stored`)).json() as Plan;
 const v=base.vehicles.find(v=>v.trips.some(t=>t.stops.some(s=>s.requestId===130)))!,trip=v.trips.find(t=>t.stops.some(s=>s.requestId===130))!;
 const retained=await page.request.post(`/api/scenarios/${base.scenarioId}/manual-plan`,{headers:{origin,'if-match':`"${base.scenarioRevision}"`},data:{parentPlanId:base.id,batch:{operationId:'snapshot-retained',datasetSha256:base.provenance.datasetSha256,
  commands:[{op:'assign',requestId:130,vehicleId:v.id,tripId:`trip-${trip.index}`,position:0}]}}});
 expect(retained.status(),await retained.text()).toBe(201);const source=await retained.json() as Plan;
 const bundle=fixture('revised-input-bundle');
 const upload=await page.request.post('/api/import/upload',{headers:{origin},multipart:{file:{name:'public-revised.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(bundle))}}});
 expect(upload.status()).toBe(201);const {datasetId}=await upload.json() as {datasetId:string};
 for(const action of ['validate','admit']){const r=await page.request.post(`/api/import/datasets/${datasetId}/${action}`,{headers:{origin},data:{}});expect(r.ok(),await r.text()).toBe(true);}
 await page.evaluate(({planId,day})=>localStorage.setItem('cursus.manual-workspace.v1:acceptance',JSON.stringify({planId,day})),{planId:source.id,day:oldDay.id});await page.reload();
 await expect(page.getByRole('button',{name:'Update input snapshot',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'Update input snapshot',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Update input snapshot',exact:true});
 await dialog.getByRole('combobox',{name:'Replacement snapshot',exact:true}).selectOption(JSON.stringify([datasetId,'acceptance-day-two-revised']));
 // Repeated business references deliberately have no automatic pairing.
 await expect(dialog.getByRole('combobox',{name:'Match delivery 130',exact:true})).toHaveValue('');
 for(const id of [130,170])await dialog.getByRole('combobox',{name:`Match delivery ${id}`,exact:true}).selectOption(String(id+1000));
 await dialog.getByRole('textbox',{name:'Update reason',exact:true}).fill('Reviewed public replacement correspondence');
 await dialog.getByRole('checkbox',{name:/I verified the delivery correspondence/}).check();
 await dialog.getByRole('button',{name:'Preview input changes',exact:true}).click();
 await expect(dialog.getByRole('region',{name:'Input update preview'})).toContainText('Retained decisions: 1');
 await expect(dialog).toContainText('Recalculated: 2/2');
 await dialog.getByRole('checkbox',{name:/I verified the delivery correspondence/}).uncheck();
 await expect(dialog.getByRole('region',{name:'Input update preview'})).toHaveCount(0);
 await expect(dialog.getByRole('button',{name:'Create updated draft',exact:true})).toBeDisabled();
 await dialog.getByRole('checkbox',{name:/I verified the delivery correspondence/}).check();
 await dialog.getByRole('button',{name:'Preview input changes',exact:true}).click();
 await expect(dialog).toContainText('Recalculated: 2/2');
 await page.setViewportSize({width:600,height:800});
 expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
 await dialog.screenshot({path:testInfo.outputPath('input-update-preview.png')});
 await page.setViewportSize({width:1440,height:1000});
 await dialog.getByRole('checkbox',{name:/Make this the new input cycle/}).check();
 let committed!:(plan:Plan)=>void;
 const applied=new Promise<Plan>(resolve=>{committed=resolve;});
 let navigationScenarioId:string|null=null,releaseNavigation!:()=>void,captureNavigation!:()=>void;
 const navigationGate=new Promise<void>(resolve=>{releaseNavigation=resolve;}),navigationCaptured=new Promise<void>(resolve=>{captureNavigation=resolve;});
 await page.route('**/api/scenarios/*',async route=>{
  if(route.request().method()==='GET'&&new URL(route.request().url()).pathname===`/api/scenarios/${navigationScenarioId}`){
   const response=await route.fetch();captureNavigation();await navigationGate;await route.fulfill({response});
  }else await route.continue();
 });
 await page.route('**/input-update-apply',async route=>{
  const response=await route.fetch();expect(response.status(),await response.text()).toBe(201);
  const plan=await response.json() as Plan;navigationScenarioId=plan.scenarioId;committed(plan);
  // Server committed, but the browser lost the response. Recover by the
  // operation-bound immutable receipt, without issuing another update.
  await route.abort('failed');
 });
 await dialog.getByRole('button',{name:'Create updated draft',exact:true}).click();
 const updated=await applied;
 await navigationCaptured;
 try{await expect(dialog).toBeVisible();await expect(dialog.getByRole('button',{name:'Create updated draft',exact:true})).toBeDisabled();}
 finally{releaseNavigation();}
 await expect(dialog).toHaveCount(0);await expect(page.getByText('Served / Total')).toBeVisible();
 expect(updated.stats.servedOrders).toBe(2);expect(updated.stats.totalOrders).toBe(2);
 expect(updated.vehicles.flatMap(v=>v.trips).reduce((sum,t)=>sum+t.loadKg,0)).toBe(250);
 expect(updated.manual?.layout.decisions['1130']).toEqual({kind:'vehicle',vehicleId:v.id});
 const scenario=await (await page.request.get(`/api/scenarios/${updated.scenarioId}`)).json() as Scenario;
 expect(scenario.datasetBinding?.datasetId).toBe(datasetId);
 expect((await page.request.get(`/api/plans/${updated.id}/handoff.json`)).ok()).toBe(true);
 await page.reload();await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('cursus.manual-workspace.v1:acceptance')??'null')?.planId)).toBe(updated.id);
 const solve=await page.request.post(`/api/scenarios/${scenario.id}/solve`,{headers:{origin,'if-match':`"${scenario.revision}"`},data:{budgetSec:1}});expect(solve.status()).toBe(202);
 const {jobId}=await solve.json() as {jobId:string};
 await expect.poll(async()=>{const r=await page.request.get(`/api/jobs/${jobId}`);return (await r.json()).status;},{timeout:30000}).toBe('completed');
 const job=await (await page.request.get(`/api/jobs/${jobId}`)).json() as {planId:string};
 const solved=await (await page.request.get(`/api/plans/${job.planId}?geometry=stored`)).json() as Plan;
 expect(solved.stats.servedOrders).toBe(2);expect(solved.provenance.validation.valid).toBe(true);
 expect(solved.vehicles.find(vehicle=>vehicle.id===v.id)?.trips.flatMap(t=>t.stops).some(s=>s.requestId===1130)).toBe(true);
 const beforeAdoption=await (await page.request.get(`/api/scenarios/${scenario.id}`)).json() as Scenario;
 expect(beforeAdoption.selectedPlanId).toBe(updated.id,'completing HGS does not automatically adopt its candidate');
 const adoption=await page.request.post(`/api/scenarios/${scenario.id}/select-plan`,{headers:{origin,'if-match':`"${beforeAdoption.revision}"`},data:{planId:job.planId,selectionVersion:beforeAdoption.selectionVersion??0,acknowledgeIncomplete:false}});
 expect(adoption.status(),await adoption.text()).toBe(200);
 // Archived workspace has no write controls, but its original plan remains readable.
 await page.evaluate(({planId,day})=>localStorage.setItem('cursus.manual-workspace.v1:acceptance',JSON.stringify({planId,day})),{planId:source.id,day:oldDay.id});await page.reload();
 await expect(page.getByRole('button',{name:'Open updated inputs',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Update input snapshot',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Manual planning',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'Open updated inputs',exact:true}).click();await expect(page.getByRole('button',{name:'Update input snapshot',exact:true})).toBeEnabled();
 await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('cursus.manual-workspace.v1:acceptance')??'null')?.planId)).toBe(job.planId);
});
