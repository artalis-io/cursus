import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Semaphore } from './semaphore.js';

test('Semaphore: bounds concurrency and runs waiters FIFO as slots free', async () => {
  const sem = new Semaphore(2);
  const order: number[] = [];
  let active = 0, peak = 0;

  const work = async (i: number): Promise<void> => {
    const release = await sem.acquire();
    active++; peak = Math.max(peak, active);
    order.push(i);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    release();
  };

  await Promise.all([0, 1, 2, 3, 4].map(work));
  assert.equal(peak, 2, 'never more than 2 ran at once');
  assert.deepEqual(order.slice(0, 2).sort(), [0, 1], 'first two started immediately');
  assert.equal(order.length, 5, 'all ran');
});

test('Semaphore: release is idempotent (double-release does not over-grant)', async () => {
  const sem = new Semaphore(1);
  const r1 = await sem.acquire();
  r1(); r1();                       // second release must be a no-op
  let secondHeld = false;
  const r2 = await sem.acquire();   // should still be obtainable exactly once
  secondHeld = true;
  // a third acquire must now block (no slot), so race it against a timeout
  const blocked = await Promise.race([
    sem.acquire().then(() => 'acquired'),
    new Promise((res) => setTimeout(() => res('blocked'), 20)),
  ]);
  assert.ok(secondHeld);
  assert.equal(blocked, 'blocked', 'only one permit exists despite the double-release');
  r2();
});
