import { PLATFORMS } from '@ota/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { apps } from '../db/schema.js';
import { requireBearerToken } from '../plugins/auth.js';
import {
  createApp,
  createUpdate,
  missingAssetHashes,
  PublishError,
  storeAsset,
} from '../services/publishService.js';
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
      await storeAsset(storage, request.params.hash, request.body);
      return reply.code(201).send({ sha256Hex: request.params.hash, size: request.body.length });
    },
  );

  app.post('/api/admin/updates', async (request, reply) => {
    const body = createUpdateSchema.parse(request.body);
    const update = await createUpdate(db, storage, body);
    return reply.code(201).send({ update });
  });
}
