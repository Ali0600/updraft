import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { createDb, type Db } from '../../src/db/client.js';
import { MIGRATIONS_FOLDER } from '../../src/db/migrationsPath.js';
import type { BlobStorage } from '../../src/storage/BlobStorage.js';
import { LocalFsStorage } from '../../src/storage/localFs.js';
import { testConfig } from './testConfig.js';

export interface TestHarness {
  app: FastifyInstance;
  db: Db;
  storage: BlobStorage;
  storageRoot: string;
  close(): Promise<void>;
}

/**
 * A real server on an in-memory database and a temp storage dir — no mocks, so
 * migrations, SQL, and the storage driver are all genuinely exercised.
 */
export async function createTestApp(
  env: NodeJS.ProcessEnv = {},
  /** Lets a test wrap the driver to assert it is never reached. */
  wrapStorage: (storage: BlobStorage) => BlobStorage = (storage) => storage,
): Promise<TestHarness> {
  const storageRoot = mkdtempSync(join(tmpdir(), 'ota-test-'));
  const handle = createDb({ path: ':memory:', migrationsFolder: MIGRATIONS_FOLDER });
  const storage = wrapStorage(new LocalFsStorage(storageRoot));
  const app = await buildApp({ config: testConfig(env), db: handle.db, storage });

  return {
    app,
    db: handle.db,
    storage,
    storageRoot,
    close: async () => {
      await app.close();
      handle.close();
      rmSync(storageRoot, { recursive: true, force: true });
    },
  };
}
