import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auth, BUNDLE, clientHeaders, publishFixture } from './helpers/publishFixture.js';
import { createTestApp, type TestHarness } from './helpers/testApp.js';

async function scrape(harness: TestHarness): Promise<string> {
  const response = await harness.app.inject({ method: 'GET', url: '/metrics', headers: auth });
  expect(response.statusCode).toBe(200);
  return response.body;
}

/** Counts distinct series lines for a metric, which is what cardinality means. */
function seriesCount(body: string, metric: string): number {
  return body
    .split('\n')
    .filter((line) => line.startsWith(`${metric}{`) || line.startsWith(`${metric} `)).length;
}

describe('metrics endpoint', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestApp();
  });
  afterEach(async () => harness.close());

  it('refuses an unauthenticated scrape', async () => {
    // Metrics carry app slugs, publish counts and error rates, and this
    // server is internet-facing.
    const response = await harness.app.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a wrong token', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer not-the-token' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('serves Prometheus text to an authenticated scrape', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: auth,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/plain/);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toContain('updraft_build_info');
  });

  it('leaves the device paths unauthenticated', async () => {
    // The metrics hook is scoped to its own plugin; installed globally it
    // would demand a token from every device.
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/manifest/demo',
      headers: clientHeaders(),
    });
    expect(response.statusCode).not.toBe(401);
  });
});

describe('metrics cardinality', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestApp();
  });
  afterEach(async () => harness.close());

  it('labels requests with the route pattern, not the URL', async () => {
    // A label taken from the URL lets anyone mint unbounded series — that is
    // remote memory exhaustion, not untidy monitoring.
    for (let i = 0; i < 25; i++) {
      await harness.app.inject({ method: 'GET', url: `/${randomBytes(8).toString('hex')}` });
    }

    const body = await scrape(harness);
    expect(body).toContain('route="unmatched"');
    expect(seriesCount(body, 'updraft_http_requests_total')).toBeLessThan(6);
  });

  it('labels manifest platforms from a closed set, including rejected requests', async () => {
    // Rejected requests are the case that matters. On that path the platform
    // header has not been validated yet, so it arrives raw — using it as a
    // label directly would let anyone mint one series per request.
    await publishFixture(harness.app);
    for (let i = 0; i < 25; i++) {
      await harness.app.inject({
        method: 'GET',
        url: '/api/manifest/demo',
        headers: { ...clientHeaders(), 'expo-platform': randomBytes(6).toString('hex') },
      });
    }

    const body = await scrape(harness);
    const platforms = [...body.matchAll(/updraft_manifest_outcomes_total\{platform="([^"]+)"/g)];
    expect(platforms.length).toBeGreaterThan(0);
    for (const [, platform] of platforms) {
      expect(['ios', 'android', 'unknown']).toContain(platform);
    }
    expect(seriesCount(body, 'updraft_manifest_outcomes_total')).toBeLessThan(5);
  });

  it('counts asset bytes actually served', async () => {
    await publishFixture(harness.app);
    await harness.app.inject({ method: 'GET', url: `/assets/${BUNDLE.sha256Hex}` });

    const body = await scrape(harness);
    const total = /updraft_asset_bytes_sent_total (\d+)/.exec(body)?.[1];
    expect(Number(total)).toBe(BUNDLE.bytes.length);
  });
});
