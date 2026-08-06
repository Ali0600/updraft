import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, onRequestHookHandler } from 'fastify';
import type { Config } from '../config.js';

/**
 * Makes the limiter available, without attaching it to anything.
 *
 * `global: false` is deliberate. With `global: true` the plugin attaches
 * itself per *route*, and route-level hooks run **after** scope-level ones —
 * so the admin scope's bearer check would run first, and a flood of
 * unauthenticated requests would collect 401s while never reaching the
 * limiter. That leaves the token exactly as exposed as it was without a
 * limiter, which is the opposite of the point.
 *
 * Instead, protected scopes call `rateLimitHook` as their *first* onRequest
 * hook, so within a scope the limiter runs before authentication. Device paths
 * get no limiter at all: a release wave has every client checking in at once,
 * and answering that with 429s is a self-inflicted outage.
 */
export async function registerRateLimit(app: FastifyInstance, config: Config): Promise<void> {
  await app.register(rateLimit, {
    global: false,
    max: config.RATE_LIMIT_ADMIN_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_SECONDS * 1000,
  });
}

/** Must be added before any authentication hook in the same scope. */
export function rateLimitHook(app: FastifyInstance, config: Config): onRequestHookHandler {
  return app.rateLimit({
    max: config.RATE_LIMIT_ADMIN_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_SECONDS * 1000,
  });
}
