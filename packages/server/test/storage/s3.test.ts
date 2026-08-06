import { beforeAll, expect, it } from 'vitest';
import { createTestBucket, describeS3, s3StorageFor } from '../helpers/minio.js';
import { runBlobStorageContract } from './blobStorageContract.js';

describeS3('S3Storage', () => {
  let bucket: string;

  beforeAll(async () => {
    bucket = await createTestBucket();
  });

  runBlobStorageContract('S3Storage', () => {
    let counter = 0;
    return {
      storage: s3StorageFor(bucket),
      key: () => `assets/${Date.now()}-${counter++}`,
    };
  });

  it('records the content type given at put time', async () => {
    const storage = s3StorageFor(bucket);
    await storage.put('assets/typed', Buffer.from('x'), { contentType: 'application/javascript' });
    expect(await storage.stat('assets/typed')).toMatchObject({
      contentType: 'application/javascript',
    });
  });

  // These four are the reason this suite runs against a real server. A mock
  // would require inventing each error shape — that is, assuming the exact
  // thing under test. Every one of them must be distinguishable from "the key
  // is not there", because a failure that reads as an absence turns a broken
  // deployment into a silently empty one.
  it('rejects a read against a nonexistent bucket, rather than reporting absence', async () => {
    const storage = s3StorageFor('updraft-no-such-bucket-zzz', { maxAttempts: 1 });
    await expect(storage.get('assets/x')).rejects.toThrow(/NoSuchBucket|bucket/i);
  });

  it('cannot distinguish a missing bucket from a missing key via stat', async () => {
    // Pinning a protocol limitation, not endorsing it. HeadObject replies with
    // an empty body, so both cases are NotFound/404 with nothing to tell them
    // apart. This is precisely why the readiness probe reads with `get`, and
    // this test exists so that if a future SDK or provider starts
    // distinguishing them, we find out rather than assume.
    const storage = s3StorageFor('updraft-no-such-bucket-zzz', { maxAttempts: 1 });
    expect(await storage.stat('assets/x')).toBeUndefined();
  });

  it('rejects on bad credentials, rather than reporting absence', async () => {
    const storage = s3StorageFor(bucket, {
      credentials: { accessKeyId: 'updraft-test-key', secretAccessKey: 'wrong-secret-value' },
      maxAttempts: 1,
    });
    await expect(storage.get('assets/x')).rejects.toThrow();
    await expect(storage.stat('assets/x')).rejects.toThrow();
  });

  it('rejects when the endpoint is unreachable, rather than reporting absence', async () => {
    const storage = s3StorageFor(bucket, { endpoint: 'http://127.0.0.1:1', maxAttempts: 1 });
    await expect(storage.get('assets/x')).rejects.toThrow();
    await expect(storage.stat('assets/x')).rejects.toThrow();
  });

  it('reports undefined only for a genuinely absent key in a healthy bucket', async () => {
    const storage = s3StorageFor(bucket);
    expect(await storage.get('assets/definitely-not-here')).toBeUndefined();
    expect(await storage.stat('assets/definitely-not-here')).toBeUndefined();
  });
});
