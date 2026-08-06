import {
  GetObjectCommand,
  type GetObjectCommandOutput,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import type { BlobStat, BlobStorage, PutOptions } from './BlobStorage.js';

export interface S3StorageOptions {
  bucket: string;
  region: string;
  endpoint?: string | undefined;
  forcePathStyle?: boolean | undefined;
  credentials?: { accessKeyId: string; secretAccessKey: string } | undefined;
  /** Tests pass 1 so the failure cases do not sit through the retry schedule. */
  maxAttempts?: number | undefined;
}

/**
 * True only when the store is telling us this key is not there.
 *
 * Everything else — expired credentials, a wrong bucket, DNS, a 503 — must
 * propagate. A credentials failure that reads as "absent" turns every asset
 * into a silent 404 while the operator sees a perfectly healthy server.
 *
 * Matching is by error *name*, never by a bare 404 status. Measured against
 * MinIO, every one of these is a 404:
 *
 *   GetObject,  missing key    -> NoSuchKey
 *   GetObject,  missing bucket -> NoSuchBucket
 *   HeadObject, missing key    -> NotFound
 *   HeadObject, missing bucket -> NotFound
 *
 * so a status check alone would report a misconfigured bucket name as an
 * empty store. Note what is also deliberately absent: 403 AccessDenied, which
 * S3 returns instead of 404 for a missing object when the caller lacks
 * `s3:ListBucket` — treating that as an absence would hide a permissions
 * mistake behind an apparently empty bucket.
 */
function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string }).name;
  return name === 'NoSuchKey' || name === 'NotFound';
}

export class S3Storage implements BlobStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(options: S3StorageOptions) {
    this.bucket = options.bucket;
    // Spread conditionally rather than assigning undefined: under
    // exactOptionalPropertyTypes an explicit undefined is a type error.
    const config: S3ClientConfig = {
      region: options.region,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      ...(options.forcePathStyle === undefined ? {} : { forcePathStyle: options.forcePathStyle }),
      ...(options.credentials ? { credentials: options.credentials } : {}),
      ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    };
    this.client = new S3Client(config);
  }

  /**
   * Caveat forced by the protocol: HeadObject answers with an empty body, so
   * a missing bucket and a missing key are byte-identical (`NotFound`, 404).
   * This method therefore cannot detect a wrong bucket name — `get` can, and
   * `put` fails loudly, so the readiness probe uses `get` deliberately.
   */
  async stat(key: string): Promise<BlobStat | undefined> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        size: response.ContentLength ?? 0,
        ...(response.ContentType ? { contentType: response.ContentType } : {}),
      };
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async has(key: string): Promise<boolean> {
    // Routed through stat so the absent-versus-error distinction cannot
    // diverge between the two.
    return (await this.stat(key)) !== undefined;
  }

  async put(key: string, data: Buffer, options?: PutOptions): Promise<void> {
    // S3 writes are atomic: no reader ever sees a half-written object, which
    // is why this needs no analogue of the local driver's temp-file rename.
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentLength: data.length,
        ContentType: options?.contentType ?? 'application/octet-stream',
      }),
    );
  }

  async get(key: string): Promise<Buffer | undefined> {
    let response: GetObjectCommandOutput;
    try {
      response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }

    // An absent body is an SDK anomaly, not an absent key — returning
    // undefined here would report a broken response as an empty store. The
    // catch above deliberately does not wrap this.
    if (!response.Body) throw new Error(`S3 returned no body for ${key}`);

    // Consume immediately. An unread stream holds its socket open, and doing
    // this first leaves no path where a later throw could strand one.
    return Buffer.from(await response.Body.transformToByteArray());
  }

  destroy(): void {
    this.client.destroy();
  }
}
