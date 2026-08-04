import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface DbHandle {
  db: Db;
  close(): void;
}

export interface CreateDbOptions {
  /** A filesystem path, or ':memory:' for tests. */
  path: string;
  migrationsFolder: string;
}

export function createDb({ path, migrationsFolder }: CreateDbOptions): DbHandle {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  const sqlite = new Database(path);
  // WAL lets readers proceed during a write. Foreign keys are off by default
  // in SQLite, so the cascade rules in the schema would silently do nothing.
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });

  return {
    db,
    close: () => sqlite.close(),
  };
}
