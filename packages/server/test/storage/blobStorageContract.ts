import { describe, expect, it } from 'vitest';
import type { BlobStorage } from '../../src/storage/BlobStorage.js';

export interface ContractHarness {
  storage: BlobStorage;
  /** A key guaranteed unique to one test, so cases cannot interfere. */
  key(): string;
}

/**
 * The behaviour every driver must share. It is deliberately written against
 * the interface rather than any implementation: run it against the local
 * driver (which already passes) to prove the suite describes the contract,
 * then against a new driver to find out where that driver disagrees.
 */
export function runBlobStorageContract(
  name: string,
  createHarness: () => Promise<ContractHarness> | ContractHarness,
): void {
  describe(`BlobStorage contract: ${name}`, () => {
    it('round-trips bytes', async () => {
      const { storage, key } = await createHarness();
      const k = key();
      await storage.put(k, Buffer.from('hello world'));
      expect(await storage.get(k)).toEqual(Buffer.from('hello world'));
    });

    it('preserves binary content exactly', async () => {
      const { storage, key } = await createHarness();
      const k = key();
      // Includes the bytes most likely to be mangled by a text-mode path:
      // NUL, the high bit, and a UTF-8 continuation byte on its own.
      const bytes = Buffer.from([0x00, 0xff, 0x80, 0x0d, 0x0a, 0x1a, 0x7f]);
      await storage.put(k, bytes);
      expect(await storage.get(k)).toEqual(bytes);
    });

    it('round-trips a blob larger than one chunk', async () => {
      const { storage, key } = await createHarness();
      const k = key();
      const big = Buffer.alloc(1024 * 1024, 0xab);
      await storage.put(k, big);
      const read = await storage.get(k);
      expect(read?.length).toBe(big.length);
      expect(read?.equals(big)).toBe(true);
    });

    it('reports an absent key as undefined rather than throwing', async () => {
      const { storage, key } = await createHarness();
      expect(await storage.get(key())).toBeUndefined();
      expect(await storage.stat(key())).toBeUndefined();
      expect(await storage.has(key())).toBe(false);
    });

    it('stat reports the stored size without transferring the blob', async () => {
      const { storage, key } = await createHarness();
      const k = key();
      await storage.put(k, Buffer.alloc(4096, 1));
      expect(await storage.stat(k)).toMatchObject({ size: 4096 });
      expect(await storage.has(k)).toBe(true);
    });

    it('overwriting with identical bytes is idempotent', async () => {
      const { storage, key } = await createHarness();
      const k = key();
      await storage.put(k, Buffer.from('same'));
      await storage.put(k, Buffer.from('same'));
      expect(await storage.get(k)).toEqual(Buffer.from('same'));
      expect(await storage.stat(k)).toMatchObject({ size: 4 });
    });

    it('stores an empty blob and distinguishes it from an absent one', async () => {
      const { storage, key } = await createHarness();
      const k = key();
      await storage.put(k, Buffer.alloc(0));
      // The distinction a `!data` check would silently destroy.
      expect(await storage.get(k)).toEqual(Buffer.alloc(0));
      expect(await storage.stat(k)).toMatchObject({ size: 0 });
      expect(await storage.has(k)).toBe(true);
    });
  });
}
