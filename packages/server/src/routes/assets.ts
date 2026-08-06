import { isSha256Hex } from '@ota/core';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import { assets } from '../db/schema.js';
import type { Metrics } from '../metrics.js';
import { assetStorageKey, type BlobStorage } from '../storage/BlobStorage.js';

/**
 * Assets are arbitrary publisher-supplied bytes with a publisher-supplied
 * content type, served from this origin. A browser must never render one as
 * HTML or sniff it into a script, so every asset response carries both
 * guards. The native expo-updates client fetches programmatically and ignores
 * both, so this is invisible to real clients — it exists only to stop a
 * `text/html` asset from becoming stored XSS on the server's own origin.
 */
const SAFE_DELIVERY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'content-disposition': 'attachment',
} as const;

export interface AssetRoutesOptions {
  db: Db;
  storage: BlobStorage;
  metrics?: Metrics | undefined;
}

export async function assetRoutes(
  app: FastifyInstance,
  { db, storage, metrics }: AssetRoutesOptions,
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
          .headers(SAFE_DELIVERY_HEADERS)
          .send();
      }

      const data = await storage.get(key);
      if (!data) {
        return reply.code(404).send({ error: 'asset not found' });
      }

      // Payload bytes, not wire bytes — the number that says whether the
      // proxy path is carrying enough traffic to justify a CDN.
      metrics?.assetBytesSent.inc(data.length);

      return (
        reply
          .header('content-type', row?.contentType ?? 'application/octet-stream')
          // The address is the content hash, so these bytes can never change.
          .header('cache-control', 'public, max-age=31536000, immutable')
          .headers(SAFE_DELIVERY_HEADERS)
          .send(data)
      );
    },
  });
}
