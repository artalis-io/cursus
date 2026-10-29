import {test,expect} from '@playwright/test';
import {addPlanGeometry} from '../src/lib/plan-geometry';
import type {Plan} from '../src/types';
const plan=()=>({id:'public-plan',scenarioId:'public-scenario',scenarioRevision:1,provenance:{inputSha256:'a'.repeat(64)},stats:{servedOrders:1},
 vehicles:[{id:7,trips:[{index:0,stops:[{requestId:91,orderNo:'PUBLIC',lon:19,lat:47}],geometry:null}]}]}) as unknown as Plan;
test('late roads only add matching geometry and cannot overwrite metrics, decisions or another plan',()=>{
 const current=plan(),roads=plan();roads.stats.servedOrders=999;roads.vehicles[0].trips[0].geometry={type:'LineString',coordinates:[[19,47],[19.1,47.1]]};
 const merged=addPlanGeometry(current,roads);expect(merged.stats).toBe(current.stats);expect(merged.vehicles[0].trips[0].geometry).toEqual(roads.vehicles[0].trips[0].geometry);expect(current.vehicles[0].trips[0].geometry).toBeNull();
 for(const change of [(p:Plan)=>{p.id='other';},(p:Plan)=>{p.scenarioRevision++;},(p:Plan)=>{p.provenance.inputSha256='b'.repeat(64);},
  (p:Plan)=>{p.vehicles[0].trips[0].stops[0].requestId=92;},(p:Plan)=>{p.vehicles[0].trips[0].geometry!.coordinates[0][0]=NaN;}]){
  const changed=structuredClone(roads);change(changed);expect(addPlanGeometry(current,changed)).toBe(current);
 }
});
