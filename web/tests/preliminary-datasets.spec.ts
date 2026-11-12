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
