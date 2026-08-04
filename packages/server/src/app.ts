import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { healthRoutes } from './routes/health.js';

export interface BuildAppOptions {
  config: Config;
}

/**
 * Builds the Fastify instance without listening, so tests can drive it through
 * `app.inject()` instead of binding a port.
 */
export async function buildApp({ config }: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Credentials must never reach the log stream, including on error paths.
      redact: {
        paths: ['req.headers.authorization'],
        censor: '[redacted]',
      },
      // Spread rather than assign undefined: exactOptionalPropertyTypes makes
      // an explicit `transport: undefined` a type error.
      ...(config.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
        : {}),
    },
    // Asset uploads stream; nothing else needs a large body.
    bodyLimit: 10 * 1024 * 1024,
  });

  app.decorate('config', config);

  await app.register(healthRoutes);

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
  }
}
