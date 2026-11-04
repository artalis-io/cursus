import { createHash } from 'node:crypto';
import { ObjectGate, ObjectStoreError } from './object-transport.js';
export { ObjectStoreError } from './object-transport.js';
import { GetObjectCommand, HeadBucketCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
export interface ImmutableObject {
    key: string;
    sha256: string;
    size: number;
    mediaType: string;
}
/** Narrow S3 contract: immutable checksum-addressed writes and verified reads. */
export class ObjectStore {
    private client: S3Client;
    private probeClient: S3Client;
    private gate: ObjectGate;
    private closed = false;
    private controllers = new Set<AbortController>();
    private probe: Promise<void> | null = null;
    private cachedProbe: {
        until: number;
        error?: ObjectStoreError;
    } | null = null;
    private operationMs: number;
    private probeMs: number;
    private cacheMs: number;
    private counters = { completed: 0, failures: 0, timeouts: 0, rejected: 0, probes: 0 };
    private readyState: 'unknown' | 'ready' | 'unavailable' = 'unknown';
    private lastSuccess: number | null = null;
    private lastWarning = -Infinity;
    private observe?: (event: Record<string, unknown>) => void;
    constructor(private bucket: string, options: {
        endpoint?: string;
        region?: string;
        accessKeyId?: string;
        secretAccessKey?: string;
        operationMs?: number;
        probeMs?: number;
        cacheMs?: number;
        concurrency?: number;
        queueLimit?: number;
        onEvent?: (event: Record<string, unknown>) => void;
    } = {}) {
        this.operationMs = options.operationMs ?? 300000;
        this.probeMs = options.probeMs ?? 2000;
        this.cacheMs = options.cacheMs ?? 2000;
        const concurrency = options.concurrency ?? 8, queueLimit = options.queueLimit ?? 16;
        for (const [name, value] of Object.entries({ operationMs: this.operationMs, probeMs: this.probeMs, concurrency }))
            if (!Number.isSafeInteger(value) || value < 1)
                throw new Error(`Invalid object storage ${name}`);
        for (const [name, value] of Object.entries({ cacheMs: this.cacheMs, queueLimit }))
            if (!Number.isSafeInteger(value) || value < 0)
                throw new Error(`Invalid object storage ${name}`);
        this.observe = options.onEvent;
        this.gate = new ObjectGate(concurrency, queueLimit);
        const base = { region: options.region ?? 'us-east-1', endpoint: options.endpoint, forcePathStyle: Boolean(options.endpoint),
            credentials: options.accessKeyId && options.secretAccessKey ? { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey } : undefined };
        // Separate agents keep health traffic independent of uploads/downloads. SDK
        // retries remain inside the operation's total deadline and admission slot.
        this.client = new S3Client({ ...base, maxAttempts: 3, retryMode: 'standard', requestHandler: { connectionTimeout: 2000,
                socketTimeout: 15000, requestTimeout: this.operationMs, throwOnRequestTimeout: true,
                httpAgent: { keepAlive: true, maxSockets: concurrency, maxFreeSockets: concurrency },
                httpsAgent: { keepAlive: true, maxSockets: concurrency, maxFreeSockets: concurrency } } });
        this.probeClient = new S3Client({ ...base, maxAttempts: 1, requestHandler: { connectionTimeout: this.probeMs,
                requestTimeout: this.probeMs, socketTimeout: this.probeMs, throwOnRequestTimeout: true,
                httpAgent: { keepAlive: false, maxSockets: 1 }, httpsAgent: { keepAlive: false, maxSockets: 1 } } });
    }
    diagnostics() {
        return { ...this.counters, active: this.gate.active, pending: this.gate.pending,
            readiness: this.readyState, lastSuccessAgeMs: this.lastSuccess === null ? null : Date.now() - this.lastSuccess };
    }
    /** Never include provider errors, object keys, bucket names, endpoints or credentials. */
    private event(event: string, code?: string) {
        try {
            this.observe?.({ component: 'object-storage', event, ...(code ? { code } : {}), ...this.diagnostics() });
        }
        catch { /* telemetry must not change storage outcomes */ }
    }
    private async operation<T>(work: (signal: AbortSignal) => Promise<T>, probe = false): Promise<T> {
        if (this.closed)
            throw new ObjectStoreError('closed');
        const controller = new AbortController();
        this.controllers.add(controller);
        let release: (() => void) | undefined, timedOut = false;
        const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, probe ? this.probeMs : this.operationMs);
        let rejectAbort: (() => void) | undefined;
        const aborted = new Promise<never>((_, reject) => { rejectAbort = () => reject(new ObjectStoreError(timedOut ? 'timeout' : 'closed')); controller.signal.addEventListener('abort', rejectAbort, { once: true }); });
        try {
            const execute = async () => { if (!probe)
                release = await this.gate.acquire(controller.signal); controller.signal.throwIfAborted(); return work(controller.signal); };
            const result = await Promise.race([execute(), aborted]);
            this.counters.completed++;
            return result;
        }
        catch (error) {
            const transportTimeout = error instanceof Error && ['TimeoutError', 'RequestTimeout'].includes(error.name);
            const safe = timedOut || transportTimeout ? new ObjectStoreError('timeout') : this.closed ? new ObjectStoreError('closed') : error instanceof ObjectStoreError ? error : new ObjectStoreError('unavailable');
            if (safe.code !== 'closed')
                this.counters.failures++;
            if (safe.code === 'timeout')
                this.counters.timeouts++;
            if (safe.code === 'busy')
                this.counters.rejected++;
            if (!probe && safe.code !== 'closed' && Date.now() - this.lastWarning >= 30000) {
                this.lastWarning = Date.now();
                this.event('operation-failed', safe.code);
            }
            throw safe;
        }
        finally {
            clearTimeout(deadline);
            if (rejectAbort)
                controller.signal.removeEventListener('abort', rejectAbort);
            this.controllers.delete(controller);
            release?.();
        }
    }
    close(): void {
        this.closed = true;
        for (const controller of this.controllers)
            controller.abort();
        this.client.destroy();
        this.probeClient.destroy();
        this.cachedProbe = null;
        this.readyState = 'unknown';
    }
    async putImmutable(tenantId: string, bytes: Uint8Array, mediaType: string): Promise<ImmutableObject> {
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const key = `tenants/${tenantId}/sha256/${sha256}`;
        return this.operation(async (signal) => {
            try {
                const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: signal });
                if (head.Metadata?.sha256 !== sha256 || head.ContentLength !== bytes.byteLength)
                    throw new ObjectStoreError('integrity');
            }
            catch (error: any) {
                if (error?.$metadata?.httpStatusCode !== 404 && error?.name !== 'NotFound')
                    throw error;
                try {
                    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ContentType: mediaType,
                        Metadata: { sha256 }, IfNoneMatch: '*' }), { abortSignal: signal });
                }
                catch (error: any) {
                    // Another writer (or an accepted PUT whose response was lost) may win.
                    // Reconcile only a conditional conflict, never replace existing bytes.
                    if (error?.$metadata?.httpStatusCode !== 412)
                        throw error;
                    const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: signal });
                    if (head.Metadata?.sha256 !== sha256 || head.ContentLength !== bytes.byteLength)
                        throw new ObjectStoreError('integrity');
                }
            }
            return { key, sha256, size: bytes.byteLength, mediaType };
        });
    }
    async getVerified(object: ImmutableObject): Promise<Uint8Array> {
        return this.operation(async (signal) => {
            const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: object.key }), { abortSignal: signal });
            const body = response.Body;
            if (!body)
                throw new ObjectStoreError('integrity');
            const destroy = () => { if ('destroy' in body)
                body.destroy(); };
            signal.addEventListener('abort', destroy, { once: true });
            try {
                if (signal.aborted) {
                    destroy();
                    signal.throwIfAborted();
                }
                const bytes = await body.transformToByteArray();
                if (createHash('sha256').update(bytes).digest('hex') !== object.sha256 || bytes.byteLength !== object.size)
                    throw new ObjectStoreError('integrity');
                return bytes;
            }
            finally {
                signal.removeEventListener('abort', destroy);
                destroy();
            }
        });
    }
    ready(): Promise<void> {
        if (this.closed)
            return Promise.reject(new ObjectStoreError('closed'));
        if (this.probe)
            return this.probe;
        if (this.cachedProbe && Date.now() < this.cachedProbe.until)
            return this.cachedProbe.error ? Promise.reject(this.cachedProbe.error) : Promise.resolve();
        this.counters.probes++;
        this.probe = this.operation(async (signal) => { await this.probeClient.send(new HeadBucketCommand({ Bucket: this.bucket }), { abortSignal: signal }); }, true)
            .then(() => { this.cachedProbe = { until: Date.now() + this.cacheMs }; this.lastSuccess = Date.now(); const old = this.readyState; this.readyState = 'ready'; if (old !== 'ready')
            this.event(old === 'unavailable' ? 'recovered' : 'ready'); }, error => {
            if (this.closed)
                throw error;
            this.cachedProbe = { until: Date.now() + Math.min(this.cacheMs, 1000), error };
            const old = this.readyState;
            this.readyState = 'unavailable';
            if (old !== 'unavailable')
                this.event('unavailable', error.code);
            throw error;
        }).finally(() => { this.probe = null; });
        return this.probe;
    }
    /** Inventory checksum objects for reconciliation/GC. Listing is paginated;
     * callers decide retention and deletion policy. */
    async listTenantKeys(tenantId: string): Promise<string[]> {
        return this.operation(async (signal) => {
            const prefix = `tenants/${tenantId}/sha256/`;
            const keys: string[] = [];
            let continuationToken: string | undefined;
            do {
                const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: continuationToken }), { abortSignal: signal });
                for (const item of page.Contents ?? [])
                    if (item.Key)
                        keys.push(item.Key);
                const next = page.IsTruncated ? page.NextContinuationToken : undefined;
                if (page.IsTruncated && (!next || next === continuationToken))
                    throw new ObjectStoreError('unavailable');
                continuationToken = next;
            } while (continuationToken);
            return keys;
        });
    }
}
