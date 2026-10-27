import { test, expect } from '@playwright/test';
import { manualAssignmentCommands } from '../src/lib/manual-assignment';
import { applyManualBatch, type ManualLayout } from '../../server/src/plan/manual';

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
