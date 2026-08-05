/** Environment variable holding the publish token — never a CLI flag, which
 * would leak into shell history and CI logs. */
export const TOKEN_ENV_VAR = 'UPDRAFT_PUBLISH_TOKEN';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface AssetPayload {
  sha256Hex: string;
  key: string;
  contentType: string;
  fileExtension?: string;
}

export interface CreateUpdatePayload {
  appSlug: string;
  channelName: string;
  platform: 'ios' | 'android';
  runtimeVersion: string;
  launchAsset: AssetPayload;
  assets: AssetPayload[];
  metadata?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  groupId?: string;
  gitCommit?: string;
  publishedBy?: string;
}

export interface UpdateSummary {
  id: string;
  groupId: string;
  platform: string;
  runtimeVersion: string;
  type: string;
  status: string;
  createdAt: string;
  gitCommit: string | null;
  publishedBy: string | null;
}

export class AdminApi {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(serverUrl: string, token: string | undefined = process.env[TOKEN_ENV_VAR]) {
    if (!token) {
      throw new ApiError(
        `no publish token: set ${TOKEN_ENV_VAR} in the environment (never pass tokens as flags)`,
        undefined,
      );
    }
    this.baseUrl = serverUrl.replace(/\/+$/, '');
    this.token = token;
  }

  async createApp(slug: string, name: string): Promise<{ id: string; slug: string }> {
    const body = await this.request('POST', '/api/admin/apps', { slug, name });
    return body.app;
  }

  async listApps(): Promise<Array<{ slug: string; name: string; createdAt: string }>> {
    return (await this.request('GET', '/api/admin/apps')).apps;
  }

  /** Returns the subset of hashes the server does not have yet. */
  async checkAssets(hashes: string[]): Promise<string[]> {
    return (await this.request('POST', '/api/admin/assets/check', { hashes })).missing;
  }

  async uploadAsset(sha256Hex: string, bytes: Buffer): Promise<void> {
    await this.request('PUT', `/api/admin/assets/${sha256Hex}`, bytes);
  }

  async createUpdate(payload: CreateUpdatePayload): Promise<UpdateSummary> {
    return (await this.request('POST', '/api/admin/updates', payload)).update;
  }

  async listUpdates(appSlug: string, channel?: string): Promise<UpdateSummary[]> {
    const query = channel ? `?channel=${encodeURIComponent(channel)}` : '';
    return (
      await this.request('GET', `/api/admin/apps/${encodeURIComponent(appSlug)}/updates${query}`)
    ).updates;
  }

  async rollbackToEmbedded(
    appSlug: string,
    channelName: string,
    runtimeVersion: string,
    platforms?: string[],
  ): Promise<{ groupId: string }> {
    return this.request(
      'POST',
      `/api/admin/apps/${encodeURIComponent(appSlug)}/channels/${encodeURIComponent(channelName)}/rollback-to-embedded`,
      { runtimeVersion, ...(platforms?.length ? { platforms } : {}) },
    );
  }

  async republish(groupId: string): Promise<{ groupId: string; updates: UpdateSummary[] }> {
    return this.request('POST', `/api/admin/updates/${encodeURIComponent(groupId)}/republish`);
  }

  async disable(groupId: string): Promise<{ disabled: number }> {
    return this.request('POST', `/api/admin/updates/${encodeURIComponent(groupId)}/disable`);
  }

  // biome-ignore lint/suspicious/noExplicitAny: response shapes are asserted by callers
  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const isBuffer = Buffer.isBuffer(body);
    const init: RequestInit = {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined
          ? {}
          : { 'content-type': isBuffer ? 'application/octet-stream' : 'application/json' }),
      },
    };
    if (body !== undefined) {
      init.body = isBuffer ? new Uint8Array(body) : JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, init);
    } catch (error) {
      throw new ApiError(`cannot reach ${this.baseUrl}: ${(error as Error).message}`, undefined);
    }

    if (!response.ok) {
      let detail = '';
      try {
        detail = ((await response.json()) as { error?: string }).error ?? '';
      } catch {
        // Non-JSON error body; the status alone will have to do.
      }
      throw new ApiError(
        `${method} ${path} failed (${response.status})${detail ? `: ${detail}` : ''}`,
        response.status,
      );
    }

    if (response.status === 204) return {};
    return response.json();
  }
}
