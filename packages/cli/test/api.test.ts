import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminApi, ApiError, TOKEN_ENV_VAR } from '../src/api.js';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';

// Parameters are declared so `mock.calls` is typed as a real fetch call rather
// than an empty tuple.
function stubFetch(response: Partial<Response> & { jsonValue?: unknown }) {
  const spy = vi.fn(async (_url: string | URL, _init?: RequestInit) => ({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: async () => response.jsonValue ?? {},
  }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('AdminApi authentication', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('refuses to construct without a token rather than calling unauthenticated', () => {
    vi.stubEnv(TOKEN_ENV_VAR, '');
    expect(() => new AdminApi('http://localhost:3000')).toThrow(ApiError);
  });

  it('names the environment variable so the fix is obvious', () => {
    vi.stubEnv(TOKEN_ENV_VAR, '');
    expect(() => new AdminApi('http://localhost:3000')).toThrow(new RegExp(TOKEN_ENV_VAR));
  });

  it('reads the token from the environment', async () => {
    vi.stubEnv(TOKEN_ENV_VAR, TOKEN);
    const spy = stubFetch({ jsonValue: { apps: [] } });

    await new AdminApi('http://localhost:3000').listApps();

    const init = spy.mock.calls[0]?.[1] as RequestInit;
    if (!init) throw new Error('fetch was never called');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('never puts the token in the URL, where it would land in server logs', async () => {
    vi.stubEnv(TOKEN_ENV_VAR, TOKEN);
    const spy = stubFetch({ jsonValue: { apps: [] } });

    await new AdminApi('http://localhost:3000').listApps();

    expect(String(spy.mock.calls[0]?.[0])).not.toContain(TOKEN);
  });
});

describe('AdminApi error handling', () => {
  beforeEach(() => {
    vi.stubEnv(TOKEN_ENV_VAR, TOKEN);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('throws on a non-2xx response instead of reporting a phantom success', async () => {
    stubFetch({ ok: false, status: 400, jsonValue: { error: 'asset has not been uploaded' } });

    // A publish that "succeeds" against a failing server is the worst outcome:
    // nothing shipped, and nothing said so.
    await expect(
      new AdminApi('http://localhost:3000').createUpdate({
        appSlug: 'demo',
        channelName: 'production',
        platform: 'ios',
        runtimeVersion: '1.0.0',
        launchAsset: { sha256Hex: 'a'.repeat(64), key: 'k', contentType: 'application/javascript' },
        assets: [],
      }),
    ).rejects.toThrow(ApiError);
  });

  it("surfaces the server's own error message", async () => {
    stubFetch({ ok: false, status: 404, jsonValue: { error: "unknown channel 'nope'" } });

    await expect(new AdminApi('http://localhost:3000').listApps()).rejects.toThrow(
      /unknown channel 'nope'/,
    );
  });

  it('still throws when the error body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 502,
        json: async () => {
          throw new Error('not json');
        },
      })),
    );

    await expect(new AdminApi('http://localhost:3000').listApps()).rejects.toThrow(/502/);
  });

  it('reports an unreachable server against the URL it tried', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    await expect(new AdminApi('http://localhost:9999').listApps()).rejects.toThrow(
      /localhost:9999/,
    );
  });

  it('tolerates a 204 with no body', async () => {
    stubFetch({ status: 204 });
    await expect(new AdminApi('http://localhost:3000').disable('group')).resolves.toBeDefined();
  });
});

describe('AdminApi requests', () => {
  beforeEach(() => {
    vi.stubEnv(TOKEN_ENV_VAR, TOKEN);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('uploads blobs as octet-stream so bytes are not transformed', async () => {
    const spy = stubFetch({ status: 201 });
    const bytes = Buffer.from([0x00, 0xff, 0x10]);

    await new AdminApi('http://localhost:3000').uploadAsset('a'.repeat(64), bytes);

    const init = spy.mock.calls[0]?.[1] as RequestInit;
    if (!init) throw new Error('fetch was never called');
    expect((init.headers as Record<string, string>)['content-type']).toBe(
      'application/octet-stream',
    );
    expect(Buffer.from(init.body as Uint8Array).equals(bytes)).toBe(true);
  });

  it('strips a trailing slash so URLs never double up', async () => {
    const spy = stubFetch({ jsonValue: { apps: [] } });

    await new AdminApi('http://localhost:3000///').listApps();

    expect(String(spy.mock.calls[0]?.[0])).toBe('http://localhost:3000/api/admin/apps');
  });

  it('url-encodes path parameters', async () => {
    const spy = stubFetch({ jsonValue: { updates: [] } });

    await new AdminApi('http://localhost:3000').listUpdates('my app', 'chan/nel');

    const url = String(spy.mock.calls[0]?.[0]);
    expect(url).toContain('my%20app');
    expect(url).toContain('chan%2Fnel');
  });
});
