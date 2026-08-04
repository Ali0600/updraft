import { randomUUID } from 'node:crypto';
import { hexToBase64Url, isSha256Hex, type Platform, sha256Hex } from '@ota/core';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { AppRow, AssetRow, UpdateRow } from '../db/schema.js';
import { apps, assets, channels, updateAssets, updates } from '../db/schema.js';
import { assetStorageKey, type BlobStorage } from '../storage/BlobStorage.js';

/** Channels every new app starts with. */
export const DEFAULT_CHANNELS = ['production', 'staging'] as const;

export class PublishError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'PublishError';
  }
}

export interface AssetInput {
  sha256Hex: string;
  key: string;
  contentType: string;
  fileExtension?: string | undefined;
}

export interface CreateUpdateInput {
  appSlug: string;
  channelName: string;
  platform: Platform;
  runtimeVersion: string;
  launchAsset: AssetInput;
  assets: AssetInput[];
  metadata?: Record<string, unknown> | undefined;
  extra?: Record<string, unknown> | undefined;
  /** Shared across the per-platform rows of one publish. */
  groupId?: string | undefined;
  gitCommit?: string | undefined;
  publishedBy?: string | undefined;
}

export function createApp(db: Db, slug: string, name: string): AppRow {
  const existing = db.select().from(apps).where(eq(apps.slug, slug)).get();
  if (existing) throw new PublishError(`app '${slug}' already exists`, 409);

  const now = new Date().toISOString();
  const app: AppRow = { id: randomUUID(), slug, name, createdAt: now };

  db.transaction((tx) => {
    tx.insert(apps).values(app).run();
    for (const channelName of DEFAULT_CHANNELS) {
      tx.insert(channels)
        .values({ id: randomUUID(), appId: app.id, name: channelName, createdAt: now })
        .run();
    }
  });

  return app;
}

/**
 * Returns the subset of hashes whose bytes are not stored yet, so a publish
 * only uploads what actually changed.
 */
export async function missingAssetHashes(
  storage: BlobStorage,
  hashes: string[],
): Promise<string[]> {
  const missing: string[] = [];
  for (const hash of hashes) {
    if (!isSha256Hex(hash)) {
      throw new PublishError(`'${hash}' is not a SHA-256 hex digest`, 400);
    }
    if (!(await storage.has(assetStorageKey(hash)))) missing.push(hash);
  }
  return missing;
}

/**
 * Stores a blob under its own digest. The hash is recomputed from the received
 * bytes: a client-supplied hash is a claim, and the storage address must be
 * the truth about the content.
 */
export async function storeAsset(
  storage: BlobStorage,
  claimedHash: string,
  data: Buffer,
): Promise<void> {
  if (!isSha256Hex(claimedHash)) {
    throw new PublishError(`'${claimedHash}' is not a SHA-256 hex digest`, 400);
  }

  const actual = sha256Hex(data);
  if (actual !== claimedHash) {
    throw new PublishError(`content hash ${actual} does not match ${claimedHash}`, 400);
  }

  await storage.put(assetStorageKey(claimedHash), data);
}

export async function createUpdate(
  db: Db,
  storage: BlobStorage,
  input: CreateUpdateInput,
): Promise<UpdateRow> {
  const app = db.select().from(apps).where(eq(apps.slug, input.appSlug)).get();
  if (!app) throw new PublishError(`unknown app '${input.appSlug}'`, 404);

  const channel = db
    .select()
    .from(channels)
    .where(and(eq(channels.appId, app.id), eq(channels.name, input.channelName)))
    .get();
  if (!channel) throw new PublishError(`unknown channel '${input.channelName}'`, 404);

  // The launch asset is also a regular asset; dedupe so it is not listed twice.
  const allAssets = dedupeAssets([input.launchAsset, ...input.assets]);

  // Every blob must be uploaded before the update goes live, or clients would
  // fetch a manifest pointing at bytes that do not exist.
  for (const asset of allAssets) {
    if (!isSha256Hex(asset.sha256Hex)) {
      throw new PublishError(`'${asset.sha256Hex}' is not a SHA-256 hex digest`, 400);
    }
    if (!(await storage.has(assetStorageKey(asset.sha256Hex)))) {
      throw new PublishError(`asset ${asset.sha256Hex} has not been uploaded`, 400);
    }
  }

  const now = new Date().toISOString();
  const updateId = randomUUID();

  return db.transaction((tx) => {
    const assetIds = new Map<string, string>();
    for (const asset of allAssets) {
      assetIds.set(assetKey(asset), upsertAsset(tx, asset, now).id);
    }

    const launchAssetId = assetIds.get(assetKey(input.launchAsset));
    if (!launchAssetId) throw new PublishError('launch asset could not be stored', 500);

    tx.insert(updates)
      .values({
        id: updateId,
        groupId: input.groupId ?? randomUUID(),
        appId: app.id,
        channelId: channel.id,
        platform: input.platform,
        runtimeVersion: input.runtimeVersion,
        type: 'normal',
        status: 'active',
        launchAssetId,
        metadata: input.metadata ?? {},
        extra: input.extra ?? null,
        gitCommit: input.gitCommit ?? null,
        publishedBy: input.publishedBy ?? null,
        createdAt: now,
      })
      .run();

    for (const assetId of new Set(assetIds.values())) {
      tx.insert(updateAssets).values({ updateId, assetId }).run();
    }

    const created = tx.select().from(updates).where(eq(updates.id, updateId)).get();
    if (!created) throw new PublishError('update was not persisted', 500);
    return created;
  });
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

function upsertAsset(tx: Tx, input: AssetInput, now: string): AssetRow {
  const existing = tx
    .select()
    .from(assets)
    .where(and(eq(assets.sha256Hex, input.sha256Hex), eq(assets.key, input.key)))
    .get();
  if (existing) return existing;

  const row: AssetRow = {
    id: randomUUID(),
    sha256Hex: input.sha256Hex,
    sha256Base64Url: hexToBase64Url(input.sha256Hex),
    key: input.key,
    contentType: input.contentType,
    fileExtension: input.fileExtension ?? null,
    // Size is recorded at upload time in M4's storage stats; 0 until then.
    sizeBytes: 0,
    storageKey: assetStorageKey(input.sha256Hex),
    createdAt: now,
  };
  tx.insert(assets).values(row).run();
  return row;
}

function assetKey(asset: AssetInput): string {
  return `${asset.sha256Hex}:${asset.key}`;
}

function dedupeAssets(list: AssetInput[]): AssetInput[] {
  const seen = new Map<string, AssetInput>();
  for (const asset of list) {
    if (!seen.has(assetKey(asset))) seen.set(assetKey(asset), asset);
  }
  return [...seen.values()];
}
