import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg, { type Pool, type PoolClient } from 'pg';
import type { Plan } from '../types.js';
import type { Scenario } from '../store.js';

const here = dirname(fileURLToPath(import.meta.url));
const migration = resolve(here, '../../migrations/001_stateful.sql');
const MIGRATION_LOCK = 0x43555253; // "CURS"; transaction-scoped advisory lock.

export interface Lease { tenantId: string; id: string; owner: string; fence: number; payload: unknown; attempt: number }
export interface OutboxLease extends Lease { idempotencyKey: string; createdAt: Date }
export interface AdmissionArtifact { key: string; sha256: string; size: number; mediaType: string }

export class StaleFenceError extends Error {
  constructor() { super('lease lost: stale fencing generation'); this.name = 'StaleFenceError'; }
}
export class RevisionConflictError extends Error {
  constructor() { super('scenario revision conflict'); this.name = 'RevisionConflictError'; }
}

export class StatefulStore {
  readonly pool: Pool;
  constructor(connectionString: string, max = 10) {
    this.pool = new pg.Pool({ connectionString, max, statement_timeout: 15_000, application_name: 'cursus' });
  }
  async close(): Promise<void> { await this.pool.end(); }

  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
      await client.query(await readFile(migration, 'utf8'));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async ensureTenant(id: string, name: string): Promise<void> {
    await this.pool.query('INSERT INTO tenants(id,name) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET name=excluded.name', [id, name]);
  }

  async createScenario(tenantId: string, id: string, body: unknown): Promise<void> {
    const revision = typeof body === 'object' && body && 'revision' in body ? Number((body as { revision: unknown }).revision) : 0;
    await this.pool.query('INSERT INTO scenarios(tenant_id,id,revision,body) VALUES($1,$2,$3,$4)', [tenantId, id, revision, body]);
  }

  async getScenario(tenantId: string, id: string): Promise<Scenario | null> {
    const { rows } = await this.pool.query<{ body: Scenario }>('SELECT body FROM scenarios WHERE tenant_id=$1 AND id=$2', [tenantId, id]);
    return rows[0]?.body ?? null;
  }

  async listScenarios(tenantId: string, day?: string): Promise<Scenario[]> {
    const { rows } = await this.pool.query<{ body: Scenario }>(`SELECT body FROM scenarios WHERE tenant_id=$1
      AND ($2::text IS NULL OR body->>'day'=$2) ORDER BY created_at`, [tenantId, day ?? null]);
    return rows.map((r) => r.body);
  }

  async deleteScenario(tenantId: string, id: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM scenarios WHERE tenant_id=$1 AND id=$2 AND body->>'kind'='copy'", [tenantId, id]);
    return result.rowCount === 1;
  }

  async getPlan(tenantId: string, id: string): Promise<Plan | null> {
    const { rows } = await this.pool.query<{ body: Plan }>('SELECT body FROM plans WHERE tenant_id=$1 AND id=$2', [tenantId, id]);
    return rows[0]?.body ?? null;
  }

  async listPlans(tenantId: string, scenarioId?: string): Promise<Plan[]> {
    const { rows } = await this.pool.query<{ body: Plan }>(`SELECT body FROM plans WHERE tenant_id=$1
      AND ($2::text IS NULL OR scenario_id=$2) ORDER BY created_at`, [tenantId, scenarioId ?? null]);
    return rows.map((r) => r.body);
  }

  async getJob(tenantId: string, id: string): Promise<Record<string, unknown> | null> {
    const { rows } = await this.pool.query(`SELECT id::text,kind,state,attempt,fence,payload,result,error,created_at "createdAt",updated_at "updatedAt"
      FROM jobs WHERE tenant_id=$1 AND id=$2::uuid`, [tenantId, id]);
    return rows[0] ?? null;
  }

  async updateScenario(tenantId: string, id: string, expectedRevision: number, body: unknown): Promise<number> {
    const { rows } = await this.pool.query<{ revision: string }>(`UPDATE scenarios SET revision=revision+1,body=$4,updated_at=now()
      WHERE tenant_id=$1 AND id=$2 AND revision=$3 RETURNING revision`, [tenantId, id, expectedRevision, body]);
    if (!rows[0]) throw new RevisionConflictError();
    return Number(rows[0].revision);
  }

  async stageObject(tenantId: string, object: { key: string; sha256: string; size: number; mediaType: string }): Promise<void> {
    await this.pool.query(`INSERT INTO objects(tenant_id,object_key,sha256,size_bytes,media_type,state)
      VALUES($1,$2,$3,$4,$5,'staged') ON CONFLICT(tenant_id,object_key) DO UPDATE SET
      sha256=excluded.sha256,size_bytes=excluded.size_bytes,media_type=excluded.media_type`,
      [tenantId, object.key, object.sha256, object.size, object.mediaType]);
  }

  async publishDataset(tenantId: string, datasetId: string, manifest: unknown, objectKeys: string[]): Promise<void> {
    await this.tx(async (client) => {
      const objects = await client.query(`UPDATE objects SET state='published',published_at=coalesce(published_at,now())
        WHERE tenant_id=$1 AND object_key=ANY($2::text[]) AND state IN ('staged','published') RETURNING object_key`, [tenantId, objectKeys]);
      if (objects.rowCount !== objectKeys.length) throw new Error('dataset references missing or unpublished staged objects');
      const dataset = await client.query(`UPDATE datasets SET manifest=$3,status='admitted',admitted_at=now(),failure=NULL
        WHERE tenant_id=$1 AND id=$2 AND status='validated' RETURNING id`, [tenantId, datasetId, manifest]);
      if (dataset.rowCount !== 1) throw new Error('dataset must be validated before admission');
    });
  }

  async createDatasetUpload(tenantId: string, datasetId: string, manifest: unknown): Promise<void> {
    await this.pool.query("INSERT INTO datasets(tenant_id,id,manifest,status) VALUES($1,$2,$3,'uploaded')", [tenantId, datasetId, manifest]);
  }

  async validateDataset(tenantId: string, datasetId: string, manifest: unknown): Promise<void> {
    const result = await this.pool.query(`UPDATE datasets SET manifest=$3,status='validated',validated_at=now(),failure=NULL
      WHERE tenant_id=$1 AND id=$2 AND status IN ('uploaded','validated')`, [tenantId, datasetId, manifest]);
    if (result.rowCount !== 1) throw new Error('dataset is missing or not validatable');
  }

  async failDataset(tenantId: string, datasetId: string, error: string): Promise<void> {
    await this.pool.query("UPDATE datasets SET status='failed',failure=$3 WHERE tenant_id=$1 AND id=$2 AND status<>'admitted'", [tenantId, datasetId, error.slice(0, 2000)]);
  }

  async getDataset(tenantId: string, datasetId: string): Promise<Record<string, unknown> | null> {
    const { rows } = await this.pool.query(`SELECT id,status,schema_version "schemaVersion",manifest,failure,created_at "createdAt",
      validated_at "validatedAt",admitted_at "admittedAt" FROM datasets WHERE tenant_id=$1 AND id=$2`, [tenantId, datasetId]);
    return rows[0] ?? null;
  }

  async listDatasets(tenantId: string, admittedOnly = true): Promise<Record<string, unknown>[]> {
    const { rows } = await this.pool.query(`SELECT id,status,schema_version "schemaVersion",manifest,created_at "createdAt",
      validated_at "validatedAt",admitted_at "admittedAt" FROM datasets WHERE tenant_id=$1
      AND ($2::boolean=false OR status='admitted') ORDER BY created_at`, [tenantId, admittedOnly]);
    return rows;
  }

  async enqueueJob(tenantId: string, kind: 'solve' | 'dataset-admit', idempotencyKey: string, payload: unknown): Promise<string> {
    const id = randomUUID();
    const { rows } = await this.pool.query<{ id: string }>(`INSERT INTO jobs(tenant_id,id,kind,idempotency_key,payload)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,kind,idempotency_key)
      DO UPDATE SET idempotency_key=excluded.idempotency_key RETURNING id`, [tenantId, id, kind, idempotencyKey, payload]);
    return rows[0]!.id;
  }

  async claimJob(kind: 'solve' | 'dataset-admit', owner: string, leaseSeconds = 30): Promise<Lease | null> {
    const { rows } = await this.pool.query(`WITH candidate AS (
      SELECT tenant_id,id FROM jobs WHERE kind=$1 AND
        (state='queued' OR (state='running' AND lease_expires_at < now()))
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE jobs j SET state='running',lease_owner=$2,lease_expires_at=now()+make_interval(secs=>$3),
        heartbeat_at=now(),attempt=attempt+1,fence=fence+1,updated_at=now()
      FROM candidate c WHERE j.tenant_id=c.tenant_id AND j.id=c.id
      RETURNING j.tenant_id "tenantId",j.id,j.lease_owner owner,j.fence,j.payload,j.attempt`, [kind, owner, leaseSeconds]);
    return rows[0] ? { ...rows[0], fence: Number(rows[0].fence), attempt: Number(rows[0].attempt) } as Lease : null;
  }

  async heartbeatJob(lease: Lease, leaseSeconds = 30): Promise<void> {
    const result = await this.pool.query(`UPDATE jobs SET lease_expires_at=now()+make_interval(secs=>$5),heartbeat_at=now(),updated_at=now()
      WHERE tenant_id=$1 AND id=$2 AND state='running' AND lease_owner=$3 AND fence=$4 AND lease_expires_at>=now()`,
      [lease.tenantId, lease.id, lease.owner, lease.fence, leaseSeconds]);
    if (result.rowCount !== 1) throw new StaleFenceError();
  }

  /** The fence predicate and authoritative plan publication are one transaction. */
  async completeSolve(lease: Lease, planId: string, scenarioId: string, scenarioRevision: number, plan: unknown): Promise<void> {
    await this.tx(async (client) => {
      const owned = await client.query(`UPDATE jobs SET state='succeeded',result=$5,lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
        WHERE tenant_id=$1 AND id=$2 AND state='running' AND lease_owner=$3 AND fence=$4 AND lease_expires_at>=now() RETURNING id`,
        [lease.tenantId, lease.id, lease.owner, lease.fence, { planId }]);
      if (owned.rowCount !== 1) throw new StaleFenceError();
      await client.query(`INSERT INTO plans(tenant_id,id,scenario_id,scenario_revision,body) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(tenant_id,id) DO NOTHING`, [lease.tenantId, planId, scenarioId, scenarioRevision, plan]);
    });
  }

  async failJob(lease: Lease, error: string): Promise<void> {
    const result = await this.pool.query(`UPDATE jobs SET state='failed',error=$5,lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
      WHERE tenant_id=$1 AND id=$2 AND state='running' AND lease_owner=$3 AND fence=$4 AND lease_expires_at>=now()`,
      [lease.tenantId, lease.id, lease.owner, lease.fence, error.slice(0, 2000)]);
    if (result.rowCount !== 1) throw new StaleFenceError();
  }

  /** Immutable uploads happen before this short transaction. The fence owns
   * both job completion and dataset visibility, so a stale converter can leave
   * harmless checksum objects but cannot admit its manifest. */
  async completeDatasetAdmission(lease: Lease, datasetId: string, manifest: unknown, artifacts: AdmissionArtifact[]): Promise<void> {
    await this.tx(async (client) => {
      const owned = await client.query(`UPDATE jobs SET state='succeeded',result=$5,lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
        WHERE tenant_id=$1 AND id=$2 AND kind='dataset-admit' AND state='running' AND lease_owner=$3 AND fence=$4
        AND lease_expires_at>=now() RETURNING id`, [lease.tenantId, lease.id, lease.owner, lease.fence, { datasetId }]);
      if (owned.rowCount !== 1) throw new StaleFenceError();
      for (const artifact of artifacts) {
        const published = await client.query(`INSERT INTO objects(tenant_id,object_key,sha256,size_bytes,media_type,state,published_at)
          VALUES($1,$2,$3,$4,$5,'published',now()) ON CONFLICT(tenant_id,object_key) DO UPDATE SET
          state='published',published_at=coalesce(objects.published_at,now())
          WHERE objects.sha256=excluded.sha256 AND objects.size_bytes=excluded.size_bytes`,
          [lease.tenantId, artifact.key, artifact.sha256, artifact.size, artifact.mediaType]);
        if (published.rowCount !== 1) throw new Error(`immutable object metadata conflict: ${artifact.key}`);
      }
      const dataset = await client.query(`UPDATE datasets SET manifest=$3,status='admitted',validated_at=coalesce(validated_at,now()),
        admitted_at=now(),failure=NULL WHERE tenant_id=$1 AND id=$2 AND status IN ('uploaded','validated') RETURNING id`,
        [lease.tenantId, datasetId, manifest]);
      if (dataset.rowCount !== 1) throw new Error('dataset is missing or already terminal');
    });
  }

  async enqueueEmail(client: PoolClient, tenantId: string, idempotencyKey: string, payload: unknown): Promise<string> {
    const id = randomUUID();
    const { rows } = await client.query<{ id: string }>(`INSERT INTO email_outbox(tenant_id,id,idempotency_key,payload)
      VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,idempotency_key)
      DO UPDATE SET idempotency_key=excluded.idempotency_key RETURNING id`, [tenantId, id, idempotencyKey, payload]);
    return rows[0]!.id;
  }

  async claimEmail(owner: string, leaseSeconds = 30): Promise<OutboxLease | null> {
    const { rows } = await this.pool.query(`WITH candidate AS (
      SELECT tenant_id,id FROM email_outbox WHERE next_attempt_at<=now() AND
        (state='pending' OR (state='sending' AND lease_expires_at < now()))
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE email_outbox o SET state='sending',lease_owner=$1,lease_expires_at=now()+make_interval(secs=>$2),
        attempt=attempt+1,fence=fence+1 FROM candidate c WHERE o.tenant_id=c.tenant_id AND o.id=c.id
      RETURNING o.tenant_id "tenantId",o.id,o.lease_owner owner,o.fence,o.payload,o.attempt,o.idempotency_key "idempotencyKey",o.created_at "createdAt"`,
      [owner, leaseSeconds]);
    return rows[0] ? { ...rows[0], fence: Number(rows[0].fence), attempt: Number(rows[0].attempt) } as OutboxLease : null;
  }

  async emailSent(lease: OutboxLease, providerId: string): Promise<void> {
    const result = await this.pool.query(`UPDATE email_outbox SET state='sent',provider_id=$5,sent_at=now(),lease_owner=NULL,lease_expires_at=NULL
      WHERE tenant_id=$1 AND id=$2 AND state='sending' AND lease_owner=$3 AND fence=$4 AND lease_expires_at>=now()`,
      [lease.tenantId, lease.id, lease.owner, lease.fence, providerId]);
    if (result.rowCount !== 1) throw new StaleFenceError();
  }

  async emailRetry(lease: OutboxLease, error: string, retrySeconds: number): Promise<void> {
    const result = await this.pool.query(`UPDATE email_outbox SET
      state=CASE WHEN created_at < now()-interval '23 hours' THEN 'failed' ELSE 'pending' END,
      last_error=$5,next_attempt_at=now()+make_interval(secs=>$6),lease_owner=NULL,lease_expires_at=NULL
      WHERE tenant_id=$1 AND id=$2 AND state='sending' AND lease_owner=$3 AND fence=$4 AND lease_expires_at>=now()`,
      [lease.tenantId, lease.id, lease.owner, lease.fence, error.slice(0, 2000), retrySeconds]);
    if (result.rowCount !== 1) throw new StaleFenceError();
  }

  async emailFailed(lease: OutboxLease, error: string): Promise<void> {
    const result = await this.pool.query(`UPDATE email_outbox SET state='failed',last_error=$5,lease_owner=NULL,lease_expires_at=NULL
      WHERE tenant_id=$1 AND id=$2 AND state='sending' AND lease_owner=$3 AND fence=$4 AND lease_expires_at>=now()`,
      [lease.tenantId, lease.id, lease.owner, lease.fence, error.slice(0, 2000)]);
    if (result.rowCount !== 1) throw new StaleFenceError();
  }

  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const value = await fn(client); await client.query('COMMIT'); return value; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
}
