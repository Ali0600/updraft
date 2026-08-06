import type { FastifyInstance } from 'fastify';
import type { ReadinessProbe } from '../services/readiness.js';

export interface HealthRoutesOptions {
  readiness: ReadinessProbe;
}

export async function healthRoutes(
  app: FastifyInstance,
  { readiness }: HealthRoutesOptions,
): Promise<void> {
  // Liveness: the process is up. Deliberately never touches a dependency —
  // this backs the container HEALTHCHECK, and restarting the server cannot
  // fix an unreachable database or object store.
  app.get('/healthz', async () => ({ status: 'ok' }));

  // Readiness: can this process actually serve? Answers are cached briefly
  // inside the probe, because this endpoint is necessarily unauthenticated.
  app.get('/readyz', async (_request, reply) => {
    const report = await readiness();
    return (
      reply
        .code(report.ready ? 200 : 503)
        // A cached readiness answer is its own outage.
        .header('cache-control', 'no-store')
        .send({
          // Names of failing dependencies only. Driver exceptions carry bucket
          // names and endpoints, and this response has no authentication.
          status: report.ready ? 'ready' : 'unready',
          checks: report.checks,
        })
    );
  });
}
