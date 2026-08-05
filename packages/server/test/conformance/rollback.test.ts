import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  auth,
  clientHeaders,
  expectNoUpdateAvailable,
  parseSinglePart,
  publishFixture,
} from '../helpers/publishFixture.js';
import { createTestApp, type TestHarness } from '../helpers/testApp.js';

const EMBEDDED_UPDATE_ID = '00000000-0000-4000-8000-000000000001';

describe('rollback to embedded', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestApp();
  });

  afterEach(async () => {
    await harness.close();
  });

  async function rollback(body: Record<string, unknown> = { runtimeVersion: '1.0.0' }) {
    return harness.app.inject({
      method: 'POST',
      url: '/api/admin/apps/demo/channels/production/rollback-to-embedded',
      headers: auth,
      payload: body,
    });
  }

  it('turns what the endpoint serves from a manifest into a rollback directive', async () => {
    await publishFixture(harness.app);

    const before = await harness.app.inject({
      method: 'GET',
      url: '/api/manifest/demo',
      headers: clientHeaders(),
    });
    expect(parseSinglePart(before).name).toBe('manifest');

    expect((await rollback()).statusCode).toBe(201);

    const after = await harness.app.inject({
      method: 'GET',
      url: '/api/manifest/demo',
      headers: clientHeaders(),
    });

    const part = parseSinglePart(after);
    expect(part.name).toBe('directive');
    expect(part.json).toMatchObject({
      type: 'rollBackToEmbedded',
      parameters: { commitTime: expect.any(String) },
    });
  });

  it('carries a commitTime that parses as a date', async () => {
    await publishFixture(harness.app);
    await rollback();

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/manifest/demo',
      headers: clientHeaders(),
    });

    const { commitTime } = (
      parseSinglePart(response).json as { parameters: { commitTime: string } }
    ).parameters;
    expect(Number.isNaN(Date.parse(commitTime))).toBe(false);
  });

  it('covers every platform by default', async () => {
    await publishFixture(harness.app, { platform: 'ios' });
    await publishFixture(harness.app, { platform: 'android', createApp: false });
    await rollback();

    for (const platform of ['ios', 'android']) {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/manifest/demo',
        headers: clientHeaders({ 'expo-platform': platform }),
      });
      expect(parseSinglePart(response).name).toBe('directive');
    }
  });

  it('can target a single platform, leaving the other serving updates', async () => {
    await publishFixture(harness.app, { platform: 'ios' });
    await publishFixture(harness.app, { platform: 'android', createApp: false });
    await rollback({ runtimeVersion: '1.0.0', platforms: ['ios'] });

    const ios = await harness.app.inject({
      method: 'GET',
      url: '/api/manifest/demo',
      headers: clientHeaders({ 'expo-platform': 'ios' }),
    });
    const android = await harness.app.inject({
      method: 'GET',
      url: '/api/manifest/demo',
      headers: clientHeaders({ 'expo-platform': 'android' }),
    });

    expect(parseSinglePart(ios).name).toBe('directive');
    expect(parseSinglePart(android).name).toBe('manifest');
  });

  it('does not tell a client already on the embedded bundle to roll back', async () => {
    await publishFixture(harness.app);
    await rollback();

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/manifest/demo',
      headers: clientHeaders({
        'expo-current-update-id': EMBEDDED_UPDATE_ID,
        'expo-embedded-update-id': EMBEDDED_UPDATE_ID,
      }),
    });

    // It has nowhere to roll back to; a directive would loop it forever.
    expectNoUpdateAvailable(response);
  });

  it('still rolls back a client running some other update', async () => {
    const { updateId } = await publishFixture(harness.app);
    await rollback();

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/manifest/demo',
      headers: clientHeaders({
        'expo-current-update-id': updateId,
        'expo-embedded-update-id': EMBEDDED_UPDATE_ID,
      }),
    });

    expect(parseSinglePart(response).name).toBe('directive');
  });

  it('returns 204 to a protocol-0 client, which cannot receive directives', async () => {
    await publishFixture(harness.app);
    await rollback();

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/manifest/demo',
      headers: clientHeaders({ 'expo-protocol-version': '0' }),
    });

    expect(response.statusCode).toBe(204);
  });

  it('returns 204 to a JSON-only client, whose envelope has no directive slot', async () => {
    await publishFixture(harness.app);
    await rollback();

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/manifest/demo',
      headers: clientHeaders({ accept: 'application/expo+json' }),
    });

    expect(response.statusCode).toBe(204);
  });

  it('rejects a rollback for an unknown app or channel', async () => {
    await publishFixture(harness.app);

    const unknownApp = await harness.app.inject({
      method: 'POST',
      url: '/api/admin/apps/nope/channels/production/rollback-to-embedded',
      headers: auth,
      payload: { runtimeVersion: '1.0.0' },
    });
    const unknownChannel = await harness.app.inject({
      method: 'POST',
      url: '/api/admin/apps/demo/channels/nope/rollback-to-embedded',
      headers: auth,
      payload: { runtimeVersion: '1.0.0' },
    });

    expect(unknownApp.statusCode).toBe(404);
    expect(unknownChannel.statusCode).toBe(404);
  });

  it('requires authentication', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/admin/apps/demo/channels/production/rollback-to-embedded',
      payload: { runtimeVersion: '1.0.0' },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('republish and disable', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestApp();
  });

  afterEach(async () => {
    await harness.close();
  });

  async function servedUpdateId(): Promise<string | undefined> {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/manifest/demo',
      headers: clientHeaders(),
    });
    if (response.statusCode !== 200) return undefined;
    const part = parseSinglePart(response);
    return part.name === 'manifest' ? (part.json as { id: string }).id : undefined;
  }

  async function groupIdOf(updateId: string): Promise<string> {
    const { updates } = await import('../../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    const row = harness.db.select().from(updates).where(eq(updates.id, updateId)).get();
    if (!row) throw new Error(`no update row for ${updateId}`);
    return row.groupId;
  }

  it('brings an older publish back into service after a bad release', async () => {
    const good = await publishFixture(harness.app);
    const bad = await publishFixture(harness.app, { createApp: false });
    expect(await servedUpdateId()).toBe(bad.updateId);

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/admin/updates/${await groupIdOf(good.updateId)}/republish`,
      headers: auth,
    });
    expect(response.statusCode).toBe(201);

    // A new row wins by recency; the id differs from the original because it
    // is a new publish of the same content.
    const served = await servedUpdateId();
    expect(served).not.toBe(bad.updateId);
    expect(served).toBe(response.json().updates[0].id);
  });

  it('republishes the same assets without re-uploading anything', async () => {
    const { updateId, bundle } = await publishFixture(harness.app);
    await harness.app.inject({
      method: 'POST',
      url: `/api/admin/updates/${await groupIdOf(updateId)}/republish`,
      headers: auth,
    });

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/manifest/demo',
      headers: clientHeaders(),
    });

    const manifest = parseSinglePart(response).json as {
      launchAsset: { url: string };
      assets: unknown[];
    };
    expect(manifest.launchAsset.url).toContain(bundle.sha256Hex);
    expect(manifest.assets).toHaveLength(1);
  });

  it('takes a whole publish out of service across platforms', async () => {
    const ios = await publishFixture(harness.app, { platform: 'ios' });
    await publishFixture(harness.app, { platform: 'android', createApp: false });
    const groupId = await groupIdOf(ios.updateId);

    // Put both platforms of one publish under a single group.
    const { updates } = await import('../../src/db/schema.js');
    harness.db.update(updates).set({ groupId }).run();

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/admin/updates/${groupId}/disable`,
      headers: auth,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().disabled).toBe(2);

    for (const platform of ['ios', 'android']) {
      const manifest = await harness.app.inject({
        method: 'GET',
        url: '/api/manifest/demo',
        headers: clientHeaders({ 'expo-platform': platform }),
      });
      expectNoUpdateAvailable(manifest);
    }
  });

  it('404s on republishing or disabling an unknown group', async () => {
    const unknown = '11111111-1111-4111-8111-111111111111';
    const republish = await harness.app.inject({
      method: 'POST',
      url: `/api/admin/updates/${unknown}/republish`,
      headers: auth,
    });
    const disable = await harness.app.inject({
      method: 'POST',
      url: `/api/admin/updates/${unknown}/disable`,
      headers: auth,
    });

    expect(republish.statusCode).toBe(404);
    expect(disable.statusCode).toBe(404);
  });

  it('refuses to republish a rollback marker as if it were an update', async () => {
    await publishFixture(harness.app);
    const rolled = await harness.app.inject({
      method: 'POST',
      url: '/api/admin/apps/demo/channels/production/rollback-to-embedded',
      headers: auth,
      payload: { runtimeVersion: '1.0.0' },
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/admin/updates/${rolled.json().groupId}/republish`,
      headers: auth,
    });

    expect(response.statusCode).toBe(404);
  });

  it('requires authentication for both operations', async () => {
    for (const action of ['republish', 'disable']) {
      const response = await harness.app.inject({
        method: 'POST',
        url: `/api/admin/updates/00000000-0000-4000-8000-000000000009/${action}`,
      });
      expect(response.statusCode).toBe(401);
    }
  });
});
