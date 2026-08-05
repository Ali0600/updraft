import { defineConfig } from 'vitest/config';

export default defineConfig({
  // @ota/core deliberately resolves through its package exports (dist), the
  // same path production uses — an alias to src would let tests pass against
  // code the shipped bundle does not contain. The root `test` and `typecheck`
  // scripts rebuild core first so dist is never stale.
  test: {
    name: 'server',
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Each suite builds its own app against a temp dir; keep them isolated.
    pool: 'forks',
  },
});
