import {test,expect} from '@playwright/test';
import type {PlanSummary} from '../src/lib/api';
import {matchesPlan,verifiedIdentity} from '../src/lib/library-identity';
const plan:PlanSummary={id:'plan-one',scenarioId:'scenario-one',day:'day-one',label:'Árvíztűrő próba',source:'live',createdAt:'2026-05-06T10:00:00Z',termination:'OK',servedOrders:1,totalOrders:1,vehiclesUsed:1,totalDistanceKm:10,
 identity:{version:1,planId:'plan-one',scenarioId:'scenario-one',planRevision:2,scenarioRevision:2,approval:'approved',freshness:'current',latest:false,selected:true,checkedAt:'2026-05-06T10:00:01Z',planSha256:'a'.repeat(64)}};
test('library search matches accents, casing and exact opaque plan/scenario references',()=>{
 for(const q of ['arvizturo','PRÓBA','PLAN-ONE','scenario-one','  plan-one  '])expect(matchesPlan(plan,q)).toBe(true);
 expect(matchesPlan(plan,'plan-two')).toBe(false);
});
test('library evidence cannot certify an unrelated result or an unavailable/corrupt response',()=>{
 expect(verifiedIdentity(plan,true)?.approval).toBe('approved');expect(verifiedIdentity(plan,false)).toBeNull();
 for(const patch of [{planId:'other'},{scenarioId:'foreign'},{planRevision:1},{freshness:'stale'},{checkedAt:'bad'},{planSha256:null},{approval:'bogus'}])expect(verifiedIdentity({...plan,identity:{...plan.identity!,...patch}} as PlanSummary,true)).toBeNull();
 expect(verifiedIdentity({...plan,identity:undefined},true)).toBeNull();
 expect(verifiedIdentity({...plan,identity:{...plan.identity!,approval:'unknown',freshness:'unknown',planSha256:null}},true)?.approval).toBe('unknown');
});
