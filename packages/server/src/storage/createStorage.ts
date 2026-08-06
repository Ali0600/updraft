import type { Config } from '../config.js';
import type { BlobStorage } from './BlobStorage.js';
import { LocalFsStorage } from './localFs.js';
import { S3Storage } from './s3.js';

/**
 * Builds the configured driver.
 *
 * Deliberately performs no I/O: constructing an S3 client makes no network
 * call, and that is the right split. Configuration validity fails closed at
 * boot; *reachability* is the readiness probe's job. A boot-time bucket check
 * would turn a transient S3 blip into a restart loop that fixes nothing.
 */
export function createStorage(config: Config): BlobStorage {
  if (config.STORAGE_DRIVER === 's3') {
    // Guaranteed by the config refinement; asserted so a future edit to the
    // schema cannot silently produce a bucketless client.
    if (!config.S3_BUCKET) {
      throw new Error('S3_BUCKET is required when STORAGE_DRIVER=s3');
    }
    return new S3Storage({
      bucket: config.S3_BUCKET,
      region: config.S3_REGION,
      ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT } : {}),
      forcePathStyle: config.S3_FORCE_PATH_STYLE ?? Boolean(config.S3_ENDPOINT),
      ...(config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY
        ? {
            credentials: {
              accessKeyId: config.S3_ACCESS_KEY_ID,
              secretAccessKey: config.S3_SECRET_ACCESS_KEY,
            },
          }
        : {}),
    });
  }

  return new LocalFsStorage(config.STORAGE_LOCAL_ROOT);
}
