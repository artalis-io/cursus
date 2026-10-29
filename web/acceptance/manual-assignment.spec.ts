import { test, expect } from '@playwright/test';
import { manualAssignmentCommands } from '../src/lib/manual-assignment';
import { applyManualBatch, type ManualLayout } from '../../server/src/plan/manual';
import { selectedUnassigned } from '../src/lib/unassigned-selection';
import type { Plan } from '../src/types';
import { deliveryToken, deliveryReference } from '../src/lib/dnd';
import {selectedStop} from '../src/lib/stop-selection';

test('stop selection is bound to delivery and plan identity rather than a previous preview position',()=>{
  const stops=[{requestId:130,seq:1,orderNo:'REPEATED'},{requestId:170,seq:2,orderNo:'REPEATED'}] as Plan['vehicles'][number]['trips'][number]['stops'];
  const selection={kind:'stop' as const,vehicleId:10,tripIndex:0,seq:1,requestId:170,planId:'current'};
  expect(selectedStop(stops,selection,'current')?.requestId).toBe(170);
  expect(selectedStop(stops,selection,'another-plan')).toBeUndefined();
  expect(selectedStop(stops,{...selection,requestId:999},'current')).toBeUndefined();
  expect(selectedStop(stops,{kind:'stop',vehicleId:10,tripIndex:0,seq:1},'current')?.requestId).toBe(130);
});

test('delivery drag tokens round-trip duplicate and reserved references without losing identity',()=>{
  for(const orderNo of ['REPEATED','@delivery:12:other','@ref:encoded','Árvíz / % : "']){
    expect(deliveryReference(deliveryToken(orderNo))).toEqual({orderNo});
    for(const requestId of [0,91,92])expect(deliveryReference(deliveryToken(orderNo,requestId))).toEqual({orderNo,requestId});
  }
  expect(deliveryToken('REPEATED',91)).not.toBe(deliveryToken('REPEATED',92));
  expect(()=>deliveryReference('@delivery:9007199254740992:x')).toThrow();
  expect(()=>deliveryReference('@delivery:-1:x')).toThrow();
});

test('unassigned selections retain request identity when historical display references repeat',()=>{
  const orders:Plan['unassigned']=[1,2].map(requestId=>({requestId,orderNo:'REPEATED',orderId:null,customer:null,city:null,lon:null,lat:null,reason:null,reasonCode:null}));
  expect(selectedUnassigned(orders,{kind:'unassigned',orderNo:'REPEATED',requestId:2})?.requestId).toBe(2);
  expect(selectedUnassigned(orders,{kind:'unassigned',orderNo:'REPEATED'})).toBeUndefined();
  expect(selectedUnassigned(orders,{kind:'unassigned',orderNo:'REPEATED',requestId:99})).toBeUndefined();
  expect(selectedUnassigned(orders.slice(0,1),{kind:'unassigned',orderNo:'REPEATED'})?.requestId).toBe(1);
});

test('manual bulk insertion uses the selected order after removal, including same-trip moves', () => {
  const original = [1, 2, 3, 4];
  for (let mask = 1; mask < 16; mask++) {
    const selection = original.filter(id => mask & (1 << (id - 1)));
    for (const selected of [selection, [...selection].reverse()]) {
      const remaining = original.filter(id => !selected.includes(id));
      for (let position = 0; position <= remaining.length; position++) {
        const layout: ManualLayout = { datasetSha256: 'a'.repeat(64), requestIds: original,
          vehicleIds: [7], routes: [{vehicleId: 7, tripId: 'trip', requestIds: original}],
          excludedVehicleIds: [], lockedVehicleIds: [], unassigned: [], decisions: {}, origins: {}, history: [] };
        const before = structuredClone(layout);
        const commands = manualAssignmentCommands(selected, 7, 'trip', original, position);
        const next = applyManualBatch(layout, {operationId: 'move', datasetSha256: layout.datasetSha256, commands},
          {actorId: 'planner', at: '2026-10-27T00:00:00Z'});
        expect(next.routes[0].requestIds).toEqual([...remaining.slice(0, position), ...selected, ...remaining.slice(position)]);
        expect(next.history).toHaveLength(selected.length);
        expect(layout).toEqual(before);
      }
    }
  }
});

test('manual insertion handles mixed source trips and unassigned deliveries without losing work', () => {
  const commands = manualAssignmentCommands([2, 5, 6], 7, 'target', [1, 2, 3, 4], 1);
  const layout: ManualLayout = { datasetSha256: 'a'.repeat(64), requestIds: [1,2,3,4,5,6], vehicleIds: [7,8],
    routes: [{vehicleId:7, tripId:'target', requestIds:[1,2,3,4]}, {vehicleId:8, tripId:'source', requestIds:[5]}],
    unassigned:[6], excludedVehicleIds:[], lockedVehicleIds:[], decisions:{}, origins:{}, history:[] };
  const next = applyManualBatch(layout, {operationId:'mixed', datasetSha256:layout.datasetSha256, commands},
    {actorId:'planner', at:'2026-10-27T00:00:00Z'});
  expect(next.routes).toEqual([{vehicleId:7, tripId:'target', requestIds:[1,2,5,6,3,4]}]);
  expect(next.unassigned).toEqual([]);
  expect(() => manualAssignmentCommands([2,2],7,'target',[1,2],0)).toThrow();
  expect(() => manualAssignmentCommands([2],7,'target',[1,2],2)).toThrow();
});
