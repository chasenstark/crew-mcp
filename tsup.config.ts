import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/cli/wait.ts',
    'src/cli/pr-watch.ts',
    'src/cli/pr-watch-wait.ts',
  ],
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
});
