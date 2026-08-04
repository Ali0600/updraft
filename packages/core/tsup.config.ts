import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  // Declarations come from `tsc` (see the build script): tsup's dts step uses
  // rollup-plugin-dts, which is pinned against TypeScript 5 and crashes on 7.
  dts: false,
  clean: true,
  sourcemap: true,
  target: 'node20',
});
