import type { Metrics, StorageOperation } from '../metrics.js';
import type { BlobStat, BlobStorage, PutOptions } from './BlobStorage.js';

/**
 * Wraps any driver with metrics, so instrumentation lives in one place rather
 * than in each implementation — and injected test doubles stay plain objects.
 *
 * The `missing` versus `error` distinction is deliberate: it is the invariant
 * the S3 driver exists to preserve, so it is worth being able to graph.
 */
export function instrumentedStorage(storage: BlobStorage, metrics: Metrics): BlobStorage {
  async function observe<T>(
    operation: StorageOperation,
    run: () => Promise<T>,
    isMissing: (value: T) => boolean,
  ): Promise<T> {
    const done = metrics.storageDuration.startTimer({ operation });
    try {
      const value = await run();
      done();
      metrics.storageOperations.inc({
        operation,
        result: isMissing(value) ? 'missing' : 'ok',
      });
      return value;
    } catch (error) {
      done();
      metrics.storageOperations.inc({ operation, result: 'error' });
      throw error;
    }
  }

  return {
    stat: (key: string): Promise<BlobStat | undefined> =>
      observe(
        'stat',
        () => storage.stat(key),
        (value) => value === undefined,
      ),
    has: (key: string): Promise<boolean> =>
      observe(
        'stat',
        () => storage.has(key),
        (value) => !value,
      ),
    get: (key: string): Promise<Buffer | undefined> =>
      observe(
        'get',
        () => storage.get(key),
        (value) => value === undefined,
      ),
    put: (key: string, data: Buffer, options?: PutOptions): Promise<void> =>
      observe(
        'put',
        () => storage.put(key, data, options),
        () => false,
      ),
  };
}
