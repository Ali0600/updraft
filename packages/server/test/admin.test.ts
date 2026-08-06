import { sha256Hex } from '@ota/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assets } from '../src/db/schema.js';
import { createFakeStorage } from './helpers/fakeStorage.js';
import {
  auth,
  BUNDLE,
  clientHeaders,
  expectNoUpdateAvailable,
  publishFixture,
} from './helpers/publishFixture.js';
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
        headers: clientHeaders({ 'expo-channel-name': channel }),
      });
      expectNoUpdateAvailable(response);
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

  it.each([
    ['a header injection attempt', 'text/plain\r\nX-Injected: yes'],
    ['a value that is not a media type', 'not-a-media-type'],
    ['an empty type', '/plain'],
  ])('rejects %s in the content-type header', async (_label, value) => {
    // In direct-delivery mode this value is echoed by a CDN we do not
    // control, so an unvalidated one is header injection into someone else's
    // response. Rejecting beats substituting a default: a malformed value
    // means a broken client, and silently storing something else is how the
    // two delivery modes drift apart.
    const response = await harness.app.inject({
      method: 'PUT',
      url: `/api/admin/assets/${BUNDLE.sha256Hex}`,
      headers: {
        ...auth,
        'content-type': 'application/octet-stream',
        'x-updraft-content-type': value,
      },
      payload: BUNDLE.bytes,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/media type/);
  });

  it('passes the media type through to the storage driver', async () => {
    // Asserted at the driver boundary rather than by reading it back: the
    // local filesystem has nowhere to record a content type (it comes from
    // the assets row when this server serves the bytes), while S3 stores it
    // on the object. Only the driver call is common to both.
    const storage = createFakeStorage();
    const app = await createTestApp({}, () => storage);
    try {
      const response = await app.app.inject({
        method: 'PUT',
        url: `/api/admin/assets/${BUNDLE.sha256Hex}`,
        headers: {
          ...auth,
          'content-type': 'application/octet-stream',
          'x-updraft-content-type': 'application/javascript; charset=utf-8',
        },
        payload: BUNDLE.bytes,
      });

      expect(response.statusCode).toBe(201);
      // Parameters are dropped; only the media type is kept.
      expect(storage.blobs.get(`assets/${BUNDLE.sha256Hex}`)?.contentType).toBe(
        'application/javascript',
      );
    } finally {
      await app.close();
    }
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

  it('records each asset size from the stored bytes, not from the publisher', async () => {
    // The size is read back from storage during publish, so the recorded
    // number describes the bytes actually being served. A publisher cannot
    // assert a size, and nothing may invent one.
    await publishFixture(harness.app);

    const rows = harness.db.select().from(assets).all();
    const bundle = rows.find((row) => row.sha256Hex === BUNDLE.sha256Hex);
    expect(bundle?.sizeBytes).toBe(BUNDLE.bytes.length);
    expect(rows.every((row) => row.sizeBytes > 0)).toBe(true);
  });

  it('lists updates newest first with their group ids', async () => {
    const first = await publishFixture(harness.app);
    const second = await publishFixture(harness.app, { createApp: false });

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/admin/apps/demo/updates',
      headers: auth,
    });

    expect(response.statusCode).toBe(200);
    const listed = response.json().updates;
    expect(listed).toHaveLength(2);
    expect(listed[0].id).toBe(second.updateId);
    expect(listed[1].id).toBe(first.updateId);
    expect(listed[0].groupId).toBeDefined();
    expect(listed[0].status).toBe('active');
  });

  it('filters the update list by channel', async () => {
    await publishFixture(harness.app, { channelName: 'production' });
    await publishFixture(harness.app, { channelName: 'staging', createApp: false });

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/admin/apps/demo/updates?channel=staging',
      headers: auth,
    });

    expect(response.json().updates).toHaveLength(1);
  });

  it('404s the update list for an unknown app or channel', async () => {
    await publishFixture(harness.app);

    const unknownApp = await harness.app.inject({
      method: 'GET',
      url: '/api/admin/apps/nope/updates',
      headers: auth,
    });
    const unknownChannel = await harness.app.inject({
      method: 'GET',
      url: '/api/admin/apps/demo/updates?channel=nope',
      headers: auth,
    });

    expect(unknownApp.statusCode).toBe(404);
    expect(unknownChannel.statusCode).toBe(404);
  });

  it('requires auth on the update list', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/admin/apps/demo/updates',
    });
    expect(response.statusCode).toBe(401);
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
