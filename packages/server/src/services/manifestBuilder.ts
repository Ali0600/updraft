import type { Manifest, ManifestAsset } from '@ota/core';
import type { AssetRow, UpdateRow } from '../db/schema.js';
import { assetStorageKey } from '../storage/BlobStorage.js';

export interface BuildManifestInput {
  update: UpdateRow;
  launchAsset: AssetRow;
  assets: AssetRow[];
  /** Origin assets are served from; must already be trailing-slash free. */
  publicUrl: string;
  /**
   * When set, assets are addressed here instead — a CDN or the object store
   * itself. Only affects manifests built from now on: the proxy route stays
   * enabled, because devices already hold manifests pointing at publicUrl.
   */
  assetsBaseUrl?: string | undefined;
}

export function buildManifest({
  update,
  launchAsset,
  assets,
  publicUrl,
  assetsBaseUrl,
}: BuildManifestInput): Manifest {
  const base = assetsBaseUrl ?? publicUrl;
  return {
    id: update.id,
    createdAt: update.createdAt,
    runtimeVersion: update.runtimeVersion,
    launchAsset: toManifestAsset(launchAsset, base),
    assets: assets.map((asset) => toManifestAsset(asset, base)),
    metadata: update.metadata,
    ...(update.extra ? { extra: update.extra } : {}),
  };
}

function toManifestAsset(asset: AssetRow, base: string): ManifestAsset {
  return {
    // The protocol's `hash` is base64url, while the URL addresses the blob by
    // hex. Both encode the same digest.
    hash: asset.sha256Base64Url,
    key: asset.key,
    contentType: asset.contentType,
    ...(asset.fileExtension ? { fileExtension: asset.fileExtension } : {}),
    // Built from the storage key rather than spelled out, so the path a client
    // fetches and the key the object is stored under cannot drift apart. In
    // direct mode they are the same string against two different origins.
    url: `${base}/${assetStorageKey(asset.sha256Hex)}`,
  };
}
