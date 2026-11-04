import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ObjectStore, ObjectStoreError, type ImmutableObject } from './objects.js';
import { createStatefulApi } from './api.js';
import type { StatefulStore } from './postgres.js';
const bytes = Buffer.from('abc');
const object: ImmutableObject = { key: 'tenants/public/sha256/test', sha256: createHash('sha256').update(bytes).digest('hex'), size: 3, mediaType: 'text/plain' };
async function fixture(handle: (req: IncomingMessage, res: ServerResponse) => void, options: ConstructorParameters<typeof ObjectStore>[1] = {}) {
    const server = createServer(handle);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    const store = new ObjectStore('private-bucket', { endpoint: `http://127.0.0.1:${address.port}`, accessKeyId: 'not-a-real-key', secretAccessKey: 'not-a-real-secret', operationMs: 400, probeMs: 250, cacheMs: 30, ...options });
    return { store, async close() { store.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
async function eventually(check: () => boolean) { for (let i = 0; i < 100; i++) {
    if (check())
        return;
    await delay(5);
} assert(check()); }
const failure = (code: string) => (error: unknown) => error instanceof ObjectStoreError && error.code === code;
test('200 hung readiness callers share one bounded probe and recover without restart', async () => {
    let requests = 0, closed = 0, healthy = false;
    const events: Record<string, unknown>[] = [];
    const f = await fixture((req, res) => { requests++; req.on('close', () => closed++); if (healthy)
        res.writeHead(200).end(); }, { onEvent: e => events.push(e) });
    try {
        const results = await Promise.allSettled(Array.from({ length: 200 }, () => f.store.ready()));
        assert(results.every(r => r.status === 'rejected' && failure('timeout')(r.reason)));
        assert.equal(requests, 1);
        await assert.rejects(f.store.ready(), failure('timeout'));
        assert.equal(requests, 1);
        await eventually(() => closed === 1);
        healthy = true;
        await delay(40);
        await f.store.ready();
        assert.equal(requests, 2);
        await Promise.all(Array.from({ length: 200 }, () => f.store.ready()));
        assert.equal(requests, 2);
        assert.deepEqual(events.map(e => e.event), ['unavailable', 'recovered']);
        assert.equal(f.store.diagnostics().readiness, 'ready');
        for (const secret of ['private-bucket', 'not-a-real', '127.0.0.1', 'tenants/'])
            assert(!JSON.stringify(events).includes(secret));
    }
    finally {
        await f.close();
    }
});
test('bounded data admission, queue deadlines and independent readiness recover after saturation', async () => {
    let active = 0, maximum = 0, healthy = false;
    const f = await fixture((req, res) => {
        if (req.method === 'HEAD') {
            res.writeHead(200).end();
            return;
        }
        active++;
        maximum = Math.max(maximum, active);
        req.on('close', () => active--);
        if (healthy)
            res.writeHead(200, { 'content-length': '3' }).end(bytes);
    }, { concurrency: 2, queueLimit: 2 });
    try {
        const settled = Promise.allSettled(Array.from({ length: 6 }, () => f.store.getVerified(object)));
        await eventually(() => f.store.diagnostics().active === 2 && f.store.diagnostics().pending === 2);
        await f.store.ready();
        const results = await settled;
        assert.equal(results.filter(r => r.status === 'rejected' && failure('busy')(r.reason)).length, 2);
        assert(results.every(r => r.status === 'rejected'));
        await eventually(() => active === 0);
        assert(maximum <= 2);
        assert.equal(f.store.diagnostics().active, 0);
        assert.equal(f.store.diagnostics().pending, 0);
        healthy = true;
        assert.deepEqual(await f.store.getVerified(object), new Uint8Array(bytes));
    }
    finally {
        await f.close();
    }
});
test('deadline includes stalled response body, closes socket and permits next verified read', async () => {
    let stalled = true, closed = 0;
    const f = await fixture((req, res) => { req.on('close', () => closed++); res.writeHead(200, { 'content-length': '3' }); if (stalled) {
        res.flushHeaders();
        res.write('a');
    }
    else
        res.end(bytes); });
    try {
        await assert.rejects(f.store.getVerified(object), failure('timeout'));
        await eventually(() => closed > 0);
        stalled = false;
        assert.deepEqual(await f.store.getVerified(object), new Uint8Array(bytes));
    }
    finally {
        await f.close();
    }
});
test('checksum and size validation reject changed bytes', async () => {
    const f = await fixture((_req, res) => res.writeHead(200, { 'content-length': '3' }).end('xyz'));
    try {
        await assert.rejects(f.store.getVerified(object), failure('integrity'));
        await assert.rejects(f.store.getVerified({ ...object, sha256: createHash('sha256').update('xyz').digest('hex'), size: 4 }), failure('integrity'));
    }
    finally {
        await f.close();
    }
});
test('conditional publication reconciles concurrent winner only after matching immutable metadata', async () => {
    let heads = 0, puts = 0, conflict = false;
    const f = await fixture((req, res) => {
        if (req.method === 'HEAD') {
            heads++;
            if (heads === 1) {
                res.writeHead(404).end();
                return;
            }
            res.writeHead(200, { 'content-length': '3', 'x-amz-meta-sha256': conflict ? 'bad' : object.sha256 }).end();
            return;
        }
        puts++;
        assert.equal(req.headers['if-none-match'], '*');
        req.resume();
        res.writeHead(412).end();
    });
    try {
        const saved = await f.store.putImmutable('public', bytes, 'text/plain');
        assert.equal(saved.sha256, object.sha256);
        assert.equal(puts, 1);
        conflict = true;
        await assert.rejects(f.store.putImmutable('public', bytes, 'text/plain'), failure('integrity'));
        assert.equal(puts, 1);
    }
    finally {
        await f.close();
    }
});
test('transient failures retry within deadline with at most three attempts and sanitized errors', async () => {
    let calls = 0, recover = true;
    const f = await fixture((_req, res) => { calls++; if (recover && calls === 2)
        res.writeHead(200, { 'content-length': '3' }).end(bytes);
    else
        res.writeHead(503, { 'content-type': 'application/xml' }).end('<Error><Code>ServiceUnavailable</Code><Message>private-provider-message</Message></Error>'); }, { operationMs: 8000 });
    try {
        assert.deepEqual(await f.store.getVerified(object), new Uint8Array(bytes));
        assert.equal(calls, 2);
        calls = 0;
        recover = false;
        await assert.rejects(f.store.getVerified(object), e => failure('unavailable')(e) && !String(e).includes('private-provider-message'));
        assert.equal(calls, 3);
    }
    finally {
        await f.close();
    }
});
test('shutdown aborts active and queued work and probes; later operations reject', async () => {
    const f = await fixture(() => { }, { concurrency: 1, queueLimit: 2, operationMs: 5000, probeMs: 5000 });
    try {
        const results = Promise.allSettled([f.store.ready(), f.store.getVerified(object), f.store.getVerified(object)]);
        await eventually(() => f.store.diagnostics().pending === 1);
        f.store.close();
        assert((await results).every(r => r.status === 'rejected' && failure('closed')(r.reason)));
        await assert.rejects(f.store.ready(), failure('closed'));
        await assert.rejects(f.store.getVerified(object), failure('closed'));
        assert.equal(f.store.diagnostics().active, 0);
        assert.equal(f.store.diagnostics().pending, 0);
    }
    finally {
        await f.close();
    }
});
test('real readiness HTTP handlers share probes, return bounded 503 and recover with exact Cloudflare matcher', async () => {
    let healthy = false, calls = 0;
    const f = await fixture((_req, res) => { calls++; if (healthy)
        res.writeHead(200).end(); });
    const store = { ensureTenant: async () => { }, pool: { query: async () => ({ rows: [{ value: 1 }] }) } } as unknown as StatefulStore;
    const app = await createStatefulApi({ store, objects: f.store, tenantId: 'public', tenantName: 'Public' });
    try {
        const failed = await Promise.all(Array.from({ length: 50 }, () => app.inject('/health/ready')));
        assert(failed.every(r => r.statusCode === 503 && r.json().code === 'timeout' && r.headers['cache-control'] === 'no-store'));
        assert.equal(calls, 1);
        assert(!failed[0]!.body.includes('private-bucket'));
        healthy = true;
        await delay(40);
        const ready = await app.inject('/health/ready');
        assert.equal(ready.statusCode, 200);
        assert(ready.body.includes('"status": "ready"'));
        assert.equal((await app.inject('/api/health')).statusCode, 200);
    }
    finally {
        await app.close();
        await f.close();
    }
});
test('lost PUT acknowledgement never causes overwrite; retry verifies existing checksum metadata', async () => {
    let exists = false, puts = 0, heads = 0;
    const f = await fixture((req, res) => {
        if (req.method === 'HEAD') {
            heads++;
            if (!exists)
                res.writeHead(404).end();
            else
                res.writeHead(200, { 'content-length': '3', 'x-amz-meta-sha256': object.sha256 }).end();
            return;
        }
        puts++;
        assert.equal(req.headers['if-none-match'], '*');
        req.resume();
        exists = true; // Store bytes but lose the acknowledgement.
    });
    try {
        await assert.rejects(f.store.putImmutable('public', bytes, 'text/plain'), failure('timeout'));
        const retried = await f.store.putImmutable('public', bytes, 'text/plain');
        assert.equal(retried.sha256, object.sha256);
        assert.equal(puts, 1);
        assert.equal(heads, 2);
    }
    finally {
        await f.close();
    }
});
test('access denied is not retried and emits only allowlisted diagnostics', async () => {
    let calls = 0;
    const events: Record<string, unknown>[] = [];
    const f = await fixture((_req, res) => { calls++; res.writeHead(403, { 'content-type': 'application/xml' }).end('<Error><Code>AccessDenied</Code><Message>not-a-real-secret private-bucket</Message></Error>'); }, { onEvent: e => events.push(e) });
    try {
        await assert.rejects(f.store.getVerified(object), failure('unavailable'));
        assert.equal(calls, 1);
        await assert.rejects(f.store.getVerified(object), failure('unavailable'));
        assert.equal(events.length, 1);
        assert(!JSON.stringify(events).includes('not-a-real-secret'));
        assert(!JSON.stringify(events).includes('private-bucket'));
    }
    finally {
        await f.close();
    }
});
test('tenant listing remains paginated and rejects incomplete pagination instead of returning a partial inventory', async () => {
    let calls = 0, bad = false;
    const f = await fixture((req, res) => {
        calls++;
        assert(new URL(req.url!, 'http://test').searchParams.get('prefix') === 'tenants/public/sha256/');
        const next = new URL(req.url!, 'http://test').searchParams.get('continuation-token');
        res.writeHead(200, { 'content-type': 'application/xml' }).end(`<ListBucketResult><IsTruncated>${!next}</IsTruncated><Contents><Key>tenants/public/sha256/${next ? 'b' : 'a'}</Key></Contents>${!next && !bad ? '<NextContinuationToken>page-2</NextContinuationToken>' : ''}</ListBucketResult>`);
    });
    try {
        assert.deepEqual(await f.store.listTenantKeys('public'), ['tenants/public/sha256/a', 'tenants/public/sha256/b']);
        assert.equal(calls, 2);
        bad = true;
        await assert.rejects(f.store.listTenantKeys('public'), failure('unavailable'));
    }
    finally {
        await f.close();
    }
});
