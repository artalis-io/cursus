import {test,expect} from '@playwright/test';
import {publicWorkspace} from '../tests/public-workspace';

test('loading facts remain explicitly unverified, round-scoped, bounded and bilingual',async({page})=>{
 const {plan}=await publicWorkspace(page);
 const data={sourceSha256:'c'.repeat(64),datasetSha256:'a'.repeat(64),mode:'disabled',status:'not_evaluated',rounds:[{vehicleId:plan.vehicles[0]!.id,tripIndex:0,unitCount:2,status:'not_evaluated'}]};
 await page.route('**/api/plans/'+plan.id+'*',route=>route.fulfill({json:{...plan,physicalLoading:data}}));await page.reload();
 await page.locator('#cursus-status-details > summary').click();
 const evidence=page.getByTestId('loading-evidence');await expect(evidence).toContainText('Hard loading is disabled');await expect(evidence).toContainText('Round 1 · 2 units · Not evaluated');
 await expect(evidence).toContainText(data.sourceSha256);
 expect(await evidence.evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);
 await page.getByRole('button',{name:'HU',exact:true}).click();await expect(evidence).toContainText('a rakodhatóság nincs igazolva');await expect(evidence).toContainText('Kör 1 · 2 egység · Nem ellenőrzött');
});
test('legacy plans do not infer physical feasibility from pallet quantities',async({page})=>{
 await publicWorkspace(page);await page.locator('#cursus-status-details > summary').click();await expect(page.getByTestId('loading-evidence')).toContainText('Pallet equivalents do not prove loading feasibility');
});
