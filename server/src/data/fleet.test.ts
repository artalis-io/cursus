import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toSurgeFleet, DEFAULT_CAP_KG, DEFAULT_CAP_PLT } from './fleet.js';

test('toSurgeFleet: maps canonical vehicles to a 0-indexed single-depot fleet', () => {
  const f = toSurgeFleet([
    { id: 'RIC-124', capacity_kg: 24000, capacity_pallets: 33 },
    { id: 'AACV-646', capacity_kg: 14000, capacity_pallets: 17 },
  ]);
  assert.equal(f.count, 2);
  assert.equal(f.defaulted, 0);
  assert.deepEqual(f.vehicles[0], { id: 0, ref: 'RIC-124', capacity: [24000, 33], start_depot_id: 0, end_depot_id: 0, fixed_cost: 100000 });
  assert.equal(f.vehicles[1]!.id, 1);          // ids are contiguous from 0
  assert.deepEqual(f.vehicles[1]!.capacity, [14000, 17]);
});

test('toSurgeFleet: rounds capacities and counts rows that fell back to a default', () => {
  const f = toSurgeFleet([
    { id: 'A', capacity_kg: 12500.7, capacity_pallets: 18.4 },  // rounded
    { id: 'B', capacity_kg: 0 },                                 // kg<=0 and no pallets -> both default
    { plate: 'C', capacity_pallets: 20 },                        // kg missing -> kg default, plt kept
  ]);
  assert.deepEqual(f.vehicles[0]!.capacity, [12501, 18]);
  assert.deepEqual(f.vehicles[1]!.capacity, [DEFAULT_CAP_KG, DEFAULT_CAP_PLT]);
  assert.deepEqual(f.vehicles[2]!.capacity, [DEFAULT_CAP_KG, 20]);
  assert.equal(f.vehicles[2]!.ref, 'C');       // falls back to plate when id absent
  assert.equal(f.defaulted, 2);                // rows B and C each defaulted a dimension
});

test('toSurgeFleet: synthesizes a ref when id and plate are both missing', () => {
  const f = toSurgeFleet([{ capacity_kg: 24000, capacity_pallets: 33 }]);
  assert.equal(f.vehicles[0]!.ref, 'V1');
});
