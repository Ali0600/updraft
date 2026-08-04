import { isSha256Hex } from '@ota/core';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import { assets } from '../db/schema.js';
import { assetStorageKey, type BlobStorage } from '../storage/BlobStorage.js';

export interface AssetRoutesOptions {
  db: Db;
  storage: BlobStorage;
}

export async function assetRoutes(
  app: FastifyInstance,
  { db, storage }: AssetRoutesOptions,
): Promise<void> {
  app.route<{ Params: { hash: string } }>({
    method: ['GET', 'HEAD'],
    url: '/assets/:hash',
    handler: async (request, reply) => {
      const { hash } = request.params;

      // Validate before touching storage. The storage key is then derived
      // server-side, so client input never reaches a filesystem path.
      if (!isSha256Hex(hash)) {
        return reply.code(400).send({ error: 'invalid asset hash' });
      }

      const data = await storage.get(assetStorageKey(hash));
      if (!data) {
        return reply.code(404).send({ error: 'asset not found' });
      }

      const row = db.select().from(assets).where(eq(assets.sha256Hex, hash)).get();

      return (
        reply
          .header('content-type', row?.contentType ?? 'application/octet-stream')
          // The address is the content hash, so these bytes can never change.
          .header('cache-control', 'public, max-age=31536000, immutable')
          .send(data)
      );
    },
  });
}
