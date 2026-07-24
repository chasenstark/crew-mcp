import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/canary/cli.ts'],
  outDir: 'dist/canary',
  format: ['esm'],
  splitting: false,
  dts: false,
  clean: false,
  sourcemap: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
});
