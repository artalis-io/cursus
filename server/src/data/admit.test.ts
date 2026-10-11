import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hhmmToSec, dateToIso } from './admit.js';
import { isRoutableOrder } from './registry.js';

test('hhmmToSec: parses HH:MM to seconds from midnight', () => {
  assert.equal(hhmmToSec('08:00'), 8 * 3600);
  assert.equal(hhmmToSec('7:30'), 7 * 3600 + 1800);
  assert.equal(hhmmToSec(''), null);
  assert.equal(hhmmToSec('nope'), null);
  assert.equal(hhmmToSec(undefined), null);
});

test('dateToIso: M/D/YY tokens and ISO passthrough', () => {
  assert.equal(dateToIso('5/6/26'), '2026-05-06');
  assert.equal(dateToIso('12/31/25'), '2025-12-31');
  assert.equal(dateToIso('2026-05-06'), '2026-05-06');
});

test('isRoutableOrder: Hungary + GREEN/YELLOW + coords', () => {
  const ok = { lat: 47.5, lon: 19.0, geo_tier: 'GREEN', geo_cc: 'HU' };
  assert.equal(isRoutableOrder(ok), true);
  assert.equal(isRoutableOrder({ ...ok, geo_tier: 'YELLOW' }), true);
  assert.equal(isRoutableOrder({ ...ok, geo_cc: 'RO' }), false);  // off-graph country
  assert.equal(isRoutableOrder({ ...ok, geo_tier: 'APPROX' }), false);
  assert.equal(isRoutableOrder({ ...ok, lat: undefined }), false); // no coords
});
