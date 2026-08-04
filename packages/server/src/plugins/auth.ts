import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Bearer-token guard for every admin route.
 *
 * Compares SHA-256 digests rather than the raw strings: timingSafeEqual
 * requires equal-length inputs, and comparing raw tokens would either throw or
 * leak the expected length.
 */
export function requireBearerToken(expectedToken: string) {
  const expected = createHash('sha256').update(expectedToken).digest();

  return async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }

    const provided = createHash('sha256').update(header.slice('Bearer '.length)).digest();
    if (!timingSafeEqual(provided, expected)) {
      // Deliberately identical to the missing-header response: a distinct
      // message would confirm to a caller that a token was well-formed.
      await reply.code(401).send({ error: 'unauthorized' });
    }
  };
}
