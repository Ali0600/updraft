import { randomBytes } from 'node:crypto';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { describe } from 'vitest';
import { S3Storage, type S3StorageOptions } from '../../src/storage/s3.js';

const endpoint = process.env.S3_TEST_ENDPOINT;
const accessKeyId = process.env.S3_TEST_ACCESS_KEY_ID;
const secretAccessKey = process.env.S3_TEST_SECRET_ACCESS_KEY;

/**
 * Skipping locally is a convenience. Skipping in CI would silently delete the
 * only coverage the S3 driver has, and a suite that reports green while
 * testing nothing is worse than no suite at all.
 */
if (!endpoint && process.env.CI === 'true') {
  throw new Error(
    'S3 tests must run in CI: start MinIO and set S3_TEST_ENDPOINT / S3_TEST_ACCESS_KEY_ID / S3_TEST_SECRET_ACCESS_KEY',
  );
}

// Narrowed to the call signature actually used: vitest's full suite type
// references internals that cannot be named from here, and `describe.skip` is
// not assignable to `typeof describe`.
export const describeS3: (name: string, fn: () => void) => void = endpoint
  ? describe
  : describe.skip;

export const s3TestConfig = {
  endpoint: endpoint ?? 'http://127.0.0.1:9000',
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: accessKeyId ?? 'updraft-test-key',
    secretAccessKey: secretAccessKey ?? 'updraft-test-secret-0123456789',
  },
};

export function s3TestClient(): S3Client {
  return new S3Client(s3TestConfig);
}

/** A fresh bucket per suite, so no test can be perturbed by another. */
export async function createTestBucket(): Promise<string> {
  const bucket = `updraft-test-${randomBytes(6).toString('hex')}`;
  const client = s3TestClient();
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  client.destroy();
  return bucket;
}

export function s3StorageFor(bucket: string, overrides: Partial<S3StorageOptions> = {}): S3Storage {
  return new S3Storage({ ...s3TestConfig, bucket, ...overrides });
}
