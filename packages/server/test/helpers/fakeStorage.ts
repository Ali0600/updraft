import { Readable } from 'node:stream';
import type {
  BlobReadStream,
  BlobStat,
  BlobStorage,
  PutOptions,
} from '../../src/storage/BlobStorage.js';

export interface FakeStorage extends BlobStorage {
  /** Every key written, so tests can assert what was stored. */
  readonly blobs: Map<string, { data: Buffer; contentType?: string | undefined }>;
  /** Keys passed to each method, so tests can assert what was *asked for*. */
  readonly calls: {
    stat: string[];
    has: string[];
    put: string[];
    get: string[];
    getStream: string[];
  };
}

export interface FakeStorageOptions {
  /** Throw from every read, to exercise the failure path of a caller. */
  failReads?: Error | undefined;
}

/**
 * One in-memory double, so the next change to the BlobStorage interface
 * touches this file rather than every inline literal in the suite.
 */
export function createFakeStorage(options: FakeStorageOptions = {}): FakeStorage {
  const blobs = new Map<string, { data: Buffer; contentType?: string | undefined }>();
  const calls = {
    stat: [] as string[],
    has: [] as string[],
    put: [] as string[],
    get: [] as string[],
    getStream: [] as string[],
  };

  const storage: FakeStorage = {
    blobs,
    calls,
    async stat(key: string): Promise<BlobStat | undefined> {
      calls.stat.push(key);
      if (options.failReads) throw options.failReads;
      const blob = blobs.get(key);
      if (!blob) return undefined;
      return {
        size: blob.data.length,
        ...(blob.contentType ? { contentType: blob.contentType } : {}),
      };
    },
    async has(key: string): Promise<boolean> {
      calls.has.push(key);
      if (options.failReads) throw options.failReads;
      return blobs.has(key);
    },
    async put(key: string, data: Buffer, putOptions?: PutOptions): Promise<void> {
      calls.put.push(key);
      blobs.set(key, { data, contentType: putOptions?.contentType });
    },
    async get(key: string): Promise<Buffer | undefined> {
      calls.get.push(key);
      if (options.failReads) throw options.failReads;
      return blobs.get(key)?.data;
    },
    async getStream(key: string): Promise<BlobReadStream | undefined> {
      calls.getStream.push(key);
      if (options.failReads) throw options.failReads;
      const blob = blobs.get(key);
      if (!blob) return undefined;
      return {
        stream: Readable.from(blob.data),
        size: blob.data.length,
        ...(blob.contentType ? { contentType: blob.contentType } : {}),
      };
    },
  };

  return storage;
}
