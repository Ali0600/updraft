import { randomUUID } from 'node:crypto';
import { PLATFORMS, type Platform } from '@ota/core';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { UpdateRow } from '../db/schema.js';
import { apps, channels, updateAssets, updates } from '../db/schema.js';
import { PublishError } from './publishService.js';

/**
 * Every operation here works by APPENDING a newer row, never by mutating or
 * deleting history — except `disableUpdateGroup`, which flips a status. The
 * resolver always serves the newest active row, so "roll back" and "republish"
 * are both just new rows that win by recency. That keeps an audit trail and
 * makes any of these reversible by doing the opposite.
 */

export interface RollbackInput {
  appSlug: string;
  channelName: string;
  runtimeVersion: string;
  /** Defaults to every platform: a bad release is rarely bad on only one. */
  platforms?: Platform[] | undefined;
}

export function rollbackToEmbedded(db: Db, input: RollbackInput): UpdateRow[] {
  const { app, channel } = resolveTarget(db, input.appSlug, input.channelName);
  const platforms = input.platforms?.length ? input.platforms : [...PLATFORMS];

  const now = new Date().toISOString();
  const groupId = randomUUID();

  return db.transaction((tx) => {
    const created: UpdateRow[] = [];
    for (const platform of platforms) {
      const id = randomUUID();
      tx.insert(updates)
        .values({
          id,
          groupId,
          appId: app.id,
          channelId: channel.id,
          platform,
          runtimeVersion: input.runtimeVersion,
          type: 'rollback',
          status: 'active',
          // A rollback points at the embedded bundle, so it carries no assets.
          launchAssetId: null,
          metadata: {},
          extra: null,
          gitCommit: null,
          publishedBy: null,
          createdAt: now,
        })
        .run();

      const row = tx.select().from(updates).where(eq(updates.id, id)).get();
      if (!row) throw new PublishError('rollback was not persisted', 500);
      created.push(row);
    }
    return created;
  });
}

/**
 * Re-activates a previous publish by cloning its rows to the top of the
 * ordering. The clone reuses the existing asset rows, so no blobs move.
 */
export function republishUpdateGroup(db: Db, groupId: string): UpdateRow[] {
  const source = db
    .select()
    .from(updates)
    .where(and(eq(updates.groupId, groupId), eq(updates.type, 'normal')))
    .all();

  if (source.length === 0) {
    throw new PublishError(`no publishable update group '${groupId}'`, 404);
  }

  const now = new Date().toISOString();
  const newGroupId = randomUUID();

  return db.transaction((tx) => {
    const created: UpdateRow[] = [];
    for (const original of source) {
      const id = randomUUID();
      // Drop seq so it autoincrements: getting a fresh, higher seq is exactly
      // what puts the clone on top of the ordering.
      const { seq: _previousSeq, ...carried } = original;
      tx.insert(updates)
        .values({ ...carried, id, groupId: newGroupId, status: 'active', createdAt: now })
        .run();

      for (const link of tx
        .select()
        .from(updateAssets)
        .where(eq(updateAssets.updateId, original.id))
        .all()) {
        tx.insert(updateAssets).values({ updateId: id, assetId: link.assetId }).run();
      }

      const row = tx.select().from(updates).where(eq(updates.id, id)).get();
      if (!row) throw new PublishError('republished update was not persisted', 500);
      created.push(row);
    }
    return created;
  });
}

/** Takes a publish out of service without deleting it. */
export function disableUpdateGroup(db: Db, groupId: string): number {
  const rows = db.select().from(updates).where(eq(updates.groupId, groupId)).all();
  if (rows.length === 0) {
    throw new PublishError(`unknown update group '${groupId}'`, 404);
  }

  db.update(updates).set({ status: 'disabled' }).where(eq(updates.groupId, groupId)).run();
  return rows.length;
}

function resolveTarget(db: Db, appSlug: string, channelName: string) {
  const app = db.select().from(apps).where(eq(apps.slug, appSlug)).get();
  if (!app) throw new PublishError(`unknown app '${appSlug}'`, 404);

  const channel = db
    .select()
    .from(channels)
    .where(and(eq(channels.appId, app.id), eq(channels.name, channelName)))
    .get();
  if (!channel) throw new PublishError(`unknown channel '${channelName}'`, 404);

  return { app, channel };
}
