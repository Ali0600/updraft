import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const apps = sqliteTable('apps', {
  id: text('id').primaryKey(),
  /** Appears in the manifest URL: /api/manifest/:slug */
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  createdAt: text('created_at').notNull(),
});

export const channels = sqliteTable(
  'channels',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [uniqueIndex('channels_app_name_unique').on(table.appId, table.name)],
);

export const assets = sqliteTable(
  'assets',
  {
    id: text('id').primaryKey(),
    /** Storage address: the SHA-256 of the bytes themselves. */
    sha256Hex: text('sha256_hex').notNull(),
    /** Same digest in the base64url encoding the manifest must carry. */
    sha256Base64Url: text('sha256_b64url').notNull(),
    /** Expo's asset key from the export's metadata.json. */
    key: text('key').notNull(),
    contentType: text('content_type').notNull(),
    fileExtension: text('file_extension'),
    sizeBytes: integer('size_bytes').notNull(),
    storageKey: text('storage_key').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    // Identical bytes can legitimately appear under two different asset keys,
    // so the pair is what must be unique — the blob itself is deduped by hash.
    uniqueIndex('assets_hash_key_unique').on(table.sha256Hex, table.key),
    index('assets_hash_idx').on(table.sha256Hex),
  ],
);

export const updates = sqliteTable(
  'updates',
  {
    /**
     * Internal monotonic ordering key. `createdAt` alone cannot break ties
     * between two publishes landing in the same millisecond.
     */
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    /** The UUID clients see as the manifest `id`. */
    id: text('id').notNull().unique(),
    /** Ties the per-platform rows of a single publish together. */
    groupId: text('group_id').notNull(),
    appId: text('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    platform: text('platform', { enum: ['ios', 'android'] }).notNull(),
    /** Opaque targeting string; deliberately not modelled as an entity. */
    runtimeVersion: text('runtime_version').notNull(),
    /** `rollback` rows carry no assets and resolve to a rollBackToEmbedded directive. */
    type: text('type', { enum: ['normal', 'rollback'] })
      .notNull()
      .default('normal'),
    status: text('status', { enum: ['active', 'disabled'] })
      .notNull()
      .default('active'),
    launchAssetId: text('launch_asset_id').references(() => assets.id),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    extra: text('extra', { mode: 'json' }).$type<Record<string, unknown>>(),
    gitCommit: text('git_commit'),
    publishedBy: text('published_by'),
    /** The manifest `createdAt`. */
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('updates_lookup_idx').on(
      table.appId,
      table.channelId,
      table.platform,
      table.runtimeVersion,
      table.status,
    ),
    index('updates_group_idx').on(table.groupId),
  ],
);

export const updateAssets = sqliteTable(
  'update_assets',
  {
    updateId: text('update_id')
      .notNull()
      .references(() => updates.id, { onDelete: 'cascade' }),
    assetId: text('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.updateId, table.assetId] })],
);

export type AppRow = typeof apps.$inferSelect;
export type ChannelRow = typeof channels.$inferSelect;
export type AssetRow = typeof assets.$inferSelect;
export type UpdateRow = typeof updates.$inferSelect;
