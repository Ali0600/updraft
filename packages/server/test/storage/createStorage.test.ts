import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createStorage } from '../../src/storage/createStorage.js';
import { LocalFsStorage } from '../../src/storage/localFs.js';
import { S3Storage } from '../../src/storage/s3.js';
import { TEST_PUBLISH_TOKEN } from '../helpers/testConfig.js';

const base = { PUBLIC_URL: 'http://localhost:3000', PUBLISH_TOKEN: TEST_PUBLISH_TOKEN };

/** Reaches the private client config to prove what was actually wired. */
function clientConfigOf(storage: S3Storage): { forcePathStyle?: unknown } {
  return (storage as unknown as { client: { config: { forcePathStyle?: unknown } } }).client.config;
}

async function resolvedForcePathStyle(storage: S3Storage): Promise<unknown> {
  const value = clientConfigOf(storage).forcePathStyle;
  return typeof value === 'function' ? await (value as () => Promise<unknown>)() : value;
}

describe('createStorage', () => {
  it('builds the local driver by default', () => {
    expect(createStorage(loadConfig(base))).toBeInstanceOf(LocalFsStorage);
  });

  it('builds the S3 driver when configured', () => {
    const config = loadConfig({ ...base, STORAGE_DRIVER: 's3', S3_BUCKET: 'updates' });
    expect(createStorage(config)).toBeInstanceOf(S3Storage);
  });

  it('does no I/O at boot, so an unreachable store cannot stop the server starting', () => {
    // Reachability is the readiness probe's job; a boot-time bucket check
    // would turn a transient outage into a restart loop that fixes nothing.
    const config = loadConfig({
      ...base,
      STORAGE_DRIVER: 's3',
      S3_BUCKET: 'nope',
      S3_ENDPOINT: 'http://127.0.0.1:1',
    });
    expect(() => createStorage(config)).not.toThrow();
  });

  it('enables path-style addressing when a custom endpoint is set', async () => {
    // MinIO and most self-hosted gateways require it; AWS deprecated it.
    const config = loadConfig({
      ...base,
      STORAGE_DRIVER: 's3',
      S3_BUCKET: 'updates',
      S3_ENDPOINT: 'http://127.0.0.1:9000',
    });
    const storage = createStorage(config) as S3Storage;
    expect(await resolvedForcePathStyle(storage)).toBe(true);
  });

  it('leaves path-style off for AWS, where it is deprecated', async () => {
    const config = loadConfig({ ...base, STORAGE_DRIVER: 's3', S3_BUCKET: 'updates' });
    const storage = createStorage(config) as S3Storage;
    expect(await resolvedForcePathStyle(storage)).toBe(false);
  });

  it('lets an explicit S3_FORCE_PATH_STYLE override the endpoint-derived default', async () => {
    const config = loadConfig({
      ...base,
      STORAGE_DRIVER: 's3',
      S3_BUCKET: 'updates',
      S3_ENDPOINT: 'http://127.0.0.1:9000',
      S3_FORCE_PATH_STYLE: 'false',
    });
    const storage = createStorage(config) as S3Storage;
    expect(await resolvedForcePathStyle(storage)).toBe(false);
  });
});
