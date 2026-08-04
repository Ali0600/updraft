import { sha256Hex } from '@ota/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BlobStorage } from '../../src/storage/BlobStorage.js';
import { publishFixture } from '../helpers/publishFixture.js';
import { createTestApp, type TestHarness } from '../helpers/testApp.js';

/** Records every key the route asks storage for. */
function spyOn(storage: BlobStorage): { storage: BlobStorage; keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    storage: {
      has: (key) => {
        keys.push(key);
        return storage.has(key);
      },
      put: (key, data) => storage.put(key, data),
      get: (key) => {
        keys.push(key);
        return storage.get(key);
      },
    },
  };
}

describe('asset endpoint', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestApp();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('serves stored bytes with immutable caching', async () => {
    const { bundle } = await publishFixture(harness.app);

    const response = await harness.app.inject({
      method: 'GET',
      url: `/assets/${bundle.sha256Hex}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.equals(bundle.bytes)).toBe(true);
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(response.headers['content-type']).toContain('application/javascript');
  });

  it('answers HEAD with the size the body would have', async () => {
    const { bundle } = await publishFixture(harness.app);

    const response = await harness.app.inject({
      method: 'HEAD',
      url: `/assets/${bundle.sha256Hex}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-length']).toBe(String(bundle.bytes.length));
    // Body suppression is Node's, at the transport layer, and inject bypasses
    // it — verified separately against a real listening server, where HEAD
    // returns zero bytes with this same content-length.
  });

  it('returns 404 for a well-formed hash that was never stored', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: `/assets/${sha256Hex('never uploaded')}`,
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('asset endpoint — path safety', () => {
  // Each case must be rejected *before* storage is consulted, so the guard
  // cannot be satisfied by the driver happening to fail afterwards.
  const rejected: Array<[label: string, hash: string]> = [
    ['traversal', '../../../etc/passwd'],
    ['encoded traversal', '..%2f..%2f..%2fetc%2fpasswd'],
    ['absolute path', '/etc/passwd'],
    ['uppercase hex', sha256Hex('x').toUpperCase()],
    ['too short', sha256Hex('x').slice(0, 63)],
    ['too long', `${sha256Hex('x')}0`],
    ['hash with a suffix', `${sha256Hex('x')}/../../etc/passwd`],
    ['empty', ''],
  ];

  for (const [label, hash] of rejected) {
    it(`rejects ${label} without touching storage`, async () => {
      const spy = spyOn({
        has: async () => false,
        put: async () => undefined,
        get: async () => undefined,
      });
      const harness = await createTestApp({}, () => spy.storage);

      try {
        const response = await harness.app.inject({
          method: 'GET',
          url: `/assets/${hash}`,
        });

        expect(response.statusCode).not.toBe(200);
        expect(spy.keys).toEqual([]);
      } finally {
        await harness.close();
      }
    });
  }

  it('refuses to resolve a key that escapes the storage root', async () => {
    const harness = await createTestApp();
    try {
      await expect(harness.storage.get('../../escaped')).rejects.toThrow(/escapes/);
    } finally {
      await harness.close();
    }
  });
});
