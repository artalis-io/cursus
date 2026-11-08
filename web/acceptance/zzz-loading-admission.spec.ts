import {test,expect} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import type {DaySummary,Plan,Scenario} from '../src/types';

const compose=JSON.parse(process.env.CURSUS_ACCEPTANCE_COMPOSE??'null') as string[]|null;
function fixture(action:string){
 if(!compose)throw Error('Isolated acceptance Compose required');
 return JSON.parse(execFileSync(compose[0]!,[...compose.slice(1),'run','--rm','-T','fixture',action],{encoding:'utf8',timeout:60000}).trim().split('\n').at(-1)!);
}
test('physical facts cross real upload, admission, native solve and peer retrieval without enabling hard loading',async({page})=>{
 await page.addInitScript(()=>{localStorage.setItem('otto.helpSeen','1');});await page.goto('/');
 await page.getByRole('textbox',{name:'Work email'}).fill('admin@acceptance.example.test');
 await page.getByRole('button',{name:/Email me a sign-in link/}).click();
 await expect(page.getByRole('status')).toContainText('Check your inbox');await page.goto(fixture('link').link);
 await page.getByRole('button',{name:'Continue to Cursus',exact:true}).click();await expect(page.getByText('Served / Total')).toBeVisible();
 const origin=new URL(page.url()).origin,headers={origin},peer=process.env.CURSUS_ACCEPTANCE_PEER!;
 const bundle=fixture('loading-bundle');
 async function upload(value:unknown){const r=await page.request.post('/api/import/upload',{headers,multipart:{file:{name:'public-loading.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(value))}}});expect(r.status(),await r.text()).toBe(201);return (await r.json()).datasetId as string;}
 const id=await upload(bundle),path=`/api/import/datasets/${id}`;
 expect((await page.request.post(path+'/admit',{headers,data:{}})).status()).toBe(409);
 expect((await page.request.post(path+'/validate',{headers,data:{}})).status()).toBe(200);
 expect((await page.request.post(peer+path+'/admit',{headers,data:{}})).status()).toBe(200);
 const bad=structuredClone(bundle);bad.physicalLoading.mode='hard';const badId=await upload(bad);
 expect((await page.request.post(`/api/import/datasets/${badId}/validate`,{headers,data:{}})).status()).toBe(400);
 expect((await page.request.post(`/api/import/datasets/${badId}/admit`,{headers,data:{}})).status()).toBe(409);
 // An admitted but unsolved input is deliberately absent from the day picker.
 const created=await page.request.post('/api/scenarios',{headers,data:{day:bundle.days[0].dayId,label:'Public loading baseline'}});expect(created.status()).toBe(200);
 const initial=await created.json() as Scenario;
 const first=await page.request.post(`/api/scenarios/${initial.id}/solve`,{headers:{...headers,'if-match':`"${initial.revision}"`},data:{budgetSec:1}});expect(first.status()).toBe(202);
 const initialJob=await first.json() as {jobId:string};
 await expect.poll(async()=>(await (await page.request.get(`${peer}/api/jobs/${initialJob.jobId}`)).json()).status,{timeout:30000}).toBe('completed');
 const days=await (await page.request.get('/api/days')).json() as DaySummary[];
 const day=days.find(d=>d.id===bundle.days[0].dayId)!;expect(day).toBeTruthy();
 const base=await (await page.request.get(`/api/plans/${day.baselinePlanId}?geometry=stored`)).json() as Plan;
 expect(base.physicalLoading?.mode).toBe('disabled');expect(base.physicalLoading?.status).toBe('not_evaluated');
 const copied=await page.request.post('/api/scenarios',{headers,data:{from:day.baseScenarioId,label:'Public loading facts'}});expect(copied.status()).toBe(201);const scenario=await copied.json() as Scenario;
 const submitted=await page.request.post(`/api/scenarios/${scenario.id}/solve`,{headers:{...headers,'if-match':`"${scenario.revision}"`},data:{budgetSec:1}});expect(submitted.status()).toBe(202);
 const {jobId}=await submitted.json() as {jobId:string};
 await expect.poll(async()=>(await (await page.request.get(`${peer}/api/jobs/${jobId}`)).json()).status,{timeout:30000}).toBe('completed');
 const job=await (await page.request.get(`${peer}/api/jobs/${jobId}`)).json() as {planId:string};
 const plan=await (await page.request.get(`${peer}/api/plans/${job.planId}?geometry=stored`)).json() as Plan;
 expect(plan.stats.servedOrders).toBe(2);expect(plan.stats.totalOrders).toBe(2);expect(plan.provenance.validation.valid).toBe(true);
 expect(plan.physicalLoading?.mode).toBe('disabled');expect(plan.physicalLoading?.status).toBe('not_evaluated');
 expect(plan.physicalLoading?.sourceSha256).toBe(base.physicalLoading?.sourceSha256);
 expect(plan.physicalLoading?.rounds.reduce((n,r)=>n+r.unitCount,0)).toBe(2);
 const chosen=await page.request.post(`/api/scenarios/${scenario.id}/select-plan`,{headers:{...headers,'if-match':`"${scenario.revision}"`},data:{planId:plan.id,selectionVersion:scenario.selectionVersion??0,acknowledgeIncomplete:false}});expect(chosen.status(),await chosen.text()).toBe(200);
 await page.evaluate(({planId,day})=>localStorage.setItem('cursus.manual-workspace.v1:acceptance',JSON.stringify({planId,day})),{planId:plan.id,day:day.id});await page.reload();
 await expect(page.getByText('Served / Total')).toBeVisible();await page.locator('#cursus-status-details > summary').click();
 const evidence=page.getByTestId('loading-evidence');await expect(evidence).toContainText('Hard loading is disabled');
 await expect(evidence).toContainText(plan.physicalLoading!.sourceSha256);await expect(evidence).toContainText('Not evaluated');
 await page.getByRole('button',{name:'HU',exact:true}).click();await expect(evidence).toContainText('a rakodhatóság nincs igazolva');
});
