import type { Manifest, ManifestAsset } from '@ota/core';
import type { AssetRow, UpdateRow } from '../db/schema.js';

export interface BuildManifestInput {
  update: UpdateRow;
  launchAsset: AssetRow;
  assets: AssetRow[];
  /** Origin assets are served from; must already be trailing-slash free. */
  publicUrl: string;
}

export function buildManifest({
  update,
  launchAsset,
  assets,
  publicUrl,
}: BuildManifestInput): Manifest {
  return {
    id: update.id,
    createdAt: update.createdAt,
    runtimeVersion: update.runtimeVersion,
    launchAsset: toManifestAsset(launchAsset, publicUrl),
    assets: assets.map((asset) => toManifestAsset(asset, publicUrl)),
    metadata: update.metadata,
    ...(update.extra ? { extra: update.extra } : {}),
  };
}

function toManifestAsset(asset: AssetRow, publicUrl: string): ManifestAsset {
  return {
    // The protocol's `hash` is base64url, while the URL addresses the blob by
    // hex. Both encode the same digest.
    hash: asset.sha256Base64Url,
    key: asset.key,
    contentType: asset.contentType,
    ...(asset.fileExtension ? { fileExtension: asset.fileExtension } : {}),
    url: `${publicUrl}/assets/${asset.sha256Hex}`,
  };
}
