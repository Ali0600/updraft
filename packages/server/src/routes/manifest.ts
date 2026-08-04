import {
  buildMultipartBody,
  type Directive,
  type Manifest,
  PLATFORMS,
  type Platform,
  rollBackToEmbeddedDirective,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@ota/core';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { buildManifest } from '../services/manifestBuilder.js';
import { resolveUpdate } from '../services/updateResolver.js';

export interface ManifestRoutesOptions {
  db: Db;
  config: Config;
}

/** Sent on every response, including 204s and errors. */
function applyProtocolHeaders(reply: FastifyReply): FastifyReply {
  return reply
    .header('expo-protocol-version', '1')
    .header('expo-sfv-version', '0')
    .header('cache-control', 'private, max-age=0');
}

type ResponseFormat = 'multipart' | 'json';

// A wildcard accept and a missing header both resolve to multipart, which is
// the richer form and the only one that can carry a directive.
function negotiateFormat(accept: string | undefined): ResponseFormat | undefined {
  if (!accept || accept.includes('*/*') || accept.includes('multipart/mixed')) return 'multipart';
  if (accept.includes('application/expo+json') || accept.includes('application/json'))
    return 'json';
  return undefined;
}

function sendManifest(
  reply: FastifyReply,
  manifest: Manifest,
  format: ResponseFormat,
): FastifyReply {
  const body = JSON.stringify(manifest);

  if (format === 'json') {
    return reply
      .code(200)
      .header('content-type', 'application/expo+json; charset=utf-8')
      .send(body);
  }

  const multipart = buildMultipartBody([{ name: 'manifest', body }]);
  return reply.code(200).header('content-type', multipart.contentType).send(multipart.body);
}

function sendDirective(reply: FastifyReply, directive: Directive): FastifyReply {
  const multipart = buildMultipartBody([{ name: 'directive', body: JSON.stringify(directive) }]);
  return reply.code(200).header('content-type', multipart.contentType).send(multipart.body);
}

export async function manifestRoutes(
  app: FastifyInstance,
  { db, config }: ManifestRoutesOptions,
): Promise<void> {
  app.get<{ Params: { appSlug: string }; Querystring: { channel?: string } }>(
    '/api/manifest/:appSlug',
    async (request, reply) => {
      applyProtocolHeaders(reply);

      const headers = request.headers;

      const protocolVersion = Number(headers['expo-protocol-version'] ?? '1');
      if (!SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion as 0 | 1)) {
        return reply.code(400).send({ error: `unsupported expo-protocol-version` });
      }

      const platform = headers['expo-platform'];
      if (typeof platform !== 'string' || !PLATFORMS.includes(platform as Platform)) {
        return reply.code(400).send({ error: 'expo-platform must be ios or android' });
      }

      const runtimeVersion = headers['expo-runtime-version'];
      if (typeof runtimeVersion !== 'string' || runtimeVersion.length === 0) {
        return reply.code(400).send({ error: 'expo-runtime-version is required' });
      }

      const format = negotiateFormat(headers.accept);
      if (!format) {
        return reply.code(406).send({ error: 'accept must allow multipart/mixed or expo+json' });
      }

      // Set on the app via `updates.requestHeaders`; the query parameter is a
      // convenience for curl and CI checks.
      const channelHeader = headers['expo-channel-name'];
      const channelName =
        (typeof channelHeader === 'string' ? channelHeader : undefined) ??
        request.query.channel ??
        'production';

      const outcome = await resolveUpdate(db, {
        appSlug: request.params.appSlug,
        channelName,
        platform: platform as Platform,
        runtimeVersion,
        currentUpdateId: singleHeader(headers['expo-current-update-id']),
        embeddedUpdateId: singleHeader(headers['expo-embedded-update-id']),
      });

      switch (outcome.kind) {
        case 'appNotFound':
          return reply.code(404).send({ error: `unknown app '${request.params.appSlug}'` });

        case 'channelNotFound':
          return reply.code(404).send({ error: `unknown channel '${channelName}'` });

        case 'noUpdate':
          return reply.code(204).send();

        case 'rollback': {
          if (format === 'json') {
            // The JSON envelope cannot carry a directive, so there is nothing
            // truthful to say here other than "no update".
            request.log.warn(
              { appSlug: request.params.appSlug, channelName },
              'client accepts only JSON; rollback directive cannot be delivered',
            );
            return reply.code(204).send();
          }
          return sendDirective(reply, rollBackToEmbeddedDirective(outcome.commitTime));
        }

        case 'manifest': {
          const manifest = buildManifest({
            update: outcome.update,
            launchAsset: outcome.launchAsset,
            assets: outcome.assets,
            publicUrl: config.PUBLIC_URL,
          });
          return sendManifest(reply, manifest, format);
        }
      }
    },
  );
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
