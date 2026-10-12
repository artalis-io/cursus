import { randomUUID } from 'node:crypto';
import type { ObjectStore, ImmutableObject } from './objects.js';
import type { StatefulStore } from './postgres.js';

export interface DatasetUpload { datasetId: string; object: ImmutableObject; status: 'uploaded' }

/** Admission lifecycle coordinator. R2 bytes are checksum-addressed and the
 * PostgreSQL row is the visibility boundary; solvers list admitted rows only. */
export class DatasetRepository {
  constructor(private db: StatefulStore, private objects: ObjectStore, private tenantId: string) {}

  async upload(bytes: Uint8Array, mediaType: string, name?: string): Promise<DatasetUpload> {
    if (!bytes.byteLength) throw new Error('empty dataset upload');
    const object = await this.objects.putImmutable(this.tenantId, bytes, mediaType);
    await this.db.stageObject(this.tenantId, object);
    const datasetId = `ds_${randomUUID().slice(0, 10)}`;
    await this.db.createDatasetUpload(this.tenantId, datasetId, { schemaVersion: 1, source: object, name: name ?? null });
    return { datasetId, object, status: 'uploaded' };
  }

  async validate(datasetId: string): Promise<Record<string, unknown>> {
    const current = await this.db.getDataset(this.tenantId, datasetId); if (!current) throw new Error('dataset not found');
    const source = (current.manifest as { source?: ImmutableObject }).source;
    if (!source) throw new Error('dataset source object is missing');
    const bytes = await this.objects.getVerified(source);
    let bundle: { schemaVersion?: unknown; days?: unknown; surgeRequest?: unknown };
    try { bundle = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error('dataset is not valid JSON'); }
    if (bundle.schemaVersion !== 1 || !Array.isArray(bundle.days) || !bundle.days.length || !bundle.surgeRequest || typeof bundle.surgeRequest !== 'object')
      throw new Error('unsupported dataset bundle (requires schemaVersion=1, days[], and surgeRequest)');
    const manifest = { ...(current.manifest as object), validation: { valid: true, schemaVersion: 1, days: bundle.days } };
    await this.db.validateDataset(this.tenantId, datasetId, manifest);
    return (await this.db.getDataset(this.tenantId, datasetId))!;
  }

  async admit(datasetId: string, derived: ImmutableObject[] = []): Promise<Record<string, unknown>> {
    const current = await this.db.getDataset(this.tenantId, datasetId); if (!current) throw new Error('dataset not found');
    for (const object of derived) await this.db.stageObject(this.tenantId, object);
    const manifest = current.manifest as { source?: ImmutableObject };
    const objects = [manifest.source, ...derived].filter((x): x is ImmutableObject => Boolean(x));
    await this.db.publishDataset(this.tenantId, datasetId, { ...manifest, objects }, objects.map((x) => x.key));
    return (await this.db.getDataset(this.tenantId, datasetId))!;
  }

  get(id: string): Promise<Record<string, unknown> | null> { return this.db.getDataset(this.tenantId, id); }
  list(): Promise<Record<string, unknown>[]> { return this.db.listDatasets(this.tenantId, true); }

  /** Read-only orphan inventory. Objects absent from PostgreSQL cannot be
   * solver-visible; operators may garbage-collect them after a retention age. */
  async orphanKeys(): Promise<string[]> {
    const keys = await this.objects.listTenantKeys(this.tenantId);
    const { rows } = await this.db.pool.query<{ object_key: string }>('SELECT object_key FROM objects WHERE tenant_id=$1', [this.tenantId]);
    const known = new Set(rows.map((r) => r.object_key));
    return keys.filter((key) => !known.has(key));
  }
}
