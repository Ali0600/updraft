/**
 * Blob storage for update assets.
 *
 * Keys are always derived server-side from a validated SHA-256 hash — no
 * implementation should ever receive a caller-supplied path.
 */
export interface BlobStat {
  size: number;
  /** What the blob was stored as; undefined when the store does not record one. */
  contentType?: string | undefined;
}

export interface PutOptions {
  /**
   * Recorded on the stored object. It matters in direct-delivery mode, where
   * a CDN serves the object's own content type and nothing else can supply it.
   */
  contentType?: string | undefined;
}

export interface BlobStorage {
  /**
   * Metadata without transferring the blob. Resolves undefined when the key is
   * absent — an implementation must never report a *failure* as an absence,
   * or a broken credential becomes an empty store that looks healthy.
   */
  stat(key: string): Promise<BlobStat | undefined>;
  has(key: string): Promise<boolean>;
  put(key: string, data: Buffer, options?: PutOptions): Promise<void>;
  /** Resolves undefined when the key is absent, rather than throwing. */
  get(key: string): Promise<Buffer | undefined>;
}

/** The one place a hash becomes a storage key. */
export function assetStorageKey(sha256Hex: string): string {
  return `assets/${sha256Hex}`;
}
