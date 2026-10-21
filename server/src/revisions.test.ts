import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { expectedRevision, registerScenarioPreconditions } from './revisions.js';

test('revision headers reject ambiguous, weak, wildcard and unsafe values', () => {
  for (const value of [undefined, '*', 'W/"2"', '2', '"-1"', '"01"', '"1.5"', '"9007199254740992"', ['"2"']])
    assert.equal(expectedRevision({ 'if-match': value }), null);
  assert.equal(expectedRevision({ 'if-match': '"0"' }), 0);
  assert.equal(expectedRevision({ 'if-match': '"42"' }), 42);
});

test('all shared scenario mutations require the client revision before any side effects', async () => {
  const app = Fastify(); let writes = 0;
  registerScenarioPreconditions(app, async id => id === 'known' ? { revision: 3 } : null);
  for (const suffix of ['edit', 'edits', 'rename', 'solve'])
    app.post(`/api/scenarios/:id/${suffix}`, async () => { writes++; return {}; });
  app.delete('/api/scenarios/:id', async () => { writes++; return {}; });
  try {
    for (const suffix of ['edit', 'edits', 'rename', 'solve', '']) {
      const method = suffix ? 'POST' : 'DELETE';
      const url = `/api/scenarios/known${suffix ? `/${suffix}` : ''}`;
      assert.equal((await app.inject({ method, url })).statusCode, 428);
      assert.equal((await app.inject({ method, url, headers: { 'if-match': '*' } })).statusCode, 400);
      assert.equal((await app.inject({ method, url, headers: { 'if-match': '"2"' } })).statusCode, 409);
      assert.equal(writes, 0);
    }
    assert.equal((await app.inject({ method: 'POST', url: '/api/scenarios/known/edit', headers: { 'if-match': '"3"' } })).statusCode, 200);
    assert.equal(writes, 1);
    assert.equal((await app.inject({ method: 'POST', url: '/api/scenarios/missing/edit', headers: { 'if-match': '"3"' } })).statusCode, 404);
  } finally { await app.close(); }
});
