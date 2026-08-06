import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assetStorageKey } from '../src/storage/BlobStorage.js';
import {
  BUNDLE,
  clientHeaders,
  parseSinglePart,
  publishFixture,
} from './helpers/publishFixture.js';
import { createTestApp, type TestHarness } from './helpers/testApp.js';

const CDN = 'https://cdn.example.com';

interface ManifestAsset {
  url: string;
  key: string;
}

async function manifestAssets(harness: TestHarness): Promise<ManifestAsset[]> {
  const response = await harness.app.inject({
    method: 'GET',
    url: '/api/manifest/demo',
    headers: clientHeaders(),
  });
  expect(response.statusCode).toBe(200);
  const manifest = parseSinglePart(response).json as {
    launchAsset: ManifestAsset;
    assets: ManifestAsset[];
  };
  return [manifest.launchAsset, ...manifest.assets];
}

describe('asset delivery — proxy mode (the default)', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestApp();
    await publishFixture(harness.app);
  });
  afterEach(async () => harness.close());

  it('addresses assets at the server itself', async () => {
    for (const asset of await manifestAssets(harness)) {
      expect(asset.url.startsWith('http://localhost:3000/assets/')).toBe(true);
    }
  });
});

describe('asset delivery — direct mode', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestApp({ ASSETS_BASE_URL: CDN });
    await publishFixture(harness.app);
  });
  afterEach(async () => harness.close());

  it('addresses assets at the configured origin', async () => {
    const assets = await manifestAssets(harness);
    expect(assets.length).toBeGreaterThan(0);
    for (const asset of assets) {
      expect(asset.url.startsWith(`${CDN}/`)).toBe(true);
    }
  });

  it('uses the storage key as the URL path, so both sides address one object', async () => {
    // The invariant that makes direct delivery work at all: whatever key the
    // driver wrote under must be the path a CDN resolves. Asserted rather than
    // left to two string literals agreeing by eye.
    const [launch] = await manifestAssets(harness);
    expect(launch?.url).toBe(`${CDN}/${assetStorageKey(BUNDLE.sha256Hex)}`);
    expect(launch?.url).toBe(`${CDN}/assets/${BUNDLE.sha256Hex}`);
  });

  it('keeps serving assets itself, because deployed clients still ask', async () => {
    // Devices in the field hold manifests addressed to PUBLIC_URL. Disabling
    // the proxy when a CDN is configured would break every update mid-flight.
    const response = await harness.app.inject({
      method: 'GET',
      url: `/assets/${BUNDLE.sha256Hex}`,
    });
    expect(response.statusCode).toBe(200);
    expect(Buffer.from(response.rawPayload).equals(BUNDLE.bytes)).toBe(true);
  });

  it('does not double the slash when the origin is given with a trailing one', async () => {
    const trailing = await createTestApp({ ASSETS_BASE_URL: `${CDN}///` });
    try {
      await publishFixture(trailing.app);
      for (const asset of await manifestAssets(trailing)) {
        expect(asset.url).not.toContain('.com//');
      }
    } finally {
      await trailing.close();
    }
  });
});
