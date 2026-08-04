import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { createDb, type Db, type DbHandle } from './db/client.js';
import { MIGRATIONS_FOLDER } from './db/migrationsPath.js';
import { adminRoutes } from './routes/admin.js';
import { assetRoutes } from './routes/assets.js';
import { healthRoutes } from './routes/health.js';
import { manifestRoutes } from './routes/manifest.js';
import type { BlobStorage } from './storage/BlobStorage.js';
import { LocalFsStorage } from './storage/localFs.js';

export interface BuildAppOptions {
  config: Config;
  /** Tests inject an in-memory database and a temp-dir storage driver. */
  db?: Db;
  storage?: BlobStorage;
}

/**
 * Builds the Fastify instance without listening, so tests can drive it through
 * `app.inject()` instead of binding a port.
 */
export async function buildApp({
  config,
  db: injectedDb,
  storage: injectedStorage,
}: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Credentials must never reach the log stream, including on error paths.
      redact: {
        paths: ['req.headers.authorization'],
        censor: '[redacted]',
      },
      // Spread rather than assign undefined: exactOptionalPropertyTypes makes
      // an explicit `transport: undefined` a type error.
      ...(config.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
        : {}),
    },
    bodyLimit: 1024 * 1024,
  });

  let ownedDb: DbHandle | undefined;
  let db = injectedDb;
  if (!db) {
    ownedDb = createDb({ path: config.DB_PATH, migrationsFolder: MIGRATIONS_FOLDER });
    db = ownedDb.db;
    app.addHook('onClose', () => ownedDb?.close());
  }

  const storage = injectedStorage ?? new LocalFsStorage(config.STORAGE_LOCAL_ROOT);

  app.decorate('config', config);

  await app.register(healthRoutes);
  await app.register(manifestRoutes, { db, config });
  await app.register(assetRoutes, { db, storage });
  await app.register(adminRoutes, { db, storage, config });

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
  }
}
