import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RateLimiter } from './ratelimit.js';

test('RateLimiter: allows up to burst then blocks', () => {
  let now = 1000;
  const rl = new RateLimiter(10, 3, 100, () => now); // 10 rps, burst 3
  assert.equal(rl.allow('a'), true);
  assert.equal(rl.allow('a'), true);
  assert.equal(rl.allow('a'), true);
  assert.equal(rl.allow('a'), false); // burst exhausted, no time passed
});

test('RateLimiter: refills over time', () => {
  let now = 0;
  const rl = new RateLimiter(10, 2, 100, () => now); // 10 rps -> 1 token / 100ms
  assert.equal(rl.allow('a'), true);
  assert.equal(rl.allow('a'), true);
  assert.equal(rl.allow('a'), false);
  now += 100; // +1 token
  assert.equal(rl.allow('a'), true);
  assert.equal(rl.allow('a'), false);
});

test('RateLimiter: per-key isolation', () => {
  let now = 0;
  const rl = new RateLimiter(1, 1, 100, () => now);
  assert.equal(rl.allow('a'), true);
  assert.equal(rl.allow('a'), false);
  assert.equal(rl.allow('b'), true); // separate bucket
});

test('RateLimiter: bounds the key map (evicts oldest)', () => {
  let now = 0;
  const rl = new RateLimiter(1, 1, 3, () => now);
  for (const k of ['a', 'b', 'c']) { rl.allow(k); now += 10; }
  assert.equal(rl.size, 3);
  rl.allow('d'); // evicts the oldest ('a')
  assert.equal(rl.size, 3);
});
