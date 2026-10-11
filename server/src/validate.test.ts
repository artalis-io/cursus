import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateScenarioEdit } from './store.js';

test('validateScenarioEdit: accepts well-formed edits', () => {
  assert.equal(validateScenarioEdit({ op: 'removeVehicle', vehicleId: 3 }), null);
  assert.equal(validateScenarioEdit({ op: 'pin', orderNo: '756070', vehicleId: 1 }), null);
  assert.equal(validateScenarioEdit({ op: 'unpin', orderNo: '756070' }), null);
  assert.equal(validateScenarioEdit({ op: 'clearOverrides' }), null);
  assert.equal(validateScenarioEdit({ op: 'setVehicleConstraint', vehicleId: 2, patch: { capacityKg: 9000, maxTrips: 3 } }), null);
  assert.equal(validateScenarioEdit({ op: 'setVehicleConstraint', vehicleId: 2, patch: { capacityKg: null } }), null); // clearing
});

test('validateScenarioEdit: rejects malformed / out-of-range edits', () => {
  assert.ok(validateScenarioEdit(null));
  assert.ok(validateScenarioEdit({ op: 'bogus' }));
  assert.ok(validateScenarioEdit({ op: 'removeVehicle', vehicleId: -1 }));
  assert.ok(validateScenarioEdit({ op: 'removeVehicle', vehicleId: 1.5 }));
  assert.ok(validateScenarioEdit({ op: 'pin', orderNo: '', vehicleId: 1 }));
  assert.ok(validateScenarioEdit({ op: 'pin', orderNo: 'x', vehicleId: 'nope' }));
  assert.ok(validateScenarioEdit({ op: 'setVehicleConstraint', vehicleId: 1, patch: { capacityKg: -5 } }));
  assert.ok(validateScenarioEdit({ op: 'setVehicleConstraint', vehicleId: 1, patch: { maxTrips: 999 } }));
  assert.ok(validateScenarioEdit({ op: 'setVehicleConstraint', vehicleId: 1, patch: { bogus: 1 } }));
  assert.ok(validateScenarioEdit({ op: 'setVehicleConstraint', vehicleId: 1, patch: { capacityKg: 'big' } }));
});
