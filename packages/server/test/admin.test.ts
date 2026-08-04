import { sha256Hex } from '@ota/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auth, BUNDLE, publishFixture } from './helpers/publishFixture.js';
import { createTestApp, type TestHarness } from './helpers/testApp.js';

describe('admin API — authentication', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestApp();
  });

  afterEach(async () => {
    await harness.close();
  });

  const protectedRoutes: Array<[method: 'GET' | 'POST' | 'PUT', url: string]> = [
    ['GET', '/api/admin/apps'],
    ['POST', '/api/admin/apps'],
    ['POST', '/api/admin/assets/check'],
    ['PUT', `/api/admin/assets/${sha256Hex('x')}`],
    ['POST', '/api/admin/updates'],
  ];

  for (const [method, url] of protectedRoutes) {
    it(`rejects ${method} ${url} without a token`, async () => {
      const response = await harness.app.inject({ method, url, payload: {} });
      expect(response.statusCode).toBe(401);
    });
  }

  it('rejects a wrong token', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/admin/apps',
      headers: { authorization: 'Bearer wrong-token-0123456789abcdef0123456789ab' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a token that is a prefix of the real one', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/admin/apps',
      headers: { authorization: 'Bearer test-token-0123' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a non-Bearer scheme', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/admin/apps',
      headers: { authorization: 'Basic dGVzdDp0ZXN0' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('accepts the configured token', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/admin/apps',
      headers: auth,
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('admin API — publishing', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestApp();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('creates an app with the default channels', async () => {
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/admin/apps',
      headers: auth,
      payload: { slug: 'demo', name: 'Demo' },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json().app.slug).toBe('demo');

    // Both default channels must resolve rather than 404.
    for (const channel of ['production', 'staging']) {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/manifest/demo',
        headers: {
          'expo-protocol-version': '1',
          'expo-platform': 'ios',
          'expo-runtime-version': '1.0.0',
          accept: 'multipart/mixed',
          'expo-channel-name': channel,
        },
      });
      expect(response.statusCode).toBe(204);
    }
  });

  it('rejects a duplicate app slug', async () => {
    const payload = { slug: 'demo', name: 'Demo' };
    await harness.app.inject({ method: 'POST', url: '/api/admin/apps', headers: auth, payload });
    const second = await harness.app.inject({
      method: 'POST',
      url: '/api/admin/apps',
      headers: auth,
      payload,
    });
    expect(second.statusCode).toBe(409);
  });

  it('reports which asset hashes still need uploading', async () => {
    const known = sha256Hex('some bytes');
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/admin/assets/check',
      headers: auth,
      payload: { hashes: [known] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().missing).toEqual([known]);
  });

  it('reports nothing missing once bytes are uploaded, so republishing is cheap', async () => {
    await publishFixture(harness.app);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/admin/assets/check',
      headers: auth,
      payload: { hashes: [BUNDLE.sha256Hex] },
    });

    expect(response.json().missing).toEqual([]);
  });

  it('rejects an upload whose bytes do not hash to the claimed address', async () => {
    const response = await harness.app.inject({
      method: 'PUT',
      url: `/api/admin/assets/${sha256Hex('the claim')}`,
      headers: { ...auth, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('completely different bytes'),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/does not match/);
  });

  it('refuses to create an update referencing an asset that was never uploaded', async () => {
    await harness.app.inject({
      method: 'POST',
      url: '/api/admin/apps',
      headers: auth,
      payload: { slug: 'demo', name: 'Demo' },
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/admin/updates',
      headers: auth,
      payload: {
        appSlug: 'demo',
        channelName: 'production',
        platform: 'ios',
        runtimeVersion: '1.0.0',
        launchAsset: {
          sha256Hex: sha256Hex('never uploaded'),
          key: 'bundle',
          contentType: 'application/javascript',
        },
        assets: [],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/has not been uploaded/);
  });

  it('rejects an update for an unknown channel', async () => {
    await publishFixture(harness.app);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/admin/updates',
      headers: auth,
      payload: {
        appSlug: 'demo',
        channelName: 'nonexistent',
        platform: 'ios',
        runtimeVersion: '1.0.0',
        launchAsset: {
          sha256Hex: BUNDLE.sha256Hex,
          key: 'bundle',
          contentType: 'application/javascript',
        },
        assets: [],
      },
    });

    expect(response.statusCode).toBe(404);
  });

  it('does not leak internals when a request body is malformed', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/admin/apps',
      headers: auth,
      payload: { slug: 'Not A Valid Slug!', name: 'Demo' },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'internal server error' });
  });
});
