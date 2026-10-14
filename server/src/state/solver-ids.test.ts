import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeSolveRequest } from './solver-ids.js';
import type { SurgeRequest, SurgeSolution } from '../types.js';

test('native IDs survive day filtering, fleet exclusion, pins, and locked sequences', () => {
  const request = {
    vehicles: [{ id: 2, ref: 'A' }, { id: 7, ref: 'B' }], tasks: [{ id: 0 }, { id: 1 }, { id: 2 }],
    requests: [{ id: 12, delivery_task_id: 2, allowed_vehicles: [7], forbidden_vehicles: [2, 9] },
      { id: 40, delivery_task_id: 1, allowed_vehicles: [7] }],
    precedences: [{ before: 12, after: 40 }],
    initial_routes: [{ vehicle_id: 9, request_ids: [12] }, { vehicle_id: 7, request_ids: [12, 30, 40] }],
    frozen_requests: [12, 30], committed_requests: [40],
  } as unknown as SurgeRequest;
  const original = structuredClone(request);
  const native = nativeSolveRequest(request);
  assert.deepEqual(native.request.requests[0], { id: 0, delivery_task_id: 2, allowed_vehicles: [1], forbidden_vehicles: [0] });
  assert.deepEqual(native.request.precedences, [{ before: 0, after: 1 }]);
  const extra = native.request as unknown as Record<string, unknown>;
  assert.deepEqual(extra.initial_routes, [{ vehicle_id: 1, request_ids: [0, 1] }]);
  assert.deepEqual(extra.frozen_requests, [0]);
  assert.deepEqual(extra.committed_requests, [1]);
  const restored = native.restore({ status: 'OK', stats: {}, unassigned: [1],
    routes: [{ vehicle_id: 1, stops: [{ request_id: 0, task_id: 2 }] }] } as SurgeSolution);
  assert.equal(restored.routes[0]!.vehicle_id, 7);
  assert.equal(restored.routes[0]!.stops[0]!.request_id, 12);
  assert.deepEqual(restored.unassigned, [40]);
  assert.deepEqual(request, original, 'translation must not mutate authoritative IDs');
});

test('edited stop sequences seed native construction using compact IDs', () => {
  const request = { vehicles: [{ id: 7 }], tasks: [{ id: 4, ref: 'A' }, { id: 8, ref: 'B' }],
    requests: [{ id: 12, delivery_task_id: 4 }, { id: 40, delivery_task_id: 8 }] } as unknown as SurgeRequest;
  const native = nativeSolveRequest(request, [{ vehicleId: 7, orderNos: ['B', 'A'], locked: true }]);
  assert.deepEqual((native.request as unknown as Record<string, unknown>).initial_routes,
    [{ vehicle_id: 0, request_ids: [1, 0] }]);
  assert.equal(native.request.requests[0]!.delivery_task_id, 0);
  assert.equal(native.request.requests[1]!.delivery_task_id, 1);
});
