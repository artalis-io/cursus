import {test,expect} from '@playwright/test';
import {publicWorkspace} from '../tests/public-workspace';

test('loading facts remain explicitly unverified, round-scoped, bounded and bilingual',async({page})=>{
 const {plan}=await publicWorkspace(page);
 const data={sourceSha256:'c'.repeat(64),datasetSha256:'a'.repeat(64),mode:'disabled',status:'not_evaluated',rounds:[{vehicleId:plan.vehicles[0]!.id,tripIndex:0,unitCount:2,status:'not_evaluated'}]};
 await page.route(url=>url.pathname==='/api/plans/'+plan.id,route=>route.fulfill({json:{...plan,physicalLoading:data}}));await page.reload();
 await page.locator('#cursus-status-details > summary').click();
 const evidence=page.getByTestId('loading-evidence');await expect(evidence).toContainText('Hard loading is disabled');await expect(evidence).toContainText('Round 1 · 2 units · Not evaluated');
 await expect(evidence).toContainText(data.sourceSha256);
 expect(await evidence.evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);
 await page.getByRole('button',{name:'HU',exact:true}).click();await expect(evidence).toContainText('a rakodhatóság nincs igazolva');await expect(evidence).toContainText('Kör 1 · 2 egység · Nem ellenőrzött');
});
test('legacy plans do not infer physical feasibility from pallet quantities',async({page})=>{
 await publicWorkspace(page);await page.locator('#cursus-status-details > summary').click();await expect(page.getByTestId('loading-evidence')).toContainText('Pallet equivalents do not prove loading feasibility');
});

test('hard loading stays unconfirmed until the matching authoritative check succeeds, then fails closed on drift',async({page})=>{
 const {plan}=await publicWorkspace(page);let unavailable=true,changed=false;
 const data={sourceSha256:'c'.repeat(64),datasetSha256:'a'.repeat(64),mode:'hard',status:'feasible',rounds:[{vehicleId:plan.vehicles[0]!.id,tripIndex:0,unitCount:2,status:'feasible'}],
  certificate:{version:1,planId:plan.id,scenarioId:plan.scenarioId,scenarioRevision:plan.scenarioRevision,result:{mode:'hard',rounds:[],unassigned_checks:[]}}};
 await page.route(url=>url.pathname==='/api/plans/'+plan.id||url.pathname==='/api/plans/'+plan.id+'/workflow',route=>{
  if(new URL(route.request().url()).pathname.endsWith('/workflow'))return unavailable?route.fulfill({status:503,json:{error:'Unavailable'}}):route.fulfill({json:{state:'draft',version:0,currentRevision:1,scenarioRevision:1,planSha256:'a'.repeat(64),actor:null,at:null,blockers:changed?['Physical loading: source changed; Replan required']:[]}});
  return route.fulfill({json:{...plan,physicalLoading:data}});
 });
 await page.reload();await page.locator('#cursus-status-details > summary').click();const evidence=page.getByTestId('loading-evidence');
 await expect(evidence).toContainText('not yet confirmed');await expect(evidence).not.toContainText('Physical loading verified');
 unavailable=false;
 // Polling may recover between enabling the fixture and the pointer action.
 // A vanished Retry control is valid only after authoritative verification.
 await page.getByRole('button',{name:'Retry approval status',exact:true}).click({timeout:2000}).catch(async()=>{await expect(evidence).toContainText('Physical loading verified');});await expect(evidence).toContainText('Physical loading verified');
 changed=true;await expect(evidence).toContainText('Replan required',{timeout:10000});await expect(evidence).not.toContainText('Physical loading verified');
 await page.getByRole('button',{name:'HU',exact:true}).click();await expect(evidence).toContainText('Újratervezés szükséges');
});
test('malformed physical certificates never crash the workspace or display Verified',async({page})=>{
 const {plan}=await publicWorkspace(page);
 await page.route(url=>url.pathname==='/api/plans/'+plan.id||url.pathname==='/api/plans/'+plan.id+'/workflow',route=>{
  if(new URL(route.request().url()).pathname.endsWith('/workflow'))return route.fulfill({json:{state:'draft',version:0,currentRevision:1,scenarioRevision:1,planSha256:'a'.repeat(64),actor:null,at:null,blockers:['Physical loading: invalid certificate']}});
  return route.fulfill({json:{...plan,physicalLoading:{mode:'hard',status:'feasible',sourceSha256:'c'.repeat(64),rounds:[],certificate:{}}}});
 });
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));await page.reload();await page.locator('#cursus-status-details > summary').click();
 await expect(page.getByTestId('loading-evidence')).toContainText('Replan required');expect(errors).toEqual([]);
 await expect(page.getByTestId('loading-evidence')).not.toContainText('Physical loading verified');
});

test('axle status needs V2 evidence and authoritative confirmation, and invalidates in EN/HU',async({page})=>{
 const {plan}=await publicWorkspace(page);let ready=false,changed=false;
 const data={sourceSha256:'c'.repeat(64),datasetSha256:'a'.repeat(64),mode:'hard',status:'feasible',requiredCapabilities:['stacking','axle_loads'],rounds:[{vehicleId:plan.vehicles[0]!.id,tripIndex:0,unitCount:2,status:'feasible'}],
  certificate:{version:2,requiredCapabilities:['stacking','axle_loads'],planId:plan.id,scenarioId:plan.scenarioId,scenarioRevision:plan.scenarioRevision,result:{version:2,mode:'hard',rounds:[],unassigned_checks:[]}}};
 await page.route(url=>url.pathname==='/api/plans/'+plan.id||url.pathname==='/api/plans/'+plan.id+'/workflow',route=>{
  if(new URL(route.request().url()).pathname.endsWith('/workflow'))return ready?route.fulfill({json:{state:'draft',version:0,currentRevision:plan.scenarioRevision,scenarioRevision:plan.scenarioRevision,planSha256:'a'.repeat(64),actor:null,at:null,blockers:changed?['Physical loading: axle source changed; Replan required']:[]}}):route.fulfill({status:503,json:{error:'Unavailable'}});
  return route.fulfill({json:{...plan,physicalLoading:data}});
 });
 await page.reload();await page.locator('#cursus-status-details > summary').click();
 const status=page.getByTestId('axle-loading-status');await expect(status).toHaveText('Axle loads · Not verified');
 ready=true;await page.getByRole('button',{name:'Retry approval status',exact:true}).click({timeout:2000}).catch(async()=>{await expect(status).toHaveText('Axle loads · Verified');});await expect(status).toHaveText('Axle loads · Verified');
 changed=true;await expect(status).toHaveText('Axle loads · Not verified',{timeout:10000});
 await page.getByRole('button',{name:'HU',exact:true}).click();await expect(status).toHaveText('Tengelyterhelések · Nem ellenőrzött');
});
