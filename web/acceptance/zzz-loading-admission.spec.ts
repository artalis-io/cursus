import {test,expect} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import type {DaySummary,Plan,Scenario} from '../src/types';

const compose=JSON.parse(process.env.CURSUS_ACCEPTANCE_COMPOSE??'null') as string[]|null;
function fixture(action:string){
 if(!compose)throw Error('Isolated acceptance Compose required');
 return JSON.parse(execFileSync(compose[0]!,[...compose.slice(1),'run','--rm','-T','fixture',action],{encoding:'utf8',timeout:60000}).trim().split('\n').at(-1)!);
}
for(const axles of [false,true])test(`physical facts ${axles?'V2 axle loads':'V1 stacking'} follow the server policy through admission, native solve, manual edits and peer export`,async({page})=>{
 await page.addInitScript(()=>{localStorage.setItem('otto.helpSeen','1');});await page.goto('/');
 await page.getByRole('textbox',{name:'Work email'}).fill('admin@acceptance.example.test');
 await page.getByRole('button',{name:/Email me a sign-in link/}).click();
 await expect(page.getByRole('status')).toContainText('Check your inbox');await page.goto(fixture('link').link);
 await page.getByRole('button',{name:'Continue to Cursus',exact:true}).click();await expect(page.getByText('Served / Total')).toBeVisible();
 const origin=new URL(page.url()).origin,headers={origin},peer=process.env.CURSUS_ACCEPTANCE_PEER!;
 const hard=process.env.CURSUS_ACCEPTANCE_HARD_LOADING_ENABLED==='1';
 const identity=await (await page.request.get('/api/auth/me')).json();expect(identity.features.hardLoading).toBe(hard);
 const bundle=fixture(axles?'axle-loading-bundle':'loading-bundle');
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
 expect(base.physicalLoading?.mode).toBe(hard?'hard':'disabled');expect(base.physicalLoading?.status).toBe(hard?'feasible':'not_evaluated');
 const copied=await page.request.post('/api/scenarios',{headers,data:{from:day.baseScenarioId,label:'Public loading facts'}});expect(copied.status()).toBe(201);const scenario=await copied.json() as Scenario;
 const submitted=await page.request.post(`/api/scenarios/${scenario.id}/solve`,{headers:{...headers,'if-match':`"${scenario.revision}"`},data:{budgetSec:1}});expect(submitted.status()).toBe(202);
 const {jobId}=await submitted.json() as {jobId:string};
 await expect.poll(async()=>(await (await page.request.get(`${peer}/api/jobs/${jobId}`)).json()).status,{timeout:30000}).toBe('completed');
 const job=await (await page.request.get(`${peer}/api/jobs/${jobId}`)).json() as {planId:string};
 const plan=await (await page.request.get(`${peer}/api/plans/${job.planId}?geometry=stored`)).json() as Plan;
 expect(plan.stats.servedOrders).toBe(2);expect(plan.stats.totalOrders).toBe(2);expect(plan.provenance.validation.valid).toBe(true);
 expect(plan.physicalLoading?.mode).toBe(hard?'hard':'disabled');expect(plan.physicalLoading?.status).toBe(hard?'feasible':'not_evaluated');
 expect(plan.physicalLoading?.sourceSha256).toBe(base.physicalLoading?.sourceSha256);
 expect(plan.physicalLoading?.rounds.reduce((n,r)=>n+r.unitCount,0)).toBe(2);
 const chosen=await page.request.post(`/api/scenarios/${scenario.id}/select-plan`,{headers:{...headers,'if-match':`"${scenario.revision}"`},data:{planId:plan.id,selectionVersion:scenario.selectionVersion??0,acknowledgeIncomplete:false}});expect(chosen.status(),await chosen.text()).toBe(200);
 await page.evaluate(({planId,day})=>localStorage.setItem('cursus.manual-workspace.v1:acceptance',JSON.stringify({planId,day})),{planId:plan.id,day:day.id});await page.reload();
 await expect(page.getByText('Served / Total')).toBeVisible();await page.locator('#cursus-status-details > summary').click();
 const evidence=page.getByTestId('loading-evidence');await expect(evidence).toContainText(plan.physicalLoading!.sourceSha256);
 if(axles)await expect(page.getByTestId('axle-loading-status')).toContainText(hard?'Verified':'Not verified');
 if(!hard){
  await expect(evidence).toContainText('Hard loading is disabled');await expect(evidence).toContainText('Not evaluated');
  await page.getByRole('button',{name:'HU',exact:true}).click();await expect(evidence).toContainText('a rakodhatóság nincs igazolva');return;
 }
 await expect(evidence).toContainText('Physical loading verified');
 if(axles){expect(plan.physicalLoading?.mode==='hard'&&plan.physicalLoading.certificate?.version).toBe(2);expect(plan.physicalLoading?.mode==='hard'&&plan.physicalLoading.certificate?.nativeCapabilities?.implemented_capabilities).toContain('axle_loads');}
 for(const [action,version] of [['review',0],['approve',1]] as const){const r=await page.request.post(`${peer}/api/plans/${plan.id}/${action}`,{headers,data:{version,revision:scenario.revision,acknowledgeExceptions:true}});expect(r.status(),await r.text()).toBe(200);}
 const exported=await page.request.get(`/api/plans/${plan.id}/handoff.json?approval=required`);expect(exported.status()).toBe(200);
 const body=await exported.json();expect(body.handoff.status).toBe('Approved');expect(body.handoff.constraints.physicalLoading.certificate.sha256).toBeTruthy();
 // The normal manual UI remains available. Its preview must not claim physical validation.
 await page.getByRole('button',{name:'Manual planning',exact:true}).click();
 const vehicle=plan.vehicles[0]!,trip=vehicle.trips[0]!;
 await page.locator('aside').first().locator('[data-inspect-vehicle]').getByText(vehicle.ref,{exact:true}).click();
 const inspector=page.locator('aside').last();await inspector.getByRole('button',{name:/Trip 1/}).click();await inspector.locator('ol li > button').first().click();
 await page.getByRole('button',{name:'Move to vehicle…',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Manual planning',exact:true});
 await dialog.getByRole('combobox',{name:'Vehicle',exact:true}).selectOption(String(vehicle.id));
 await dialog.getByRole('combobox',{name:'Trip',exact:true}).selectOption(trip.manualTripId??`trip-${trip.index}`);
 await dialog.getByRole('button',{name:'Calculate preview',exact:true}).click();
 await expect(dialog.getByTestId('manual-preview')).toContainText('Physical loading is not verified');
 const published=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/manual-plan'));
 await dialog.getByRole('button',{name:'Save unverified draft',exact:true}).click();const manualResponse=await published;expect(manualResponse.status()).toBe(201);
 const manual=await manualResponse.json() as Plan;await expect(dialog).toHaveCount(0);
 expect(manual.physicalLoading?.status).toBe('stale');expect(manual.provenance.validation.valid).toBe(false);
 await expect(page.getByTestId('loading-evidence')).toContainText('Replan required');
 expect((await page.request.get(`${peer}/api/plans/${manual.id}/handoff.json?approval=required`)).status()).toBe(409);
 expect((await page.request.get(`${peer}/api/plans/${manual.id}/handoff.json`)).status()).toBe(200);
 // Replan through the real button, worker and native executable restores new evidence.
 const replanned=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/solve'));
 await page.getByRole('button',{name:'Replan',exact:true}).click();const accepted=await replanned;expect(accepted.status()).toBe(202);
 const nextJob=await accepted.json() as {jobId:string};
 await expect.poll(async()=>(await (await page.request.get(`${peer}/api/jobs/${nextJob.jobId}`)).json()).status,{timeout:30000}).toBe('completed');
 const done=await (await page.request.get(`/api/jobs/${nextJob.jobId}`)).json() as {planId:string};
 const fresh=await (await page.request.get(`${peer}/api/plans/${done.planId}?geometry=stored`)).json() as Plan;
 expect(fresh.physicalLoading?.status).toBe('feasible');expect(fresh.provenance.validation.valid).toBe(true);
 // Cancellation must terminate physical-loading native work too, with no publication.
 const countProgram="const fs=require('node:fs');let n=0;for(const p of fs.readdirSync('/proc')){if(!/^\\d+$/.test(p))continue;try{if(fs.readlinkSync('/proc/'+p+'/exe').endsWith('/surge_solve'))n++;}catch{}}console.log(n)";
 const nativeCount=()=>['app-a','app-b'].reduce((n,service)=>n+Number(execFileSync(compose![0]!,[...compose!.slice(1),'exec','-T',service,'node','-e',countProgram],{encoding:'utf8',timeout:30000}).trim()),0);
 const beforeCancel=await (await page.request.get('/api/plans')).json() as {id:string}[];
 const cancelSubmit=await page.request.post(`${peer}/api/scenarios/${manual.scenarioId}/solve`,{headers:{...headers,'if-match':`"${manual.scenarioRevision}"`},data:{budgetSec:60,fullBudget:true,referencePlanId:fresh.id}});expect(cancelSubmit.status()).toBe(202);
 const cancelJob=await cancelSubmit.json() as {jobId:string};
 try{
  await expect.poll(nativeCount,{timeout:15000}).toBeGreaterThan(0);
  expect((await page.request.delete(`/api/jobs/${cancelJob.jobId}`,{headers})).status()).toBe(200);
  await expect.poll(async()=>(await (await page.request.get(`${peer}/api/jobs/${cancelJob.jobId}`)).json()).status).toBe('cancelled');
  await expect.poll(nativeCount,{timeout:15000}).toBe(0);
  expect((await (await page.request.get(`${peer}/api/plans`)).json() as {id:string}[]).map(p=>p.id).sort()).toEqual(beforeCancel.map(p=>p.id).sort());
 }finally{await page.request.delete(`/api/jobs/${cancelJob.jobId}`,{headers});}
 // Infeasible facts are a distinct admitted cycle. Native diagnostics must not be guessed by the UI.
 const impossible=fixture(axles?'axle-loading-infeasible-bundle':'loading-infeasible-bundle'),impossibleId=await upload(impossible);
 for(const action of ['validate','admit'])expect((await page.request.post(`/api/import/datasets/${impossibleId}/${action}`,{headers,data:{}})).status()).toBe(200);
 const newScenario=await (await page.request.post('/api/scenarios',{headers,data:{day:axles?'axle-loading-no-fit':'loading-no-fit',label:'Infeasible loading fixture'}})).json() as Scenario;
 const impossibleSubmit=await page.request.post(`/api/scenarios/${newScenario.id}/solve`,{headers:{...headers,'if-match':`"${newScenario.revision}"`},data:{budgetSec:1}});expect(impossibleSubmit.status()).toBe(202);
 const impossibleJob=await impossibleSubmit.json() as {jobId:string};
 await expect.poll(async()=>(await (await page.request.get(`${peer}/api/jobs/${impossibleJob.jobId}`)).json()).status,{timeout:30000}).toBe('completed');
 const impossibleDone=await (await page.request.get(`/api/jobs/${impossibleJob.jobId}`)).json() as {planId:string};
 const impossiblePlan=await (await page.request.get(`/api/plans/${impossibleDone.planId}?geometry=stored`)).json() as Plan;
 expect(impossiblePlan.stats.servedOrders).toBe(0);expect(impossiblePlan.unassigned).toHaveLength(2);
 expect((await page.request.get(`/api/plans/${impossiblePlan.id}/handoff.json?approval=required`)).status()).toBe(409);
 await page.reload();await expect(page.getByText('Served / Total')).toBeVisible();
 await page.keyboard.press('Escape');
 await page.locator('header').getByRole('combobox').click();
 page.once('dialog',dialog=>dialog.accept());
 await page.getByRole('option',{name:axles?/29 October 2026/:/27 October 2026/}).click();
 await page.locator('#cursus-status-details > summary').click();
 if(axles)await expect(page.getByTestId('axle-loading-status')).toContainText('Not verified');
 await expect(page.getByTestId('loading-unassigned')).toContainText('Loading-only checks');
 await expect(page.getByTestId('loading-unassigned')).toContainText('Check physical units');
 await page.getByRole('button',{name:'HU',exact:true}).click();await expect(page.getByTestId('loading-unassigned')).toContainText('Csak rakodási vizsgálat');
});
