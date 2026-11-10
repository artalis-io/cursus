import {workspaceBookmarkKey} from '../src/lib/workspace-resume';
import {expect,type Page} from '@playwright/test';

export async function openWorkspaceMenu(page:Page,label:string){
 const trigger=page.getByRole('navigation',{name:/^(Workspace tools|Munkaterület eszközei)$/}).getByRole('button',{name:label,exact:true});
 if(await trigger.getAttribute('aria-expanded')!=='true')await trigger.click();
 await expect(page.getByRole('menu',{name:label,exact:true})).toBeVisible();
 return page.getByRole('menu',{name:label,exact:true});
}
export async function workspaceAction(page:Page,label:string){
 const groups:Record<string,string>={Data:'Prepare','Planning profiles':'Prepare','Update input snapshot':'Prepare',Issues:'Plan',Changes:'Plan',Compare:'Plan','Reset to baseline':'Plan',Scenarios:'Library',Plans:'Library',Week:'Library','Acknowledged handoff':'Review & release','Plan approval':'Review & release'};
 const group=groups[label];if(!group)throw Error(`Unknown workspace action: ${label}`);
 const menu=await openWorkspaceMenu(page,group);
 return menu.getByRole('menuitem',{name:label,exact:true});
}
export async function selectWorkspaceAction(page:Page,label:string){await (await workspaceAction(page,label)).click();}

export async function savedWorkspaceKey(page:Page):Promise<string>{
 const response=await page.request.get('/api/auth/me');expect(response.status()).toBe(200);
 const me=await response.json() as {tenantId:string;userId?:string;email:string};
 const key=workspaceBookmarkKey(me.tenantId,me.userId??me.email);
 if(!key)throw Error('Acceptance identity must have a scoped workspace key');
 return key;
}
