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

      const key = assetStorageKey(hash);
      const row = db.select().from(assets).where(eq(assets.sha256Hex, hash)).get();

      // HEAD must not transfer the blob. Against object storage `get` would
      // download the whole bundle to answer a request that has no body — on a
      // public route with metered egress, that is amplification.
      if (request.method === 'HEAD') {
        const stored = await storage.stat(key);
        if (!stored) {
          return reply.code(404).send({ error: 'asset not found' });
        }
        return reply
          .header('content-type', row?.contentType ?? 'application/octet-stream')
          .header('content-length', String(stored.size))
          .header('cache-control', 'public, max-age=31536000, immutable')
          .send();
      }

      const data = await storage.get(key);
      if (!data) {
        return reply.code(404).send({ error: 'asset not found' });
      }

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
