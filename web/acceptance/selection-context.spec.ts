import {test,expect} from '@playwright/test';
import type {Plan,Vehicle} from '../src/types';
import {selectionContext} from '../src/lib/selection-context';
const plan={id:'plan-a',vehicles:[{id:7,ref:'A',trips:[{index:0,stops:[{requestId:101,orderNo:'DUP',seq:1},{requestId:103,orderNo:'DUP',seq:2}]}]},{id:17,ref:'B',trips:[{index:0,stops:[{requestId:107,orderNo:'OTHER',seq:1}]}]}],unassigned:[{requestId:113,orderNo:'DUP'},{requestId:127,orderNo:'DUP'}]} as unknown as Plan;
test('selection: equal trip indexes on different vehicles and duplicate labels retain exact identities',()=>{
 expect(selectionContext(plan,{kind:'trip',vehicleId:17,tripIndex:0})).toMatchObject({kind:'trip',vehicle:{id:17},trip:{index:0}});
 expect(selectionContext(plan,{kind:'stop',vehicleId:7,tripIndex:0,seq:1,requestId:103,planId:plan.id})).toMatchObject({kind:'stop',vehicle:{id:7},order:{requestId:103,seq:2}});
 expect(selectionContext(plan,{kind:'unassigned',orderNo:'DUP',requestId:127})).toMatchObject({kind:'unassigned',order:{requestId:127}});
});
test('selection: stale plans, missing deliveries, ambiguous labels and wrong parent contexts fail closed',()=>{
 for(const selection of [{kind:'stop',vehicleId:7,tripIndex:0,seq:1,requestId:101,planId:'old-plan'} as const,{kind:'stop',vehicleId:17,tripIndex:0,seq:1,requestId:101} as const,{kind:'stop',vehicleId:7,tripIndex:0,seq:1,requestId:999} as const,{kind:'trip',vehicleId:7,tripIndex:999} as const,{kind:'unassigned',orderNo:'DUP'} as const,{kind:'unassigned',orderNo:'OTHER',requestId:113} as const])expect(selectionContext(plan,selection)).toBeNull();
 expect(selectionContext(plan,null)).toBeNull();
});
test('selection: an available fleet vehicle can be inspected without inventing routes or changing saved plan metrics',()=>{
 const before=structuredClone(plan),available={id:31,ref:'Available',trips:[]} as unknown as Vehicle;
 expect(selectionContext(plan,{kind:'vehicle',vehicleId:31})).toBeNull();
 expect(selectionContext(plan,{kind:'vehicle',vehicleId:31},[...plan.vehicles,available])).toEqual({kind:'vehicle',vehicle:available});
 expect(selectionContext(plan,{kind:'trip',vehicleId:31,tripIndex:0},[available])).toBeNull();expect(plan).toEqual(before);
});
