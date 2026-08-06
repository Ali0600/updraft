import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { BlobStat, BlobStorage } from './BlobStorage.js';

export class LocalFsStorage implements BlobStorage {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async stat(key: string): Promise<BlobStat | undefined> {
    try {
      const stats = await stat(this.resolveKey(key));
      // The filesystem stores no content type. Callers fall back to the
      // `assets` row, which is where it lives for this driver.
      return { size: stats.size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async has(key: string): Promise<boolean> {
    return (await this.stat(key)) !== undefined;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const path = this.resolveKey(key);
    await mkdir(dirname(path), { recursive: true });

    // Write to a sibling temp file and rename, so a crash mid-write can never
    // leave a truncated blob at an address that claims to be its own hash.
    const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temp, data);
    await rename(temp, path);
  }

  async get(key: string): Promise<Buffer | undefined> {
    return this.read(key);
  }

  private async read(key: string): Promise<Buffer | undefined> {
    try {
      return await readFile(this.resolveKey(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  /**
   * Defence in depth. Callers already derive keys from validated hashes, but a
   * storage driver must not depend on its callers being correct.
   */
  private resolveKey(key: string): string {
    const path = resolve(join(this.root, key));
    if (path !== this.root && !path.startsWith(this.root + sep)) {
      throw new Error('storage key escapes the storage root');
    }
    return path;
  }
}
