import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '@ota/core';
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
      headers: { ...auth, 'content-type': 'application/octet-stream' },
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
