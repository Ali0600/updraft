import { PLATFORMS } from '@ota/core';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { apps, channels, updates } from '../db/schema.js';
import { requireBearerToken } from '../plugins/auth.js';
import { rateLimitHook } from '../plugins/rateLimit.js';
import {
  createApp,
  createUpdate,
  missingAssetHashes,
  PublishError,
  parseContentTypeHeader,
  storeAsset,
} from '../services/publishService.js';
import {
  disableUpdateGroup,
  republishUpdateGroup,
  rollbackToEmbedded,
} from '../services/updateLifecycle.js';
import type { BlobStorage } from '../storage/BlobStorage.js';

/** 200 MB: a release JS bundle with assets, with room to spare. */
const ASSET_UPLOAD_LIMIT = 200 * 1024 * 1024;

const createAppSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, 'slug must be lowercase alphanumeric with . _ -'),
  name: z.string().min(1).max(200),
});

const assetInputSchema = z.object({
  sha256Hex: z.string().regex(/^[a-f0-9]{64}$/),
  key: z.string().min(1),
  contentType: z.string().min(1),
  fileExtension: z.string().optional(),
});

const createUpdateSchema = z.object({
  appSlug: z.string().min(1),
  channelName: z.string().min(1),
  platform: z.enum(PLATFORMS),
  runtimeVersion: z.string().min(1),
  launchAsset: assetInputSchema,
  assets: z.array(assetInputSchema).default([]),
  metadata: z.record(z.string(), z.unknown()).optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
  groupId: z.uuid().optional(),
  gitCommit: z.string().optional(),
  publishedBy: z.string().optional(),
});

const checkAssetsSchema = z.object({
  hashes: z.array(z.string()).max(10_000),
});

const rollbackSchema = z.object({
  runtimeVersion: z.string().min(1),
  /** Omitted means every platform — a bad release is rarely bad on only one. */
  platforms: z.array(z.enum(PLATFORMS)).nonempty().optional(),
});

const listUpdatesQuerySchema = z.object({
  channel: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export interface AdminRoutesOptions {
  db: Db;
  storage: BlobStorage;
  config: Config;
}

export async function adminRoutes(
  app: FastifyInstance,
  { db, storage, config }: AdminRoutesOptions,
): Promise<void> {
  // Applies to every route in this plugin's scope, so a new admin route cannot
  // be added unauthenticated by accident.
  // Registered first, so the limiter runs ahead of authentication: hooks in a
  // scope run in registration order. Reversed, a flood of unauthenticated
  // requests would collect 401s and never reach the limiter, leaving the token
  // no better protected than with no limiter at all.
  app.addHook('onRequest', rateLimitHook(app, config));
  app.addHook('onRequest', requireBearerToken(config.PUBLISH_TOKEN));

  // Asset uploads arrive as a raw body; keep the bytes untouched.
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: ASSET_UPLOAD_LIMIT },
    (_request, body, done) => done(null, body),
  );

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof PublishError) {
      return reply.code(error.statusCode).send({ error: error.message });
    }
    // Errors that already carry a client-error status came from the framework
    // or a plugin — rate limiting, body limits, malformed requests — and their
    // messages are safe. Flattening them to 500 hid a 429 behind an
    // "internal server error", which is both wrong and unactionable.
    const status = (error as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.code(status).send({ error: (error as Error).message });
    }
    request.log.error({ err: error }, 'admin request failed');
    // Never leak internals to the client; the detail is in the server log.
    return reply.code(500).send({ error: 'internal server error' });
  });

  app.get('/api/admin/apps', async () => ({ apps: db.select().from(apps).all() }));

  app.post('/api/admin/apps', async (request, reply) => {
    const body = createAppSchema.parse(request.body);
    const created = createApp(db, body.slug, body.name);
    return reply.code(201).send({ app: created });
  });

  app.post('/api/admin/assets/check', async (request) => {
    const body = checkAssetsSchema.parse(request.body);
    return { missing: await missingAssetHashes(storage, body.hashes) };
  });

  app.put<{ Params: { hash: string } }>(
    '/api/admin/assets/:hash',
    { bodyLimit: ASSET_UPLOAD_LIMIT },
    async (request, reply) => {
      if (!Buffer.isBuffer(request.body)) {
        return reply.code(415).send({ error: 'send the asset as application/octet-stream' });
      }
      // The real media type only arrives later with the update, but the CDN
      // in direct-delivery mode serves whatever the object was stored as.
      const contentType = parseContentTypeHeader(
        request.headers['x-updraft-content-type'] as string | undefined,
      );
      await storeAsset(storage, request.params.hash, request.body, contentType);
      return reply.code(201).send({ sha256Hex: request.params.hash, size: request.body.length });
    },
  );

  app.post('/api/admin/updates', async (request, reply) => {
    const body = createUpdateSchema.parse(request.body);
    const update = await createUpdate(db, storage, body);
    return reply.code(201).send({ update });
  });

  // How operators discover groupIds for republish/disable.
  app.get<{ Params: { appSlug: string }; Querystring: { channel?: string; limit?: string } }>(
    '/api/admin/apps/:appSlug/updates',
    async (request, reply) => {
      const query = listUpdatesQuerySchema.parse(request.query);

      const appRow = db.select().from(apps).where(eq(apps.slug, request.params.appSlug)).get();
      if (!appRow) {
        return reply.code(404).send({ error: `unknown app '${request.params.appSlug}'` });
      }

      const filters = [eq(updates.appId, appRow.id)];
      if (query.channel) {
        const channelRow = db
          .select()
          .from(channels)
          .where(and(eq(channels.appId, appRow.id), eq(channels.name, query.channel)))
          .get();
        if (!channelRow) {
          return reply.code(404).send({ error: `unknown channel '${query.channel}'` });
        }
        filters.push(eq(updates.channelId, channelRow.id));
      }

      const rows = db
        .select({
          id: updates.id,
          groupId: updates.groupId,
          platform: updates.platform,
          runtimeVersion: updates.runtimeVersion,
          type: updates.type,
          status: updates.status,
          createdAt: updates.createdAt,
          gitCommit: updates.gitCommit,
          publishedBy: updates.publishedBy,
        })
        .from(updates)
        .where(and(...filters))
        .orderBy(desc(updates.seq))
        .limit(query.limit)
        .all();

      return { updates: rows };
    },
  );

  // --- lifecycle -----------------------------------------------------------
  // All three append or flip state rather than deleting, so every one of them
  // is itself reversible.

  app.post<{ Params: { appSlug: string; channelName: string } }>(
    '/api/admin/apps/:appSlug/channels/:channelName/rollback-to-embedded',
    async (request, reply) => {
      const body = rollbackSchema.parse(request.body);
      const created = rollbackToEmbedded(db, {
        appSlug: request.params.appSlug,
        channelName: request.params.channelName,
        runtimeVersion: body.runtimeVersion,
        platforms: body.platforms,
      });

      request.log.warn(
        {
          appSlug: request.params.appSlug,
          channelName: request.params.channelName,
          runtimeVersion: body.runtimeVersion,
          platforms: created.map((row) => row.platform),
        },
        'rolling clients back to the embedded bundle',
      );

      return reply.code(201).send({ groupId: created[0]?.groupId, updates: created });
    },
  );

  app.post<{ Params: { groupId: string } }>(
    '/api/admin/updates/:groupId/republish',
    async (request, reply) => {
      const created = republishUpdateGroup(db, request.params.groupId);
      return reply
        .code(201)
        .send({ groupId: created[0]?.groupId, from: request.params.groupId, updates: created });
    },
  );

  app.post<{ Params: { groupId: string } }>(
    '/api/admin/updates/:groupId/disable',
    async (request, reply) => {
      const disabled = disableUpdateGroup(db, request.params.groupId);
      request.log.warn({ groupId: request.params.groupId, disabled }, 'update group disabled');
      return reply.code(200).send({ groupId: request.params.groupId, disabled });
    },
  );
}
