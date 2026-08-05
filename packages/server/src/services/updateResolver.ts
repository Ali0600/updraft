import type { Platform } from '@ota/core';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { AssetRow, UpdateRow } from '../db/schema.js';
import { apps, assets, channels, updateAssets, updates } from '../db/schema.js';

export interface ResolveRequest {
  appSlug: string;
  channelName: string;
  platform: Platform;
  runtimeVersion: string;
  /** `expo-current-update-id`: what the client is running now. */
  currentUpdateId?: string | undefined;
  /** `expo-embedded-update-id`: the bundle compiled into the binary. */
  embeddedUpdateId?: string | undefined;
}

export interface ResolvedManifest {
  update: UpdateRow;
  launchAsset: AssetRow;
  assets: AssetRow[];
}

export type ResolveOutcome =
  | { kind: 'appNotFound' }
  | { kind: 'channelNotFound' }
  /** Nothing active to serve for this target. */
  | { kind: 'noUpdate' }
  /**
   * The client already runs the newest update. Kept distinct from `noUpdate`
   * and carrying the manifest data, because protocol version 0 has no way to
   * say "you are current" and re-serves the manifest instead.
   */
  | ({ kind: 'upToDate' } & ResolvedManifest)
  | { kind: 'rollback'; commitTime: string }
  | ({ kind: 'manifest' } & ResolvedManifest);

/**
 * The protocol's decision logic: given what a client reports about itself,
 * decide whether to serve an update, a rollback directive, or nothing.
 *
 * Deliberately fails closed — an unknown app or channel is a 404 rather than a
 * fallthrough to some default, so a typo in a client's URL cannot silently
 * serve another app's bundle.
 */
export async function resolveUpdate(db: Db, request: ResolveRequest): Promise<ResolveOutcome> {
  const app = db.select().from(apps).where(eq(apps.slug, request.appSlug)).get();
  if (!app) return { kind: 'appNotFound' };

  const channel = db
    .select()
    .from(channels)
    .where(and(eq(channels.appId, app.id), eq(channels.name, request.channelName)))
    .get();
  if (!channel) return { kind: 'channelNotFound' };

  const update = db
    .select()
    .from(updates)
    .where(
      and(
        eq(updates.appId, app.id),
        eq(updates.channelId, channel.id),
        eq(updates.platform, request.platform),
        eq(updates.runtimeVersion, request.runtimeVersion),
        eq(updates.status, 'active'),
      ),
    )
    // seq, not createdAt: two publishes can share a millisecond.
    .orderBy(desc(updates.seq))
    .limit(1)
    .get();

  // Nothing published for this runtime version. The client keeps its embedded
  // bundle — this is the normal answer for a freshly released binary.
  if (!update) return { kind: 'noUpdate' };

  if (update.type === 'rollback') {
    // A client already running the embedded bundle has nowhere to roll back to.
    const onEmbedded =
      request.currentUpdateId !== undefined && request.currentUpdateId === request.embeddedUpdateId;
    return onEmbedded ? { kind: 'noUpdate' } : { kind: 'rollback', commitTime: update.createdAt };
  }

  if (!update.launchAssetId) {
    throw new Error(`update ${update.id} is type 'normal' but has no launch asset`);
  }

  const launchAsset = db.select().from(assets).where(eq(assets.id, update.launchAssetId)).get();
  if (!launchAsset) {
    throw new Error(`update ${update.id} references a missing launch asset`);
  }

  const assetRows = db
    .select({ asset: assets })
    .from(updateAssets)
    .innerJoin(assets, eq(assets.id, updateAssets.assetId))
    .where(eq(updateAssets.updateId, update.id))
    .all()
    .map((row) => row.asset)
    // The join carries every blob the update owns, including the bundle. The
    // protocol wants the bundle only as `launchAsset`; repeating it here would
    // make the client download it twice.
    .filter((asset) => asset.id !== launchAsset.id);

  // Resolved either way: protocol version 0 re-serves the manifest to a client
  // that is already current, so the caller needs the data in both branches.
  const kind = request.currentUpdateId === update.id ? 'upToDate' : 'manifest';
  return { kind, update, launchAsset, assets: assetRows };
}

/** Used by the publish path to confirm every referenced blob already exists. */
export function findAssetsByHashes(db: Db, hashes: string[]): AssetRow[] {
  if (hashes.length === 0) return [];
  return db.select().from(assets).where(inArray(assets.sha256Hex, hashes)).all();
}
