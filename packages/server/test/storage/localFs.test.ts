import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalFsStorage } from '../../src/storage/localFs.js';
import { runBlobStorageContract } from './blobStorageContract.js';

const roots: string[] = [];

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'updraft-localfs-'));
  roots.push(root);
  let counter = 0;
  return {
    storage: new LocalFsStorage(root),
    key: () => `assets/${Date.now()}-${counter++}`,
  };
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

runBlobStorageContract('LocalFsStorage', harness);

describe('LocalFsStorage path containment', () => {
  // The driver must not depend on its callers being correct, so these are
  // asserted at the driver rather than only at the route that calls it.
  it.each([
    ['../escape', 'parent traversal'],
    ['assets/../../escape', 'traversal below the root'],
    ['a/b/../../../../etc/passwd', 'traversal past the root'],
  ])('refuses %s (%s)', async (key) => {
    const { storage } = await harness();
    await expect(storage.get(key)).rejects.toThrow(/escapes the storage root/);
    await expect(storage.stat(key)).rejects.toThrow(/escapes the storage root/);
    await expect(storage.put(key, Buffer.from('x'))).rejects.toThrow(/escapes the storage root/);
  });

  it('neutralises an absolute key instead of following it', async () => {
    // `path.join` absorbs the leading slash, so '/etc/passwd' resolves to
    // <root>/etc/passwd — contained, not escaping. Pinned because the safety
    // here comes from join's behaviour, which is invisible at the call site.
    const { storage } = await harness();
    expect(await storage.get('/etc/passwd')).toBeUndefined();
    await expect(storage.put('/etc/passwd', Buffer.from('x'))).resolves.toBeUndefined();
  });
});
