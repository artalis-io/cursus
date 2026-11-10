import {test,expect} from '@playwright/test';
import {parseWorkspaceBookmark,workspaceBookmarkKey} from '../src/lib/workspace-resume';
test('workspace bookmarks separate users, tenants and ambiguous delimiter pairs',()=>{
 const keys=[workspaceBookmarkKey('a','b:c'),workspaceBookmarkKey('a:b','c'),workspaceBookmarkKey('a','c'),workspaceBookmarkKey('other','c')];
 expect(new Set(keys).size).toBe(4);
 expect(workspaceBookmarkKey(null,'user')).toBeNull();expect(workspaceBookmarkKey('tenant',null)).toBeNull();
});
test('workspace bookmark accepts identifiers only, never cached permissions or approval state',()=>{
 expect(parseWorkspaceBookmark(JSON.stringify({version:1,planId:'native-plan',day:'day2',approved:true,permissions:['admin']}))).toEqual({version:1,planId:'native-plan',day:'day2'});
});
test('workspace bookmark ignores malformed, legacy and oversized preferences',()=>{
 for(const raw of [null,'undefined','{}','[]','null','{"version":2,"planId":"x","day":"d"}',JSON.stringify({version:1,planId:[],day:'d'}),JSON.stringify({version:1,planId:'',day:'d'}),JSON.stringify({version:1,planId:'x\n',day:'d'}),'x'.repeat(5000)])expect(parseWorkspaceBookmark(raw)).toBeNull();
});
