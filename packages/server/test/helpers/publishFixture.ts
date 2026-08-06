import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMultipartBody, sha256Hex } from '@ota/core';
import type { FastifyInstance } from 'fastify';
import { TEST_PUBLISH_TOKEN } from './testConfig.js';

export const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/export-basic/', import.meta.url));

export interface FixtureFile {
  path: string;
  key: string;
  contentType: string;
  fileExtension: string;
  bytes: Buffer;
  sha256Hex: string;
}

/** Reads fixture bytes and hashes them here, so tests never trust a stored hash. */
export function readFixture(relativePath: string, key: string, contentType: string): FixtureFile {
  const bytes = readFileSync(join(FIXTURE_DIR, relativePath));
  const extension = relativePath.slice(relativePath.lastIndexOf('.'));
  return {
    path: relativePath,
    key,
    contentType,
    fileExtension: extension,
    bytes,
    sha256Hex: sha256Hex(bytes),
  };
}

export const BUNDLE = readFixture(
  '_expo/static/js/ios/index.hbc',
  'bundle',
  'application/javascript',
);
export const ICON = readFixture('assets/icon.txt', 'icon', 'text/plain');

export const auth = { authorization: `Bearer ${TEST_PUBLISH_TOKEN}` };

export interface PublishOptions {
  appSlug?: string;
  channelName?: string;
  runtimeVersion?: string;
  platform?: 'ios' | 'android';
  createApp?: boolean;
}

export interface PublishResult {
  updateId: string;
  bundle: FixtureFile;
  icon: FixtureFile;
}

/**
 * Drives the real admin API end to end: create app, negotiate which blobs are
 * missing, upload them, then create the update.
 */
export async function publishFixture(
  app: FastifyInstance,
  options: PublishOptions = {},
): Promise<PublishResult> {
  const {
    appSlug = 'demo',
    channelName = 'production',
    runtimeVersion = '1.0.0',
    platform = 'ios',
    createApp = true,
  } = options;

  if (createApp) {
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/apps',
      headers: auth,
      payload: { slug: appSlug, name: 'Demo App' },
    });
    if (created.statusCode !== 201) {
      throw new Error(`fixture app creation failed: ${created.statusCode} ${created.body}`);
    }
  }

  const files = [BUNDLE, ICON];

  const check = await app.inject({
    method: 'POST',
    url: '/api/admin/assets/check',
    headers: auth,
    payload: { hashes: files.map((file) => file.sha256Hex) },
  });
  const missing: string[] = check.json().missing;

  for (const file of files.filter((candidate) => missing.includes(candidate.sha256Hex))) {
    const upload = await app.inject({
      method: 'PUT',
      url: `/api/admin/assets/${file.sha256Hex}`,
      headers: {
        ...auth,
        'content-type': 'application/octet-stream',
        // Mirrors what the real CLI sends, so tests exercise the path that
        // actually runs in production rather than a simplified one.
        'x-updraft-content-type': file.contentType,
      },
      payload: file.bytes,
    });
    if (upload.statusCode !== 201) {
      throw new Error(`fixture asset upload failed: ${upload.statusCode} ${upload.body}`);
    }
  }

  const created = await app.inject({
    method: 'POST',
    url: '/api/admin/updates',
    headers: auth,
    payload: {
      appSlug,
      channelName,
      platform,
      runtimeVersion,
      launchAsset: {
        sha256Hex: BUNDLE.sha256Hex,
        key: BUNDLE.key,
        contentType: BUNDLE.contentType,
        fileExtension: BUNDLE.fileExtension,
      },
      assets: [
        {
          sha256Hex: ICON.sha256Hex,
          key: ICON.key,
          contentType: ICON.contentType,
          fileExtension: ICON.fileExtension,
        },
      ],
      metadata: { branchName: channelName },
    },
  });
  if (created.statusCode !== 201) {
    throw new Error(`fixture update creation failed: ${created.statusCode} ${created.body}`);
  }

  return { updateId: created.json().update.id, bundle: BUNDLE, icon: ICON };
}

/** Headers a conforming expo-updates client would send. */
export function clientHeaders(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    'expo-protocol-version': '1',
    'expo-platform': 'ios',
    'expo-runtime-version': '1.0.0',
    accept: 'multipart/mixed',
    ...overrides,
  };
}

export function boundaryOf(contentType: string | undefined): string {
  const boundary = /boundary=([^;]+)/.exec(contentType ?? '')?.[1];
  if (!boundary) throw new Error(`no boundary in content-type: ${contentType}`);
  return boundary;
}

export interface ParsedPart {
  name: string | undefined;
  headers: Record<string, string>;
  body: string;
  json: unknown;
}

/** Parses the single part of a protocol response. */
export function parseSinglePart(response: {
  rawPayload: Buffer;
  headers: Record<string, unknown>;
}): ParsedPart {
  const parts = parseMultipartBody(
    response.rawPayload,
    boundaryOf(response.headers['content-type'] as string | undefined),
  );
  const part = parts[0];
  if (!part) throw new Error('response contained no multipart parts');

  const body = part.body.toString('utf8');
  return { name: part.name, headers: part.headers, body, json: JSON.parse(body) };
}

/**
 * Asserts the response is a protocol-v1 "nothing to apply" directive.
 * Returns the part so callers can additionally check its signature.
 */
export function expectNoUpdateAvailable(response: {
  statusCode: number;
  rawPayload: Buffer;
  headers: Record<string, unknown>;
}): ParsedPart {
  if (response.statusCode !== 200) {
    throw new Error(`expected 200 with a directive, got ${response.statusCode}`);
  }
  const part = parseSinglePart(response);
  if (part.name !== 'directive') throw new Error(`expected a directive part, got '${part.name}'`);
  const type = (part.json as { type?: string }).type;
  if (type !== 'noUpdateAvailable') {
    throw new Error(`expected noUpdateAvailable, got '${type}'`);
  }
  return part;
}
