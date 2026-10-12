import { createHash } from 'node:crypto';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export interface ImmutableObject { key: string; sha256: string; size: number; mediaType: string }

/** Narrow S3 contract: immutable checksum-addressed writes and verified reads. */
export class ObjectStore {
  private client: S3Client;
  constructor(private bucket: string, options: { endpoint?: string; region?: string; accessKeyId?: string; secretAccessKey?: string } = {}) {
    this.client = new S3Client({ region: options.region ?? 'us-east-1', endpoint: options.endpoint,
      forcePathStyle: Boolean(options.endpoint), credentials: options.accessKeyId && options.secretAccessKey ?
        { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey } : undefined });
  }
  async putImmutable(tenantId: string, bytes: Uint8Array, mediaType: string): Promise<ImmutableObject> {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const key = `tenants/${tenantId}/sha256/${sha256}`;
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      if (head.Metadata?.sha256 !== sha256 || head.ContentLength !== bytes.byteLength) throw new Error('immutable object collision or metadata mismatch');
    } catch (error: any) {
      if (error?.$metadata?.httpStatusCode !== 404 && error?.name !== 'NotFound') throw error;
      await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ContentType: mediaType,
        Metadata: { sha256 }, IfNoneMatch: '*' }));
    }
    return { key, sha256, size: bytes.byteLength, mediaType };
  }
  async getVerified(object: ImmutableObject): Promise<Uint8Array> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: object.key }));
    const bytes = await response.Body!.transformToByteArray();
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== object.sha256 || bytes.byteLength !== object.size) throw new Error('object checksum mismatch');
    return bytes;
  }
}
