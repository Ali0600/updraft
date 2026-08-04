/**
 * Blob storage for update assets.
 *
 * Keys are always derived server-side from a validated SHA-256 hash — no
 * implementation should ever receive a caller-supplied path.
 */
export interface BlobStorage {
  has(key: string): Promise<boolean>;
  put(key: string, data: Buffer): Promise<void>;
  /** Resolves undefined when the key is absent, rather than throwing. */
  get(key: string): Promise<Buffer | undefined>;
}

/** The one place a hash becomes a storage key. */
export function assetStorageKey(sha256Hex: string): string {
  return `assets/${sha256Hex}`;
}
