import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'server',
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Each suite builds its own app against a temp dir; keep them isolated.
    pool: 'forks',
  },
});
