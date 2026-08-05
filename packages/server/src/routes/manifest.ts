import {
  buildMultipartBody,
  type Directive,
  type Manifest,
  noUpdateAvailableDirective,
  PLATFORMS,
  type Platform,
  parseExpectSignatureHeader,
  rollBackToEmbeddedDirective,
  SIGNATURE_ALGORITHM,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@ota/core';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { buildManifest } from '../services/manifestBuilder.js';
import type { Signer } from '../services/signer.js';
import { resolveUpdate } from '../services/updateResolver.js';

export interface ManifestRoutesOptions {
  db: Db;
  config: Config;
  signer?: Signer | undefined;
}

/** Returns an `expo-signature` value for the exact bytes, or undefined when unsigned. */
type SignFn = (bytes: string) => string;

/** Sent on every response, including 204s and errors. */
function applyProtocolHeaders(reply: FastifyReply, protocolVersion: number): FastifyReply {
  return reply
    .header('expo-protocol-version', String(protocolVersion))
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

/**
 * Signs the serialized body, never a re-serialization of it: the client
 * verifies the bytes it received, so the signed bytes and the sent bytes must
 * be the same string.
 */
function sendSignedPart(
  reply: FastifyReply,
  partName: 'manifest' | 'directive',
  payload: Manifest | Directive,
  format: ResponseFormat,
  sign: SignFn | undefined,
): FastifyReply {
  const body = JSON.stringify(payload);
  const signature = sign?.(body);

  if (format === 'json') {
    // No parts to hang headers on, so the signature goes on the response.
    if (signature) reply.header('expo-signature', signature);
    return reply
      .code(200)
      .header('content-type', 'application/expo+json; charset=utf-8')
      .send(body);
  }

  const multipart = buildMultipartBody([
    {
      name: partName,
      body,
      // The protocol puts expo-signature on the PART, not the response.
      ...(signature ? { headers: { 'expo-signature': signature } } : {}),
    },
  ]);
  return reply.code(200).header('content-type', multipart.contentType).send(multipart.body);
}

export async function manifestRoutes(
  app: FastifyInstance,
  { db, config, signer }: ManifestRoutesOptions,
): Promise<void> {
  app.get<{ Params: { appSlug: string }; Querystring: { channel?: string } }>(
    '/api/manifest/:appSlug',
    async (request, reply) => {
      const headers = request.headers;

      const protocolVersion = Number(headers['expo-protocol-version'] ?? '1');
      if (!SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion as 0 | 1)) {
        applyProtocolHeaders(reply, 1);
        return reply.code(400).send({ error: 'unsupported expo-protocol-version' });
      }
      applyProtocolHeaders(reply, protocolVersion);

      // Directives exist only in protocol version 1.
      const supportsDirectives =
        protocolVersion === 1 && negotiateFormat(headers.accept) === 'multipart';

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

      // Code signing is opt-in per request. When a client asks for it, every
      // failure below is a 400: serving an unsigned 200 to a client that
      // demanded a signature would silently downgrade it.
      let sign: SignFn | undefined;
      const expectSignature = singleHeader(headers['expo-expect-signature']);
      if (expectSignature) {
        const expected = parseExpectSignatureHeader(expectSignature);
        if (!expected) {
          return reply.code(400).send({ error: 'malformed expo-expect-signature' });
        }
        if (!signer) {
          return reply
            .code(400)
            .send({ error: 'code signing requested but no signing key is configured' });
        }
        if (expected.keyid !== signer.keyId) {
          return reply.code(400).send({ error: `no signing key for keyid '${expected.keyid}'` });
        }
        if (expected.alg && expected.alg !== SIGNATURE_ALGORITHM) {
          return reply
            .code(400)
            .send({ error: `unsupported signature algorithm '${expected.alg}'` });
        }
        sign = (bytes) => signer.sign(bytes);
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

      /** Version 1 says "nothing to apply" with a signable body; version 0 cannot. */
      const nothingToApply = (): FastifyReply =>
        supportsDirectives
          ? sendSignedPart(reply, 'directive', noUpdateAvailableDirective(), format, sign)
          : reply.code(204).send();

      switch (outcome.kind) {
        case 'appNotFound':
          return reply.code(404).send({ error: `unknown app '${request.params.appSlug}'` });

        case 'channelNotFound':
          return reply.code(404).send({ error: `unknown channel '${channelName}'` });

        case 'noUpdate':
          return nothingToApply();

        case 'upToDate': {
          // Version 0 has no way to say "you are current", so the reference
          // behaviour is to serve the same manifest again.
          if (protocolVersion === 0) {
            return sendSignedPart(
              reply,
              'manifest',
              buildManifest({ ...outcome, publicUrl: config.PUBLIC_URL }),
              format,
              sign,
            );
          }
          return nothingToApply();
        }

        case 'rollback': {
          if (!supportsDirectives) {
            request.log.warn(
              { appSlug: request.params.appSlug, channelName, protocolVersion, format },
              'rollback pending but this client cannot receive directives',
            );
            return reply.code(204).send();
          }
          return sendSignedPart(
            reply,
            'directive',
            rollBackToEmbeddedDirective(outcome.commitTime),
            format,
            sign,
          );
        }

        case 'manifest':
          return sendSignedPart(
            reply,
            'manifest',
            buildManifest({ ...outcome, publicUrl: config.PUBLIC_URL }),
            format,
            sign,
          );
      }
    },
  );
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
