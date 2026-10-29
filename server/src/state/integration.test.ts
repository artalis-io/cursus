import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { ObjectStore } from './objects.js';
import { DatasetRepository } from './datasets.js';
import { JobQueueFullError, RevisionConflictError, StaleFenceError, StatefulStore } from './postgres.js';
import { StatefulAuthService } from './auth.js';
import { ScenarioRepository } from './scenarios.js';
import { deliverOne, type EmailSender } from './outbox.js';
import { workOneSolve } from './worker.js';
import { createStatefulApi } from './api.js';

const databaseUrl = process.env.CURSUS_TEST_DATABASE_URL;
const s3Endpoint = process.env.CURSUS_TEST_S3_ENDPOINT;
const enabled = Boolean(databaseUrl && s3Endpoint);
const integration = enabled ? test : test.skip;
let a: StatefulStore, b: StatefulStore;
const tenant = `test-${randomUUID()}`;
const bucket = `cursus-${randomUUID()}`;

before(async () => {
  if (!enabled) return;
  a = new StatefulStore(databaseUrl!); b = new StatefulStore(databaseUrl!);
  await Promise.all([a.migrate(), b.migrate()]);
  // This Compose database is disposable by contract. Reset it so repeated
  // local runs cannot leave claimable work that changes concurrency outcomes.
  await a.pool.query('TRUNCATE email_outbox,jobs,plans,datasets,objects,scenarios,audit_events,sessions,magic_links,memberships,users,tenants CASCADE');
  await a.ensureTenant(tenant, 'Integration tenant');
  const s3 = new S3Client({ endpoint: s3Endpoint, region: 'us-east-1', forcePathStyle: true,
    credentials: { accessKeyId: 'integration', secretAccessKey: 'integration' } });
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
});
after(async () => { if (enabled) await Promise.all([a.close(), b.close()]); });

integration('optimistic revisions reject a concurrent stale writer', async () => {
  await a.createScenario(tenant, 'scenario-1', { value: 0 });
  assert.equal(await a.updateScenario(tenant, 'scenario-1', 0, { value: 1 }), 1);
  await assert.rejects(() => b.updateScenario(tenant, 'scenario-1', 0, { value: 2 }), RevisionConflictError);
});

integration('idempotent enqueue and SKIP LOCKED give one worker the job', async () => {
  const first = await a.enqueueJob(tenant, 'solve', 'solve/request-1', { scenario: 'scenario-1' });
  const duplicate = await b.enqueueJob(tenant, 'solve', 'solve/request-1', { scenario: 'scenario-1' });
  assert.equal(first, duplicate);
  const [one, two] = await Promise.all([a.claimJob('solve', 'worker-a', 30), b.claimJob('solve', 'worker-b', 30)]);
  assert.equal([one, two].filter(Boolean).length, 1);
  await a.failJob((one ?? two)!, 'test cleanup');
});

integration('queue admission is bounded atomically across API replicas', async () => {
  const results = await Promise.allSettled([
    a.enqueueJob(tenant, 'solve', 'solve/bounded-a', {}, 1),
    b.enqueueJob(tenant, 'solve', 'solve/bounded-b', {}, 1),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  assert.ok(rejected?.reason instanceof JobQueueFullError);
  const lease = await a.claimJob('solve', 'bounded-cleanup', 30); assert.ok(lease);
  await a.failJob(lease!, 'test cleanup');
});

integration('stale fencing generation cannot publish a plan', async () => {
  await a.enqueueJob(tenant, 'solve', 'solve/fence', { scenario: 'scenario-1' });
  const old = await a.claimJob('solve', 'worker-old', 1); assert.ok(old);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const current = await b.claimJob('solve', 'worker-new', 30); assert.ok(current);
  assert.ok(current!.fence > old!.fence);
  await assert.rejects(() => a.completeSolve(old!, 'stale-plan', 'scenario-1', 1, {}), StaleFenceError);
  await b.completeSolve(current!, 'winning-plan', 'scenario-1', 1, { valid: true });
  const { rows } = await a.pool.query('SELECT id FROM plans WHERE tenant_id=$1 AND id IN ($2,$3)', [tenant, 'stale-plan', 'winning-plan']);
  assert.deepEqual(rows.map((r) => r.id), ['winning-plan']);
});

integration('outbox intent is idempotent and a stale sender cannot acknowledge', async () => {
  const id1 = await a.tx((client) => a.enqueueEmail(client, tenant, 'magic-link/challenge-1', { to: 'user@example.test' }));
  const id2 = await b.tx((client) => b.enqueueEmail(client, tenant, 'magic-link/challenge-1', { to: 'user@example.test' }));
  assert.equal(id1, id2);
  const old = await a.claimEmail('sender-old', 1); assert.ok(old);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const current = await b.claimEmail('sender-new', 30); assert.ok(current);
  assert.equal(current!.idempotencyKey, 'magic-link/challenge-1');
  await assert.rejects(() => a.emailSent(old!, 'provider-stale'), StaleFenceError);
  await b.emailSent(current!, 'provider-stable');
});

integration('ambiguous email is not automatically retried beyond Resend idempotency retention', async () => {
  await a.tx((client) => a.enqueueEmail(client, tenant, 'magic-link/aged', { to: 'user@example.test' }));
  const lease = await a.claimEmail('sender-aged', 30); assert.ok(lease);
  await a.pool.query("UPDATE email_outbox SET created_at=now()-interval '24 hours' WHERE tenant_id=$1 AND id=$2", [tenant, lease!.id]);
  await a.emailRetry(lease!, 'ambiguous provider response', 1);
  const { rows } = await a.pool.query('SELECT state FROM email_outbox WHERE tenant_id=$1 AND id=$2', [tenant, lease!.id]);
  assert.equal(rows[0].state, 'failed');
});

integration('immutable objects are checksum addressed and dataset publish is atomic', async () => {
  const objects = new ObjectStore(bucket, { endpoint: s3Endpoint, accessKeyId: 'integration', secretAccessKey: 'integration' });
  const body = new TextEncoder().encode('non-confidential integration fixture');
  const first = await objects.putImmutable(tenant, body, 'text/plain');
  const second = await objects.putImmutable(tenant, body, 'text/plain');
  assert.deepEqual(first, second);
  assert.deepEqual(await objects.getVerified(first), body);
  await a.stageObject(tenant, first);
  await a.createDatasetUpload(tenant, 'dataset-1', { source: first });
  await a.validateDataset(tenant, 'dataset-1', { source: first, validation: { valid: true } });
  await a.publishDataset(tenant, 'dataset-1', { objects: [first.key] }, [first.key]);
  await assert.rejects(() => a.publishDataset(tenant, 'dataset-bad', {}, ['missing-object']));
  const { rows } = await a.pool.query('SELECT id FROM datasets WHERE tenant_id=$1 ORDER BY id', [tenant]);
  assert.deepEqual(rows.map((r) => r.id), ['dataset-1']);
});

integration('unrecorded immutable objects are discoverable for retained orphan cleanup', async () => {
  const orphanTenant = `orphan-${randomUUID()}`; await a.ensureTenant(orphanTenant, 'Orphan inventory');
  const objects = new ObjectStore(bucket, { endpoint: s3Endpoint, accessKeyId: 'integration', secretAccessKey: 'integration' });
  const repository = new DatasetRepository(a, objects, orphanTenant);
  const object = await objects.putImmutable(orphanTenant, new TextEncoder().encode('interrupted conversion output'), 'text/plain');
  assert.deepEqual(await repository.orphanKeys(), [object.key]);
  await a.stageObject(orphanTenant, object);
  assert.deepEqual(await repository.orphanKeys(), []);
});

integration('two scenario repositories share tenant-scoped authoritative state', async () => {
  assert.equal(await a.getTenantName(tenant), 'Integration tenant');
  assert.equal(await a.getTenantName('missing-tenant'), null);
  const repoA = new ScenarioRepository(a, tenant), repoB = new ScenarioRepository(b, tenant);
  const base = await repoA.ensureBase('shared-day', 'Shared');
  const edited = await repoA.edit(base.id, [{ op: 'removeVehicle', vehicleId: 42 }]);
  assert.equal(edited.kind, 'copy');
  assert.deepEqual((await repoB.get(edited.id))?.removedVehicleIds, [42]);
  const other = `other-${randomUUID()}`; await a.ensureTenant(other, 'Other');
  assert.equal(await new ScenarioRepository(a, other).get(edited.id), null);
});

integration('PostgreSQL magic links persist sessions and queue email atomically', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cursus-auth-'));
  const allow = join(dir, 'allowed'); await writeFile(allow, 'admin@example.test\n', { mode: 0o600 });
  const auth = new StatefulAuthService(a, { allowedEmailsFile: allow, publicOrigin: 'https://cursus.example.test',
    from: 'Cursus <login@example.test>', tenantId: tenant, tenantName: 'Integration tenant', secureCookies: true });
  await auth.initialize();
  const objects = new ObjectStore(bucket, { endpoint: s3Endpoint, accessKeyId: 'integration', secretAccessKey: 'integration' });
  const protectedApi = await createStatefulApi({ store: a, objects, auth, tenantId: tenant,
    tenantName: 'Integration tenant', publicOrigin: 'https://cursus.example.test' });
  {
    assert.notEqual((await protectedApi.inject({ method: 'GET', url: '/' })).statusCode, 401,
      'SPA shell must remain reachable for login');
    assert.equal((await protectedApi.inject({ method: 'GET', url: '/api/scenarios' })).statusCode, 401);
    assert.equal((await protectedApi.inject({ method: 'GET', url: '/tiles.vector.json' })).statusCode, 401);
    const ready = await protectedApi.inject({ method: 'GET', url: '/health/ready' });
    assert.equal(ready.statusCode, 200); assert.match(ready.body, /"status": "ready"/);
  }
  await auth.requestMagicLink('admin@example.test');
  const { rows } = await a.pool.query<{ payload: { html: string } }>(`SELECT payload FROM email_outbox WHERE tenant_id=$1
    AND payload->'to'->>0='admin@example.test' ORDER BY created_at DESC LIMIT 1`, [tenant]);
  const token = decodeURIComponent(rows[0]!.payload.html.match(/token=([^"<]+)/)![1]!);
  const scanned = await protectedApi.inject({ method: 'GET', url: `/api/auth/verify?token=${encodeURIComponent(token)}` });
  assert.equal(scanned.statusCode, 200); assert.match(scanned.body, /Continue to Cursus/);
  assert.equal(scanned.headers['set-cookie'], undefined, 'a GET from an email scanner must not create a session');
  assert.equal((await b.pool.query('SELECT count(*)::int n FROM sessions WHERE tenant_id=$1', [tenant])).rows[0].n, 0);
  const verified = await protectedApi.inject({ method: 'POST', url: `/api/auth/verify?token=${encodeURIComponent(token)}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: '' });
  assert.equal(verified.statusCode, 302); assert.match(String(verified.headers['set-cookie']), /^cursus_session=/);
  const session = String(verified.headers['set-cookie']).match(/^cursus_session=([^;]+)/)![1]!;
  assert.equal((await b.pool.query('SELECT count(*)::int n FROM sessions WHERE tenant_id=$1', [tenant])).rows[0].n, 1);
  assert.equal((await auth.authenticate(session!))?.email, 'admin@example.test');
  const reused = await protectedApi.inject({ method: 'POST', url: `/api/auth/verify?token=${encodeURIComponent(token)}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: '' });
  assert.equal(reused.statusCode, 302); assert.equal(reused.headers.location, '/?auth=invalid');
  await auth.logout(session!); assert.equal(await auth.authenticate(session!), null);
  await protectedApi.close();
  await a.pool.query("UPDATE email_outbox SET state='sent',sent_at=now() WHERE tenant_id=$1 AND payload->'to'->>0='admin@example.test'", [tenant]);
});

integration('schema-2 upgrade preserves memberships and sessions under concurrent migration', async () => {
  const members = (await a.pool.query('SELECT * FROM memberships ORDER BY tenant_id,user_id')).rows;
  const sessions = (await a.pool.query('SELECT * FROM sessions ORDER BY token_hash')).rows;
  // This is the disposable integration database, never a production endpoint.
  await a.tx(async client => {
    await client.query('ALTER TABLE memberships DROP CONSTRAINT memberships_role_check');
    await client.query("ALTER TABLE memberships ADD CONSTRAINT memberships_role_check CHECK(role IN ('admin','reviewer'))");
    await client.query('DELETE FROM schema_migrations WHERE version=3');
  });
  await Promise.all([a.migrate(), b.migrate()]);
  assert.deepEqual((await a.pool.query('SELECT * FROM memberships ORDER BY tenant_id,user_id')).rows, members);
  assert.deepEqual((await b.pool.query('SELECT * FROM sessions ORDER BY token_hash')).rows, sessions);
  assert.deepEqual((await a.pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(r => r.version), [1, 2, 3, 4, 5]);
});

integration('Admin, Planner and Reviewer sessions enforce tenant-scoped permissions on both replicas', async () => {
  const id = `roles-${randomUUID()}`, dir = await mkdtemp(join(tmpdir(), 'cursus-roles-'));
  const allow = join(dir, 'allowed');
  await writeFile(allow, JSON.stringify({ admins: ['one@example.test', 'two@example.test'], planners: ['planner@example.test'], reviewers: ['reader@example.test'] }), { mode: 0o600 });
  const cfg = { allowedEmailsFile: allow, publicOrigin: 'https://cursus.example.test', from: 'login@example.test',
    tenantId: id, tenantName: 'Role integration', secureCookies: true };
  const authA = new StatefulAuthService(a, cfg), authB = new StatefulAuthService(b, cfg);
  await authA.initialize();
  const apps = await Promise.all([a, b].map((store, i) => createStatefulApi({ store, auth: i ? authB : authA,
    tenantId: id, tenantName: cfg.tenantName, publicOrigin: cfg.publicOrigin })));
  const login = async (email: string) => {
    await authA.requestMagicLink(email);
    const { rows } = await a.pool.query<{ payload: { html: string } }>(`SELECT payload FROM email_outbox
      WHERE tenant_id=$1 AND payload->'to'->>0=$2 ORDER BY created_at DESC LIMIT 1`, [id, email]);
    const token = decodeURIComponent(rows[0]!.payload.html.match(/token=([^"<]+)/)![1]!);
    const session = await authB.consumeMagicLink(token); assert.ok(session); return session;
  };
  try {
    const scenario = await new ScenarioRepository(a, id).ensureBase('roles-day', 'Role test');
    const admin = await login('one@example.test'); await login('two@example.test');
    const reader = await login('reader@example.test');
    const readHeaders = { cookie: `cursus_session=${reader}`, origin: cfg.publicOrigin };
    for (const app of apps) {
      assert.equal((await app.inject({ url: '/api/auth/me', headers: readHeaders })).json().role, 'reviewer');
      assert.equal((await app.inject({ url: `/api/scenarios/${scenario.id}`, headers: readHeaders })).statusCode, 200);
      assert.equal((await app.inject({ url: `/api/scenarios/${scenario.id}/export`, headers: readHeaders })).statusCode, 200);
      for (const url of [`/api/scenarios/${scenario.id}/edit`, `/api/scenarios/${scenario.id}/solve`, '/api/import/upload'])
        assert.equal((await app.inject({ method: 'POST', url, headers: readHeaders, payload: { edit: { op: 'removeVehicle', vehicleId: 1 }, role: 'admin' } })).statusCode, 403);
      assert.equal((await app.inject({ method: 'DELETE', url: `/api/scenarios/${scenario.id}`, headers: readHeaders })).statusCode, 403);
    }
    assert.equal((await a.listScenarios(id)).length, 1);
    assert.equal((await a.pool.query('SELECT count(*)::int n FROM jobs WHERE tenant_id=$1', [id])).rows[0].n, 0);
    await authB.setRole('one@example.test', 'reviewer');
    for (const app of apps) {
      const headers = { cookie: `cursus_session=${admin}`, origin: cfg.publicOrigin };
      assert.equal((await app.inject({ url: '/api/auth/me', headers })).json().role, 'reviewer');
      assert.equal((await app.inject({ method: 'POST', url: '/api/scenarios', headers, payload: { from: scenario.id } })).statusCode, 403);
    }
    await login('one@example.test');
    assert.equal((await authA.authenticate(admin))?.role, 'reviewer', 'new login must not undo a demotion');
    await assert.rejects(authA.setRole('two@example.test', 'reviewer'), /last tenant administrator/);
    await assert.rejects(authA.setRole('two@example.test', 'planner'), /last tenant administrator/);
    const planner = await login('planner@example.test');
    const plannerHeaders = { cookie: `cursus_session=${planner}`, origin: cfg.publicOrigin };
    const objectCount = (await a.pool.query('SELECT count(*)::int n FROM objects WHERE tenant_id=$1', [id])).rows[0].n;
    const jobCount = (await a.pool.query('SELECT count(*)::int n FROM jobs WHERE tenant_id=$1', [id])).rows[0].n;
    for (const app of apps) {
      const me = (await app.inject({ url: '/api/auth/me', headers: plannerHeaders })).json();
      assert.equal(me.role, 'planner'); assert.ok(me.permissions.includes('scenario.edit'));
      assert.ok(!me.permissions.includes('dataset.upload')); assert.ok(!me.permissions.includes('optimization.cancel'));
      const created = await app.inject({ method: 'POST', url: '/api/scenarios', headers: plannerHeaders, payload: { from: scenario.id } });
      assert.equal(created.statusCode, 201);
      const copy = created.json();
      const beforeBatch = await a.getScenario(id, copy.id);
      assert.equal((await app.inject({ method: 'POST', url: `/api/scenarios/${copy.id}/edits`, headers: { ...plannerHeaders, 'if-match': `"${copy.revision}"` },
        payload: { edits: [{ op: 'removeVehicle', vehicleId: 99 }, { op: 'admitDataset', datasetId: 'no' }] } })).statusCode, 400);
      assert.deepEqual(await a.getScenario(id, copy.id), beforeBatch, 'an invalid batch must not partially edit authoritative state');
      assert.equal((await app.inject({ method: 'POST', url: `/api/scenarios/${copy.id}/edits`, headers: { ...plannerHeaders, 'if-match': `"${copy.revision}"` },
        payload: { edits: [{ op: 'removeVehicle', vehicleId: 2 }, { op: 'restoreVehicle', vehicleId: 2 }] } })).statusCode, 200);
      assert.equal((await app.inject({ method: 'POST', url: `/api/scenarios/${copy.id}/rename`, headers: { ...plannerHeaders, 'if-match': `"${copy.revision + 1}"` }, payload: { label: 'Planner revised' } })).statusCode, 200);
      assert.equal((await app.inject({ method: 'POST', url: `/api/scenarios/${copy.id}/edit`, headers: { ...plannerHeaders, 'if-match': `"${copy.revision + 2}"` }, payload: { edit: { op: 'removeVehicle', vehicleId: 1 } } })).statusCode, 200);
      assert.equal((await app.inject({ method: 'DELETE', url: `/api/scenarios/${copy.id}`, headers: plannerHeaders })).statusCode, 403);
      for (const path of ['/api/import/upload', '/api/import/preview', '/api/import/geocode', '/api/import/admit',
        '/api/import/datasets/anything/validate', '/api/import/datasets/anything/admit', '/api/import/datasets/anything/convert', '/api/auth/view-as'])
        assert.equal((await app.inject({ method: 'POST', url: path, headers: plannerHeaders, payload: { role: 'admin' } })).statusCode, 403, path);
      assert.equal((await app.inject({ method: 'DELETE', url: '/api/import/datasets/anything', headers: plannerHeaders })).statusCode, 403);
      assert.equal((await app.inject({ url: `/api/scenarios/${copy.id}/export`, headers: plannerHeaders })).statusCode, 200);
    }
    assert.equal((await a.pool.query('SELECT count(*)::int n FROM objects WHERE tenant_id=$1', [id])).rows[0].n, objectCount);
    assert.equal((await a.pool.query('SELECT count(*)::int n FROM jobs WHERE tenant_id=$1', [id])).rows[0].n, jobCount);
    const audit = await a.pool.query("SELECT detail FROM audit_events WHERE tenant_id=$1 AND action='access.authorized'", [id]);
    assert.ok(audit.rows.some(r => r.detail.role === 'planner' && r.detail.permission === 'scenario.edit'));
    await authA.setRole('planner@example.test', 'reviewer');
    for (const app of apps) assert.equal((await app.inject({ method: 'POST', url: '/api/scenarios', headers: plannerHeaders, payload: { from: scenario.id } })).statusCode, 403);
    await login('planner@example.test');
    assert.equal((await authB.authenticate(planner))?.role, 'reviewer');
    await authA.setRole('reader@example.test', 'admin');
    assert.equal((await authB.authenticate(reader))?.role, 'admin');
    const headers = { cookie: `cursus_session=${reader}`, origin: cfg.publicOrigin };
    assert.equal((await apps[1]!.inject({ method: 'POST', url: '/api/scenarios', headers, payload: { from: scenario.id } })).statusCode, 201);
    const foreign = await createStatefulApi({ store: a, auth: authA, tenantId: tenant, tenantName: 'Other tenant' });
    try { assert.equal((await foreign.inject({ url: '/api/scenarios', headers })).statusCode, 401); }
    finally { await foreign.close(); }
    assert.equal((await apps[0]!.inject({ method: 'POST', url: '/api/auth/logout', headers: readHeaders })).statusCode, 200);
    assert.equal(await authB.authenticate(reader), null);
  } finally {
    await Promise.all(apps.map(app => app.close()));
    // These test messages were never delivered. Retire only this fixture's
    // intents so later global outbox-claim tests cannot consume them.
    await a.pool.query("UPDATE email_outbox SET state='sent',sent_at=now() WHERE tenant_id=$1", [id]);
  }
});

integration('provider acceptance followed by crash retries with one stable idempotency key', async () => {
  const mailTenant = `mail-${randomUUID()}`; await a.ensureTenant(mailTenant, 'Mail');
  const key = `ambiguous/${randomUUID()}`;
  await a.tx((client) => a.enqueueEmail(client, mailTenant, key, { to: ['mail@example.test'] }));
  const seen: string[] = [];
  const provider: EmailSender = { async send(_payload, idempotencyKey) { seen.push(idempotencyKey); return 'provider-one'; } };
  const original = a.emailSent.bind(a); let crash = true;
  a.emailSent = async (lease, providerId) => { if (crash) { crash = false; throw new Error('simulated crash after provider acceptance'); } return original(lease, providerId); };
  await deliverOne(a, provider, 'mail-a');
  await a.pool.query("UPDATE email_outbox SET next_attempt_at=now(),lease_expires_at=now()-interval '1 second' WHERE tenant_id=$1 AND idempotency_key=$2", [mailTenant, key]);
  await deliverOne(a, provider, 'mail-b');
  a.emailSent = original;
  assert.deepEqual(seen, [key, key]);
  const row = await a.pool.query('SELECT state,provider_id FROM email_outbox WHERE tenant_id=$1 AND idempotency_key=$2', [mailTenant, key]);
  assert.deepEqual(row.rows[0], { state: 'sent', provider_id: 'provider-one' });
});

integration('a killed solver lease cannot publish after takeover', async () => {
  const key = `kill/${randomUUID()}`;
  await a.enqueueJob(tenant, 'solve', key, { scenarioId: 'scenario-1', scenarioRevision: 1 });
  const stale = await a.claimJob('solve', 'killed-worker', 1); assert.ok(stale);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await workOneSolve(b, async (lease) => ({ planId: `plan-${lease.fence}`, scenarioId: 'scenario-1', scenarioRevision: 1, plan: { winner: true } }), 'takeover', 30);
  await assert.rejects(() => a.completeSolve(stale!, 'stale-after-kill', 'scenario-1', 1, { stale: true }), StaleFenceError);
});

integration('a stale conversion worker may upload but cannot admit its dataset', async () => {
  const conversionTenant = `convert-${randomUUID()}`; await a.ensureTenant(conversionTenant, 'Conversion');
  const source = { key: `tenants/${conversionTenant}/sha256/${'a'.repeat(64)}`, sha256: 'a'.repeat(64), size: 1, mediaType: 'text/csv' };
  await a.stageObject(conversionTenant, source); await a.createDatasetUpload(conversionTenant, 'dataset-fence', { source });
  await a.enqueueJob(conversionTenant, 'dataset-admit', `convert/${randomUUID()}`, { datasetId: 'dataset-fence' });
  const stale = await a.claimJob('dataset-admit', 'converter-old', 1); assert.ok(stale);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const current = await b.claimJob('dataset-admit', 'converter-new', 30); assert.ok(current);
  await assert.rejects(() => a.completeDatasetAdmission(stale!, 'dataset-fence', { stale: true }, [source]), StaleFenceError);
  assert.equal((await a.getDataset(conversionTenant, 'dataset-fence'))?.status, 'uploaded');
  await b.completeDatasetAdmission(current!, 'dataset-fence', { source, winner: true }, [source]);
  assert.equal((await a.getDataset(conversionTenant, 'dataset-fence'))?.status, 'admitted');
});

integration('two real HTTP server instances share scenarios, jobs, and fenced plans', async () => {
  const objects = new ObjectStore(bucket, { endpoint: s3Endpoint, accessKeyId: 'integration', secretAccessKey: 'integration' });
  const apiA = await createStatefulApi({ store: a, tenantId: tenant, tenantName: 'Integration tenant', objects });
  const apiB = await createStatefulApi({ store: b, tenantId: tenant, tenantName: 'Integration tenant', objects });
  try {
    assert.equal((await apiA.inject({ method: 'GET', url: '/health/ready' })).json().status, 'ready');
    const bundle = JSON.stringify({ schemaVersion: 1, days: [{ id: 'fixture-day' }], surgeRequest: { locations: [], vehicles: [], tasks: [], requests: [] } });
    const multipart = Buffer.from(`--x\r\nContent-Disposition: form-data; name="file"; filename="dataset.json"\r\nContent-Type: application/json\r\n\r\n${bundle}\r\n--x--\r\n`);
    const uploaded = await apiA.inject({ method: 'POST', url: '/api/import/upload', payload: multipart,
      headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(multipart.length) } });
    assert.equal(uploaded.statusCode, 201);
    const data = uploaded.json();
    assert.equal((await apiB.inject({ method: 'GET', url: '/api/import/datasets' })).json().some((d: { id: string }) => d.id === data.datasetId), false);
    const csv = Buffer.from('--y\r\nContent-Disposition: form-data; name="file"; filename="orders.csv"\r\nContent-Type: text/csv\r\n\r\nRendeles;Varos\n1;Budapest\n\r\n--y--\r\n');
    const browserUpload = await apiA.inject({ method: 'POST', url: '/api/import/upload?entity=orders', payload: csv,
      headers: { 'content-type': 'multipart/form-data; boundary=y', 'content-length': String(csv.length) } });
    assert.equal(browserUpload.statusCode, 201);
    assert.ok(Array.isArray(browserUpload.json().headers)); assert.ok(Array.isArray(browserUpload.json().rows));
    assert.equal(typeof browserUpload.json().suggested, 'object'); assert.equal(browserUpload.json().uploadId, browserUpload.json().datasetId);
    assert.equal((await apiB.inject({ method: 'POST', url: `/api/import/datasets/${data.datasetId}/validate` })).statusCode, 200);
    assert.equal((await apiA.inject({ method: 'POST', url: `/api/import/datasets/${data.datasetId}/admit` })).statusCode, 200);
    assert.equal((await apiB.inject({ method: 'GET', url: '/api/import/datasets' })).json().some((d: { id: string }) => d.id === data.datasetId), true);
    const created = await apiA.inject({ method: 'POST', url: '/api/scenarios', payload: { day: 'http-day', label: 'HTTP day' } });
    assert.equal(created.statusCode, 200);
    const base = created.json();
    const edited = await apiB.inject({ method: 'POST', url: `/api/scenarios/${base.id}/edit`, headers: { 'if-match': `"${base.revision}"` }, payload: { edit: { op: 'removeVehicle', vehicleId: 7 } } });
    assert.equal(edited.statusCode, 200);
    const scenario = edited.json();
    const visible = await apiA.inject({ method: 'GET', url: `/api/scenarios/${scenario.id}` });
    assert.deepEqual(visible.json().removedVehicleIds, [7]);
    const queued = await apiA.inject({ method: 'POST', url: `/api/scenarios/${scenario.id}/solve`, headers: { 'if-match': `"${scenario.revision}"` }, payload: { budgetSec: 1 } });
    assert.equal(queued.statusCode, 202);
    const jobId = queued.json().jobId;
    assert.equal(typeof jobId, 'string');
    await workOneSolve(b, async (lease) => ({ planId: `http-plan-${lease.id}`, scenarioId: scenario.id,
      scenarioRevision: scenario.revision, plan: { id: `http-plan-${lease.id}`, scenarioId: scenario.id, scenarioRevision: scenario.revision,
        shared: true, day: '2026-01-01', createdAt: new Date().toISOString(), objective: 'vehicles', source: 'live',
        stats: { vehiclesUsed: 0, servedOrders: 0, totalOrders: 0, totalDistanceKm: 0 }, vehicles: [], unassigned: [] } }), 'http-worker');
    const job = await apiB.inject({ method: 'GET', url: `/api/jobs/${jobId}` });
    assert.equal(job.json().status, 'completed');
    assert.equal(job.json().planId, `http-plan-${jobId}`);
    const plan = await apiA.inject({ method: 'GET', url: `/api/plans/http-plan-${jobId}` });
    assert.equal(plan.json().shared, true);
    const compared = await apiB.inject({ method: 'GET', url: `/api/compare?base=http-plan-${jobId}&revised=http-plan-${jobId}` });
    assert.equal(compared.statusCode, 200); assert.equal(compared.json().deltas.servedOrders, 0);
    assert.equal((await apiB.inject({ method: 'GET', url: `/api/compare?base=http-plan-${jobId}&revised=missing` })).statusCode, 404);
    const handoff = await apiB.inject({ method: 'GET', url: `/api/plans/http-plan-${jobId}/handoff.json` });
    assert.equal(handoff.statusCode, 200);

    // Regression: the production stateful API must recompute a reordered trip
    // from admitted immutable artifacts. Previously this route existed only in
    // legacy mode, while the UI test accepted its temporary pending label.
    const evalDay = `evaluate-${randomUUID()}`;
    const evalScenario = `scenario-${randomUUID()}`;
    const evalDataset = `dataset-${randomUUID()}`;
    const evalPlan = `plan-${randomUUID()}`;
    const evalRequest = {
      config: {}, dimension_count: 2, demand_sign_convention: 1,
      locations: [{ x: 19, y: 47 }, { x: 19.1, y: 47.1 }, { x: 19.2, y: 47.2 }], depots: [],
      vehicles: [{ id: 7, ref: 'TEST-7', capacity: [10000, 20], start_depot_id: 0, end_depot_id: 0 }],
      tasks: [
        { id: 1, type: 'delivery', location_id: 1, tw_early: 0, tw_late: 86400, service_seconds: 60, demand: [100, 1], ref: 'ORDER-A' },
        { id: 2, type: 'delivery', location_id: 2, tw_early: 0, tw_late: 86400, service_seconds: 60, demand: [100, 1], ref: 'ORDER-B' },
      ],
      requests: [{ id: 1, delivery_task_id: 1 }, { id: 2, delivery_task_id: 2 }],
      travel: { location_count: 3,
        distances: [0, 1000, 3000, 1000, 0, 1000, 3000, 1000, 0],
        durations: [0, 60, 180, 60, 0, 60, 180, 60, 0] },
    };
    const evalGeo = { records: [
      { order_no: 'ORDER-A', delivery_date: '2026-05-06' },
      { order_no: 'ORDER-B', delivery_date: '2026-05-06' },
    ] };
    const requestObject = await objects.putImmutable(tenant, Buffer.from(JSON.stringify(evalRequest)), 'application/json');
    const geoObject = await objects.putImmutable(tenant, Buffer.from(JSON.stringify(evalGeo)), 'application/json');
    await a.stageObject(tenant, requestObject); await a.stageObject(tenant, geoObject);
    await a.createDatasetUpload(tenant, evalDataset, { source: requestObject });
    await a.enqueueJob(tenant, 'dataset-admit', `evaluate-admit/${randomUUID()}`, { datasetId: evalDataset });
    const admission = await a.claimJob('dataset-admit', 'evaluate-converter', 30); assert.ok(admission);
    const manifest = { artifacts: { request: requestObject, geocoded: geoObject },
      days: [{ dayId: evalDay, date: '2026-05-06', isoDate: '2026-05-06', label: 'Evaluate fixture' }] };
    await a.completeDatasetAdmission(admission!, evalDataset, manifest, [requestObject, geoObject]);
    await a.createScenario(tenant, evalScenario, { id: evalScenario, day: evalDay, kind: 'copy', parentId: null, revision: 1,
      label: 'Evaluate fixture', removedVehicleIds: [], pins: [], forbids: [], vehicleOverrides: [], sequences: [], createdAt: new Date().toISOString() });
    await a.enqueueJob(tenant, 'solve', `evaluate-plan/${randomUUID()}`, { scenarioId: evalScenario });
    const evalLease = await a.claimJob('solve', 'evaluate-solver', 30); assert.ok(evalLease);
    await a.completeSolve(evalLease!, evalPlan, evalScenario, 1, {
      id: evalPlan, scenarioId: evalScenario, scenarioRevision: 1, day: '2026-05-06', createdAt: new Date().toISOString(),
      provenance: { datasetSha256: requestObject.sha256 },
      objective: 'vehicles', source: 'live', stats: { vehiclesUsed: 1, servedOrders: 2, totalOrders: 2, totalDistanceKm: 3 },
      vehicles: [{ id: 7, ref: 'TEST-7', trips: [{ index: 0, startSec: 0, reloadSecAfter: 0,
        stops: [{ orderNo: 'ORDER-A' }, { orderNo: 'ORDER-B' }] }] }], unassigned: [],
    });
    const evaluated = await apiB.inject({ method: 'POST', url: `/api/plans/${evalPlan}/evaluate`, payload: {
      vehicleId: 7, tripIndex: 0, startSec: 0, reloadSecAfter: 0, orderNos: ['ORDER-B', 'ORDER-A'],
    } });
    assert.equal(evaluated.statusCode, 200);
    assert.deepEqual(evaluated.json().trip.stops.map((stop: { orderNo: string }) => stop.orderNo), ['ORDER-B', 'ORDER-A']);
    assert.equal(evaluated.json().trip.distanceKm, 5);
  } finally { await Promise.all([apiA.close(), apiB.close()]); }
});

const nativeIntegration = process.env.CURSUS_TEST_NATIVE_SOLVER === '1' ? test : test.skip;
const conversionSource = process.env.CURSUS_TEST_NATIVE_CONVERSION_SOURCE;
const nativeConversion = conversionSource ? test : test.skip;
nativeConversion('real Gyermelyi conversion artifacts cannot be admitted by an expired worker', async () => {
  const { executeDatasetConversion, solveConvertedDataset } = await import('./conversion.js');
  const objects = new ObjectStore(bucket, { endpoint: s3Endpoint, accessKeyId: 'integration', secretAccessKey: 'integration' });
  const bytes = await readFile(conversionSource!);
  const source = await objects.putImmutable(tenant, bytes, 'text/csv'); await a.stageObject(tenant, source);
  const datasetId = `ds_${randomUUID().slice(0, 10)}`; await a.createDatasetUpload(tenant, datasetId, { source, name: 'gyermelyi-orders.csv' });
  const mapping = { order_no: 0, customer: 4, zip: 5, city: 6, street: 7, delivery_date: 9,
    weight_kg: 11, pallets: 12, time_window_raw: 13, service_min: 14 };
  await a.enqueueJob(tenant, 'dataset-admit', `native-convert/${randomUUID()}`, { datasetId, source,
    sourceName: 'gyermelyi-orders.csv', mapping, label: 'Gyermelyi integration' });
  const stale = await a.claimJob('dataset-admit', 'native-converter-old', 1); assert.ok(stale);
  const output = await executeDatasetConversion(stale!, objects, new AbortController().signal);
  const current = await b.claimJob('dataset-admit', 'native-converter-new', 60); assert.ok(current);
  await assert.rejects(() => a.completeDatasetAdmission(stale!, datasetId, output.manifest, output.artifacts), StaleFenceError);
  await b.completeDatasetAdmission(current!, datasetId, output.manifest, output.artifacts);
  const admitted = await a.getDataset(tenant, datasetId); assert.equal(admitted?.status, 'admitted');
  assert.match(String((admitted?.manifest as { conversionFingerprint?: string }).conversionFingerprint), /^[0-9a-f]{64}$/);
  const day = (output.manifest.days as { dayId: string }[])[0]!.dayId;
  const scenario = { id: `scn_${randomUUID().slice(0, 8)}`, day, kind: 'copy' as const, parentId: null, revision: 1,
    label: 'Converted Gyermelyi', removedVehicleIds: [], pins: [], forbids: [], vehicleOverrides: [], sequences: [], createdAt: new Date().toISOString() };
  await a.createScenario(tenant, scenario.id, scenario);
  const solveId = await a.enqueueJob(tenant, 'solve', `converted-solve/${randomUUID()}`, { scenario });
  const solveStale = await a.claimJob('solve', 'converted-solver-old', 1); assert.ok(solveStale);
  const plan = await solveConvertedDataset(objects, tenant, output.manifest, scenario, 5, 'vehicles', new AbortController().signal);
  const solveCurrent = await b.claimJob('solve', 'converted-solver-new', 30); assert.ok(solveCurrent);
  await assert.rejects(() => a.completeSolve(solveStale!, `stale-${plan.id}`, scenario.id, scenario.revision, plan), StaleFenceError);
  await b.completeSolve(solveCurrent!, plan.id, scenario.id, scenario.revision, plan);
  const apiA = await createStatefulApi({ store: a, tenantId: tenant, tenantName: 'Integration tenant', objects });
  const apiB = await createStatefulApi({ store: b, tenantId: tenant, tenantName: 'Integration tenant', objects });
  try {
    assert.equal((await apiB.inject({ method: 'GET', url: `/api/jobs/${solveId}` })).json().state, 'succeeded');
    assert.equal((await apiA.inject({ method: 'GET', url: `/api/plans/${plan.id}` })).statusCode, 200);
    const exported = await apiB.inject({ method: 'GET', url: `/api/plans/${plan.id}/handoff.json` });
    assert.equal(exported.statusCode, 200); assert.equal(exported.json().summary.totalOrders, plan.stats.totalOrders);
  } finally { await Promise.all([apiA.close(), apiB.close()]); }
});
nativeIntegration('real native Surge result from a killed lease is fenced at publication', async () => {
  const { executeSurgeLease } = await import('./solver.js');
  const repo = new ScenarioRepository(a, tenant);
  const scenario = await repo.ensureBase('day1', 'Native solver');
  const id = await a.enqueueJob(tenant, 'solve', `native/${randomUUID()}`, { scenarioId: scenario.id,
    scenarioRevision: scenario.revision, scenario, budgetSec: 5, objective: 'vehicles' });
  const killed = await a.claimJob('solve', 'native-killed', 1); assert.ok(killed);
  const output = await executeSurgeLease(killed!, new AbortController().signal);
  const takeover = await b.claimJob('solve', 'native-takeover', 30); assert.ok(takeover);
  await assert.rejects(() => a.completeSolve(killed!, `stale-${output.planId}`, output.scenarioId, output.scenarioRevision, output.plan), StaleFenceError);
  await b.completeSolve(takeover!, output.planId, output.scenarioId, output.scenarioRevision, output.plan);
  const job = await a.getJob(tenant, id); assert.equal(job?.state, 'succeeded');
  assert.ok((job?.result as { planId?: string })?.planId);
});
