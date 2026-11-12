import {test,expect} from '@playwright/test';
import {publicWorkspace} from './public-workspace';

test('legacy display stays unchanged; preliminary evidence and missing cost remain visible in EN/HU',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const f=await publicWorkspace(page);await expect(page.getByTestId('planning-evidence')).toHaveCount(0);
 f.plan.provenance.planningEvidence={version:1,sourceSha256:'b'.repeat(64),pricing:'unverified',issues:[{code:'tariff',message:'Not verified.'},{code:'tail_lift',requestId:91,message:'Unknown.'}]};f.plan.cost=null;
 await page.reload();const banner=page.getByTestId('planning-evidence');await expect(banner).toBeVisible();await expect(banner).toContainText('Approval blocked');
 await expect(page.locator('[data-kpi="cost"] [data-kpi-value]')).toHaveText('—');await expect(page.locator('[data-kpi="served"] [data-kpi-value]')).toHaveText('2 / 2');
 await banner.locator('summary').click();await expect(banner).toContainText('Tail-lift requirement');
 await page.getByRole('button',{name:'HU',exact:true}).click();await expect(banner).toContainText('Jóváhagyás letiltva');await expect(banner).toContainText('Emelőhátfal-igény');expect(errors).toEqual([]);
});

test('inspector shows separated intervals and unknown pallets without widening or displaying zero as fact',async({page})=>{
 const f=await publicWorkspace(page);const stop=f.plan.vehicles[0]!.trips[0]!.stops[0]!;
 stop.timeWindows=[{early:0,late:300},{early:600,late:1200}];stop.twEndSec=1200;stop.requiresTailLift=null;stop.pallets=0;stop.unknownFacts=['pallet_quantity','tail_lift'];
 f.plan.provenance.planningEvidence={version:1,sourceSha256:'b'.repeat(64),pricing:'unverified',issues:[{code:'tariff',message:'Not verified.'},{code:'pallet_quantity',requestId:91,message:'Unknown.'}]};f.plan.cost=null;
 await page.reload();await page.locator('[data-inspect-vehicle]').first().click();await page.locator('#cursus-inspector-pane').getByRole('button',{name:/Trip 1/}).click();
 await page.locator('#cursus-inspector-pane button[data-request-id="91"]').click();
 await expect(page.locator('#cursus-inspector-pane')).toContainText('00:00–00:05 / 00:10–00:20');
 await expect(page.locator('#cursus-inspector-pane')).toContainText('Unknown');await expect(page.locator('#cursus-inspector-pane')).toContainText('Tail-lift requirement');
});

test('preliminary placement guidance displays unavailable prices rather than zero monetary costs',async({page})=>{
 const f=await publicWorkspace(page),vehicle=f.plan.vehicles[0]!;
 f.plan.cost=null;f.plan.stats.totalOrders=3;
 f.plan.unassigned.push({requestId:99,orderNo:'PUBLIC-MISSING',orderId:null,customer:'Public missing delivery',city:null,lon:19,lat:47,reason:null,reasonCode:null});
 f.plan.provenance.planningEvidence={version:1,sourceSha256:'b'.repeat(64),pricing:'unverified',issues:[{code:'tariff',message:'Not verified.'}]};
 await page.route('**/api/plans/*/manual-context',route=>route.fulfill({json:{enabled:true,requiresRevalidation:false,datasetSha256:f.plan.provenance.datasetSha256,fleet:f.plan.vehicles}}));
 await page.route('**/api/scenarios/*/placements',route=>route.fulfill({json:{parentPlanId:f.plan.id,revision:1,datasetSha256:f.plan.provenance.datasetSha256,requestId:99,currency:'HUF',checked:1,complete:true,feasiblePositions:1,baseline:{distanceKm:10,cost:null,served:2,vehicles:1,trips:1},suggestions:[{vehicleId:vehicle.id,tripId:'trip-0',position:0,newTrip:false,serviceStartSec:300,tripEndSec:600,delta:{distanceKm:1,cost:null,vehicles:0,trips:0,finishSec:60}}],vehicles:[]}}));
 await page.reload();await page.getByRole('button',{name:'Manual planning',exact:true}).click();
 const toggle=page.locator('[data-unassigned-toggle]');if(await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();
 await page.locator('[data-unassigned-list]').getByRole('button').filter({hasText:'#PUBLIC-MISSING'}).click();
 await page.getByRole('button',{name:'Assign to vehicle…',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Manual planning',exact:true});await dialog.getByRole('button',{name:'Find feasible placements',exact:true}).click();
 const options=dialog.getByRole('list',{name:'Feasible placements',exact:true});await expect(options).toBeVisible();await expect(options).toContainText('—');await expect(options).not.toContainText(/Ft|HUF/);
 await expect(dialog.getByText(/Compared with the current layout/)).toContainText('—');
});
