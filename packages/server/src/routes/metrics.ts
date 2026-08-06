import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { Metrics } from '../metrics.js';
import { requireBearerToken } from '../plugins/auth.js';
import { rateLimitHook } from '../plugins/rateLimit.js';

export interface MetricsRoutesOptions {
  config: Config;
  metrics: Metrics;
}

/**
 * Must be registered with `app.register`, never installed directly on the root
 * instance: the hook below is scoped to this plugin, and installing it
 * unencapsulated would demand a bearer token on every device request.
 */
export async function metricsRoutes(
  app: FastifyInstance,
  { config, metrics }: MetricsRoutesOptions,
): Promise<void> {
  // Ahead of authentication, so a token brute-force is throttled rather than
  // merely rejected. Hooks in a scope run in registration order.
  app.addHook('onRequest', rateLimitHook(app, config));
  // Metrics describe operations — app slugs, publish counts, error rates — and
  // this server is internet-facing, so they sit behind the same token as the
  // admin API. Prometheus sends it as an Authorization header.
  app.addHook('onRequest', requireBearerToken(config.PUBLISH_TOKEN));

  app.get('/metrics', async (_request, reply) => {
    const body = await metrics.registry.metrics();
    return reply
      .header('content-type', metrics.registry.contentType)
      .header('cache-control', 'no-store')
      .send(body);
  });
}

/**
 * Records every response.
 *
 * Installed directly on the root instance rather than via `app.register`,
 * because a hook added inside a plugin only sees that plugin's routes.
 */
export function installHttpMetrics(app: FastifyInstance, metrics: Metrics): void {
  app.addHook('onResponse', async (request, reply) => {
    // The matched pattern, so the label set is bounded by the number of
    // registered routes. `request.url` would let anyone mint a new series per
    // request simply by asking for a path that does not exist.
    const route = request.routeOptions.url ?? 'unmatched';
    metrics.httpRequests.inc({
      method: request.method,
      route,
      status: String(reply.statusCode),
    });
    metrics.httpDuration.observe({ route }, reply.elapsedTime / 1000);
  });
}
