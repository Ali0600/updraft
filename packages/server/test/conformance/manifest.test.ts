import { manifestSchema, parseMultipartBody, sha256Base64Url } from '@ota/core';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { updates } from '../../src/db/schema.js';
import { clientHeaders, publishFixture } from '../helpers/publishFixture.js';
import { createTestApp, type TestHarness } from '../helpers/testApp.js';

function boundaryOf(contentType: string): string {
  const boundary = /boundary=([^;]+)/.exec(contentType)?.[1];
  if (!boundary) throw new Error(`no boundary in content-type: ${contentType}`);
  return boundary;
}

describe('manifest endpoint — protocol conformance', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestApp();
  });

  afterEach(async () => {
    await harness.close();
  });

  describe('request validation', () => {
    it('rejects a missing expo-platform', async () => {
      await publishFixture(harness.app);
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/manifest/demo',
        headers: clientHeaders({ 'expo-platform': '' }),
      });
      expect(response.statusCode).toBe(400);
    });

    it('rejects an unknown platform', async () => {
      await publishFixture(harness.app);
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/manifest/demo',
        headers: clientHeaders({ 'expo-platform': 'windows' }),
      });
      expect(response.statusCode).toBe(400);
    });

    it('rejects a missing expo-runtime-version', async () => {
      await publishFixture(harness.app);
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/manifest/demo',
        headers: clientHeaders({ 'expo-runtime-version': '' }),
      });
      expect(response.statusCode).toBe(400);
    });

    it('rejects an unsupported protocol version', async () => {
      await publishFixture(harness.app);
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/manifest/demo',
        headers: clientHeaders({ 'expo-protocol-version': '99' }),
      });
      expect(response.statusCode).toBe(400);
    });

    it('returns 406 when the client accepts neither multipart nor expo+json', async () => {
      await publishFixture(harness.app);
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/manifest/demo',
        headers: clientHeaders({ accept: 'text/html' }),
      });
      expect(response.statusCode).toBe(406);
    });

    it('returns 404 for an unknown app rather than falling through to a default', async () => {
      await publishFixture(harness.app);
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/manifest/no-such-app',
        headers: clientHeaders(),
      });
      expect(response.statusCode).toBe(404);
    });

    it('returns 404 for an unknown channel', async () => {
      await publishFixture(harness.app);
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/manifest/demo',
        headers: clientHeaders({ 'expo-channel-name': 'no-such-channel' }),
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('protocol response headers', () => {
    it('sets them on a 200', async () => {
      await publishFixture(harness.app);
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/manifest/demo',
        headers: clientHeaders(),
      });

      expect(response.headers['expo-protocol-version']).toBe('1');
      expect(response.headers['expo-sfv-version']).toBe('0');
      expect(response.headers['cache-control']).toBe('private, max-age=0');
    });

    it('sets them on a 204 too, where they are easiest to forget', async () => {
      await publishFixture(harness.app);
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/manifest/demo',
        headers: clientHeaders({ 'expo-runtime-version': '99.0.0' }),
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers['expo-protocol-version']).toBe('1');
      expect(response.headers['expo-sfv-version']).toBe('0');
    });
  });

  describe('update resolution', () => {
    it('returns 204 when nothing is published for the runtime version', async () => {
      await publishFixture(harness.app, { runtimeVersion: '1.0.0' });
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/manifest/demo',
        headers: clientHeaders({ 'expo-runtime-version': '2.0.0' }),
      });
      expect(response.statusCode).toBe(204);
    });

    it('does not serve another platform’s update', async () => {
      await publishFixture(harness.app, { platform: 'ios' });
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/manifest/demo',
        headers: clientHeaders({ 'expo-platform': 'android' }),
      });
      expect(response.statusCode).toBe(204);
    });

    it('returns 204 when the client already runs the newest update', async () => {
      const { updateId } = await publishFixture(harness.app);
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/manifest/demo',
        headers: clientHeaders({ 'expo-current-update-id': updateId }),
      });
      expect(response.statusCode).toBe(204);
    });

    it('serves the newest update when the client is on an older one', async () => {
      const first = await publishFixture(harness.app);
      const second = await publishFixture(harness.app, { createApp: false });

      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/manifest/demo',
        headers: clientHeaders({ 'expo-current-update-id': first.updateId }),
      });

      expect(response.statusCode).toBe(200);
      const parts = parseMultipartBody(
        response.rawPayload,
        boundaryOf(response.headers['content-type'] as string),
      );
      expect(JSON.parse(parts[0]?.body.toString('utf8') ?? '{}').id).toBe(second.updateId);
    });

    it('never serves a disabled update', async () => {
      const { updateId } = await publishFixture(harness.app);
      harness.db.update(updates).set({ status: 'disabled' }).where(eq(updates.id, updateId)).run();

      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/manifest/demo',
        headers: clientHeaders(),
      });

      expect(response.statusCode).toBe(204);
    });

    it('falls back to the previous update when the newest is disabled', async () => {
      const first = await publishFixture(harness.app);
      const second = await publishFixture(harness.app, { createApp: false });
      harness.db
        .update(updates)
        .set({ status: 'disabled' })
        .where(eq(updates.id, second.updateId))
        .run();

      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/manifest/demo',
        headers: clientHeaders(),
      });

      expect(response.statusCode).toBe(200);
      const parts = parseMultipartBody(
        response.rawPayload,
        boundaryOf(response.headers['content-type'] as string),
      );
      expect(JSON.parse(parts[0]?.body.toString('utf8') ?? '{}').id).toBe(first.updateId);
    });

    it('keeps channels isolated', async () => {
      await publishFixture(harness.app, { channelName: 'production' });
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/manifest/demo',
        headers: clientHeaders({ 'expo-channel-name': 'staging' }),
      });
      expect(response.statusCode).toBe(204);
    });
  });

  describe('manifest body', () => {
    it('is a multipart/mixed part named "manifest" that parses back', async () => {
      await publishFixture(harness.app);
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/manifest/demo',
        headers: clientHeaders(),
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/^multipart\/mixed; boundary=/);

      const parts = parseMultipartBody(
        response.rawPayload,
        boundaryOf(response.headers['content-type'] as string),
      );
      expect(parts).toHaveLength(1);
      expect(parts[0]?.name).toBe('manifest');
    });

    it('satisfies the manifest schema', async () => {
      const { updateId } = await publishFixture(harness.app);
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/manifest/demo',
        headers: clientHeaders(),
      });

      const parts = parseMultipartBody(
        response.rawPayload,
        boundaryOf(response.headers['content-type'] as string),
      );
      const manifest = manifestSchema.parse(JSON.parse(parts[0]?.body.toString('utf8') ?? '{}'));

      expect(manifest.id).toBe(updateId);
      expect(manifest.runtimeVersion).toBe('1.0.0');
    });

    it('carries hashes that match the fixture bytes, recomputed here', async () => {
      const { bundle, icon } = await publishFixture(harness.app);
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/manifest/demo',
        headers: clientHeaders(),
      });

      const parts = parseMultipartBody(
        response.rawPayload,
        boundaryOf(response.headers['content-type'] as string),
      );
      const manifest = manifestSchema.parse(JSON.parse(parts[0]?.body.toString('utf8') ?? '{}'));

      // Recomputed from the bytes on disk, never read back from the server.
      expect(manifest.launchAsset.hash).toBe(sha256Base64Url(bundle.bytes));
      const iconAsset = manifest.assets.find((asset) => asset.key === 'icon');
      expect(iconAsset?.hash).toBe(sha256Base64Url(icon.bytes));
    });

    it('lists the launch asset only as launchAsset, not again in assets', async () => {
      const { bundle } = await publishFixture(harness.app);
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/manifest/demo',
        headers: clientHeaders(),
      });

      const parts = parseMultipartBody(
        response.rawPayload,
        boundaryOf(response.headers['content-type'] as string),
      );
      const manifest = manifestSchema.parse(JSON.parse(parts[0]?.body.toString('utf8') ?? '{}'));

      // The fixture has one bundle and one asset, so `assets` holds exactly the
      // icon. Repeating the bundle would make the client fetch it twice.
      expect(manifest.launchAsset.hash).toBe(sha256Base64Url(bundle.bytes));
      expect(manifest.assets).toHaveLength(1);
      expect(manifest.assets.map((asset) => asset.key)).toEqual(['icon']);
    });

    it('emits absolute asset URLs built from PUBLIC_URL', async () => {
      await publishFixture(harness.app);
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/manifest/demo',
        headers: clientHeaders(),
      });

      const parts = parseMultipartBody(
        response.rawPayload,
        boundaryOf(response.headers['content-type'] as string),
      );
      const manifest = manifestSchema.parse(JSON.parse(parts[0]?.body.toString('utf8') ?? '{}'));

      expect(manifest.launchAsset.url).toMatch(/^http:\/\/localhost:3000\/assets\/[a-f0-9]{64}$/);
    });

    it('serves a bare JSON body when the client asks for expo+json', async () => {
      await publishFixture(harness.app);
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/manifest/demo',
        headers: clientHeaders({ accept: 'application/expo+json' }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/application\/expo\+json/);
      expect(manifestSchema.safeParse(JSON.parse(response.body)).success).toBe(true);
    });
  });

  describe('end-to-end asset delivery', () => {
    it('every asset URL in the manifest serves bytes matching its hash', async () => {
      await publishFixture(harness.app);
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/manifest/demo',
        headers: clientHeaders(),
      });

      const parts = parseMultipartBody(
        response.rawPayload,
        boundaryOf(response.headers['content-type'] as string),
      );
      const manifest = manifestSchema.parse(JSON.parse(parts[0]?.body.toString('utf8') ?? '{}'));

      for (const asset of [manifest.launchAsset, ...manifest.assets]) {
        const path = new URL(asset.url).pathname;
        const fetched = await harness.app.inject({ method: 'GET', url: path });

        expect(fetched.statusCode).toBe(200);
        expect(sha256Base64Url(fetched.rawPayload)).toBe(asset.hash);
      }
    });
  });
});
