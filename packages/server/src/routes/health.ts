import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // Liveness: the process is up. Never touches dependencies.
  app.get('/healthz', async () => ({ status: 'ok' }));

  // Readiness: dependencies actually answer. Probes land here in M4.
  app.get('/readyz', async () => ({ status: 'ok' }));
}
