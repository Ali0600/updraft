import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeStorage } from './helpers/fakeStorage.js';
import { createTestApp, type TestHarness } from './helpers/testApp.js';

describe('readiness and liveness', () => {
  let harness: TestHarness;

  afterEach(async () => harness?.close());

  it('reports ready when both dependencies answer', async () => {
    harness = await createTestApp();
    const response = await harness.app.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ready',
      checks: { database: 'ok', storage: 'ok' },
    });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('reports unready when storage fails', async () => {
    const storage = createFakeStorage({ failReads: new Error('bucket unreachable') });
    harness = await createTestApp({}, () => storage);

    const response = await harness.app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(503);
    expect(response.json().checks.storage).toBe('unavailable');
  });

  it('does not leak dependency error detail to an unauthenticated caller', async () => {
    // Driver exceptions carry bucket names, endpoints and account hints.
    const storage = createFakeStorage({
      failReads: new Error('s3://secret-bucket-name unreachable at internal.example'),
    });
    harness = await createTestApp({}, () => storage);

    const response = await harness.app.inject({ method: 'GET', url: '/readyz' });
    expect(response.body).not.toContain('secret-bucket-name');
    expect(response.body).not.toContain('internal.example');
  });

  it('keeps liveness green while a dependency is down', async () => {
    // /healthz backs the container HEALTHCHECK. Restarting the process cannot
    // fix an unreachable bucket, so failing here would only cause a crash loop.
    const storage = createFakeStorage({ failReads: new Error('bucket unreachable') });
    harness = await createTestApp({}, () => storage);

    const health = await harness.app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);

    const ready = await harness.app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(503);
  });

  it('probes dependencies at most once across many requests', async () => {
    // The endpoint cannot require a token, so without caching it turns one
    // free HTTP request into one paid object-store request at any rate a
    // caller chooses.
    const storage = createFakeStorage();
    harness = await createTestApp({}, () => storage);

    for (let i = 0; i < 10; i++) {
      await harness.app.inject({ method: 'GET', url: '/readyz' });
    }
    await Promise.all(
      Array.from({ length: 10 }, () => harness.app.inject({ method: 'GET', url: '/readyz' })),
    );

    expect(storage.calls.get.length).toBe(1);
  });
});

describe('rate limiting', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestApp({ RATE_LIMIT_ADMIN_MAX: '2' });
  });
  afterEach(async () => harness.close());

  it('limits unauthenticated admin requests before authenticating them', async () => {
    // The load-bearing assertion of the whole plugin. The bearer check is a
    // scope hook; a per-route limiter would run after it, so a flood would
    // get 401s and never reach the limiter — leaving the token unprotected.
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const response = await harness.app.inject({ method: 'GET', url: '/api/admin/apps' });
      statuses.push(response.statusCode);
    }

    expect(statuses.slice(0, 2)).toEqual([401, 401]);
    expect(statuses[2]).toBe(429);
  });

  it.each([
    ['manifest', '/api/manifest/demo'],
    ['assets', '/assets/0000000000000000000000000000000000000000000000000000000000000000'],
    ['liveness', '/healthz'],
    ['readiness', '/readyz'],
  ])('never throttles %s, which every device hits at once', async (_label, url) => {
    // A release wave means every client checks in simultaneously. Answering
    // that with 429s is a self-inflicted outage. A throttled healthcheck
    // additionally flaps the container.
    for (let i = 0; i < 8; i++) {
      const response = await harness.app.inject({ method: 'GET', url });
      expect(response.statusCode).not.toBe(429);
    }
  });
});
