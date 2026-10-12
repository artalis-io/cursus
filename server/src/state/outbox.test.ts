import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeliveryError, ResendSender, deliverOne } from './outbox.js';

test('Resend uses a stable provider idempotency key', async () => {
  const original = globalThis.fetch;
  let observed = '';
  globalThis.fetch = async (_url, init) => {
    observed = new Headers(init?.headers).get('Idempotency-Key') ?? '';
    return new Response(JSON.stringify({ id: 'email-1' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const id = await new ResendSender('not-a-real-key').send({ to: ['user@example.test'] }, 'magic-link/challenge-1');
    assert.equal(id, 'email-1'); assert.equal(observed, 'magic-link/challenge-1');
  } finally { globalThis.fetch = original; }
});

test('permanent provider rejection is not retried', async () => {
  const calls: string[] = [];
  const store = {
    claimEmail: async () => ({ tenantId: 't', id: 'e', owner: 'w', fence: 1, payload: {}, attempt: 1, idempotencyKey: 'key', createdAt: new Date() }),
    emailSent: async () => calls.push('sent'), emailRetry: async () => calls.push('retry'), emailFailed: async () => calls.push('failed'),
  };
  const sender = { send: async () => { throw new DeliveryError('bad request', false); } };
  assert.equal(await deliverOne(store as never, sender, 'w'), true);
  assert.deepEqual(calls, ['failed']);
});

test('ambiguous delivery is retried against the same persisted intent', async () => {
  const calls: unknown[][] = [];
  const lease = { tenantId: 't', id: 'e', owner: 'w', fence: 4, payload: { stable: true }, attempt: 2, idempotencyKey: 'magic-link/stable', createdAt: new Date() };
  const store = { claimEmail: async () => lease, emailSent: async () => {}, emailFailed: async () => {},
    emailRetry: async (...args: unknown[]) => { calls.push(args); } };
  const sender = { send: async () => { throw new TypeError('network result unknown'); } };
  await deliverOne(store as never, sender, 'w');
  assert.equal(calls.length, 1); assert.equal(calls[0]![0], lease);
});
