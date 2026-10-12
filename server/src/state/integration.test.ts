import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { ObjectStore } from './objects.js';
import { RevisionConflictError, StaleFenceError, StatefulStore } from './postgres.js';

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
  await a.publishDataset(tenant, 'dataset-1', { objects: [first.key] }, [first.key]);
  await assert.rejects(() => a.publishDataset(tenant, 'dataset-bad', {}, ['missing-object']));
  const { rows } = await a.pool.query('SELECT id FROM datasets WHERE tenant_id=$1 ORDER BY id', [tenant]);
  assert.deepEqual(rows.map((r) => r.id), ['dataset-1']);
});
