import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SageClient } from './sage.js';
import { createStatefulApi } from './state/api.js';
import type { StatefulStore } from './state/postgres.js';
import type { StatefulAuthService } from './state/auth.js';
import type { Plan } from './types.js';

test('stateful summaries: scoped facts, auth, languages, provider failures, timeout, capacity and recovery', async () => {
  let mode = 'ok';
  const prompts: { model: string; messages: { content: string }[]; max_tokens: number }[] = [];
  let started: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/models') { res.writeHead(mode === 'error' ? 503 : 200).end('{}'); return; }
    let body = ''; for await (const part of req) body += part;
    prompts.push(JSON.parse(body)); started?.();
    if (mode === 'slow') return; // timeout must release capacity even without response headers
    if (mode === 'body-slow') { res.writeHead(200); res.flushHeaders(); return; }
    if (mode === 'disconnect') { req.socket.destroy(); return; }
    if (mode === 'error') { res.writeHead(502).end('PRIVATE PROVIDER DETAILS'); return; }
    res.setHeader('content-type', 'application/json');
    if (mode === 'invalid') { res.end('not json'); return; }
    res.end(JSON.stringify({ choices: [{ message: { content: mode === 'empty' ? ' ' : ' Grounded summary. ' } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const sage = new SageClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'fixture-model', 500);
  const plan = { id: 'ours', day: '2026-05-06', source: 'saved', stats: { servedOrders: 7, totalOrders: 8,
    vehiclesUsed: 2, trips: 3, deliveryStops: 7, totalDistanceKm: 123, solveElapsedSeconds: null },
    provenance: { termination: 'SAVED', validation: { valid: true, violations: [] } }, vehicles: [], unassigned: [], cost: null } as unknown as Plan;
  const lookups: string[] = [];
  const store = { ensureTenant: async () => {}, getPlan: async (tenant: string, id: string) => {
    lookups.push(tenant); return tenant === 'ours' && id === 'ours' ? plan : null;
  } } as unknown as StatefulStore;
  const auth = { initialize: async () => {}, authenticate: async (cookie: string) => cookie === 'valid' ? { tenantId: 'ours' } : cookie === 'foreign' ? { tenantId: 'foreign' } : null } as unknown as StatefulAuthService;
  const app = await createStatefulApi({ store, auth, tenantId: 'ours', tenantName: 'Ours', publicOrigin: 'https://example.test', sage });
  const headers = { cookie: 'cursus_session=valid', origin: 'https://example.test' };
  const post = (url = '/api/plans/ours/narrate', lang = 'en') => app.inject({ method: 'POST', url, headers, payload: { lang } });
  try {
    for (const url of ['/api/plans/ours/narrate', '/api/compare/narrate?base=ours&revised=ours']) {
      assert.equal((await app.inject({ method: 'POST', url, payload: { lang: 'en' } })).statusCode, 401);
      assert.equal((await app.inject({ method: 'POST', url, headers: { cookie: headers.cookie }, payload: {} })).statusCode, 403);
    }
    assert.equal((await app.inject({ url: '/api/sage/status' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/plans/ours/narrate', headers: { ...headers, cookie: 'cursus_session=foreign' }, payload: {} })).statusCode, 401);
    assert.deepEqual((await app.inject({ url: '/api/sage/status', headers })).json(), { reachable: true, model: 'fixture-model' });
    for (const url of ['/api/plans/foreign/narrate', '/api/compare/narrate?base=ours&revised=foreign', '/api/compare/narrate?base=foreign&revised=ours', '/api/compare/narrate'])
      assert.equal((await post(url)).statusCode, 404);
    assert.equal(prompts.length, 0, 'foreign and missing plans never reach inference');
    assert.equal((await post(undefined, 'de')).statusCode, 400);
    const success = await post();
    assert.equal(success.statusCode, 200);
    assert.equal(success.headers['cache-control'], 'private, no-store');
    assert.deepEqual(success.json(), { text: 'Grounded summary.' });
    assert.match(prompts[0]!.messages[1]!.content, /Orders served: 7 of 8/);
    assert.equal(prompts[0]!.model, 'fixture-model'); assert.equal(prompts[0]!.max_tokens, 400);
    assert.equal((await post('/api/compare/narrate?base=ours&revised=ours', 'hu')).statusCode, 200);
    assert.match(prompts.at(-1)!.messages[0]!.content, /Hungarian/);
    assert.match(prompts.at(-1)!.messages[0]!.content, /fewer orders are served/);
    mode = 'error';
    assert.equal((await app.inject({ url: '/api/sage/status', headers })).json().reachable, false);
    for (mode of ['error', 'empty', 'invalid', 'disconnect', 'body-slow']) {
      const failed = await post();
      assert.equal(failed.statusCode, 503);
      assert.deepEqual(failed.json(), { error: 'summary service unavailable; retry later', unavailable: true });
    }
    mode = 'slow';
    const pendingStarted = new Promise<void>(resolve => { started = resolve; });
    const pending = post();
    await pendingStarted;
    const busy = await post();
    assert.equal(busy.statusCode, 429); assert.equal(busy.headers['retry-after'], '2');
    assert.equal((await pending).statusCode, 503);
    mode = 'ok'; started = undefined;
    assert.equal((await post()).statusCode, 200, 'timeout releases the inference slot');
    assert.ok(lookups.every(tenant => tenant === 'ours'));
  } finally {
    await app.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
