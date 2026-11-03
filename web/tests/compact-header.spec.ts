import {test,expect} from '@playwright/test';
import {publicWorkspace} from './public-workspace';
import {compactHeaderChecks,dismissPolicyChecks} from './compact-header';

test('compact header keeps desktop context and commands on one row with reachable responsive menus',async({page})=>{
 await publicWorkspace(page);await compactHeaderChecks(page);
});
test('settings notice dismissal preserves revalidation and resets for a different plan',async({page})=>{
 await publicWorkspace(page,true);await dismissPolicyChecks(page);
 const notice=page.getByTestId('policy-notice');await notice.getByRole('button',{name:'Dismiss settings notice'}).click();
 await page.locator('header').getByRole('combobox').click();await page.getByRole('option',{name:/146 orders/}).click();
 await expect(notice).toBeVisible();await expect(page.getByText('Revalidation required',{exact:true})).toBeVisible();
});
