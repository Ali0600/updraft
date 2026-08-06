import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { Metrics } from '../metrics.js';
import { assetStorageKey, type BlobStorage } from '../storage/BlobStorage.js';

export interface ReadinessReport {
  ready: boolean;
  checks: { database: 'ok' | 'unavailable'; storage: 'ok' | 'unavailable' };
}

/** How long an answer is reused. Bounds the load an open endpoint can create. */
const PROBE_TTL_MS = 5_000;
/** A black-holed store must not leave requests hanging until socket timeouts. */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * A key no real digest can produce, addressed through the same derivation the
 * server uses. Staying inside the `assets/` prefix matters: a probe key
 * outside it would be denied by a least-privilege bucket policy and report a
 * healthy deployment as broken.
 */
const PROBE_KEY = assetStorageKey('0'.repeat(64));

export interface ReadinessOptions {
  db: Db;
  storage: BlobStorage;
  metrics?: Metrics | undefined;
  log?: { error: (details: unknown, message: string) => void } | undefined;
}

export type ReadinessProbe = () => Promise<ReadinessReport>;

/**
 * Builds a probe that is cached and single-flighted.
 *
 * `/readyz` cannot require a token — orchestrators do not carry one — so a
 * naive implementation turns one free HTTP request into one paid S3 request at
 * whatever rate a caller chooses. With a shared in-flight promise and a short
 * TTL, the process makes at most one dependency call per interval no matter
 * how often it is asked.
 */
export function createReadinessProbe(options: ReadinessOptions): ReadinessProbe {
  let cached: { at: number; report: ReadinessReport } | undefined;
  let inFlight: Promise<ReadinessReport> | undefined;

  async function probe(): Promise<ReadinessReport> {
    const database = checkDatabase();
    const storage = await checkStorage();

    options.metrics?.dependencyUp.set({ dependency: 'database' }, database ? 1 : 0);
    options.metrics?.dependencyUp.set({ dependency: 'storage' }, storage ? 1 : 0);

    return {
      ready: database && storage,
      checks: {
        database: database ? 'ok' : 'unavailable',
        storage: storage ? 'ok' : 'unavailable',
      },
    };
  }

  function checkDatabase(): boolean {
    try {
      options.db.get(sql`select 1`);
      return true;
    } catch (error) {
      // Detail goes to the log, never to an unauthenticated response.
      options.log?.error({ err: error }, 'readiness: database probe failed');
      return false;
    }
  }

  async function checkStorage(): Promise<boolean> {
    try {
      // Reads rather than stats: HeadObject cannot distinguish a missing
      // bucket from a missing key (both NotFound/404), so a stat-based probe
      // would report a misconfigured bucket as healthy. A GET of an absent key
      // transfers no payload and does distinguish them.
      await withTimeout(options.storage.get(PROBE_KEY));
      return true;
    } catch (error) {
      options.log?.error({ err: error }, 'readiness: storage probe failed');
      return false;
    }
  }

  return async function readiness(): Promise<ReadinessReport> {
    const now = Date.now();
    if (cached && now - cached.at < PROBE_TTL_MS) return cached.report;
    if (inFlight) return inFlight;

    inFlight = probe()
      .then((report) => {
        cached = { at: Date.now(), report };
        return report;
      })
      .finally(() => {
        inFlight = undefined;
      });

    return inFlight;
  };
}

function withTimeout<T>(work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('readiness probe timed out')), PROBE_TIMEOUT_MS).unref(),
    ),
  ]);
}
