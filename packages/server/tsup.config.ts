import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  target: 'node20',
  // better-sqlite3 is a native addon and must stay external.
  external: ['better-sqlite3'],
});
