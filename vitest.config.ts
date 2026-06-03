import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/setup-env.ts'],
    // The hardening work (per-write state-file locking, worktree/git ops,
    // process-group teardown) adds real latency to terminal-state and
    // cleanup paths. Tests pass well within budget in isolation, but under
    // full-suite parallel load the lock/CPU contention can push a
    // lock-contending test past Vitest's 5s default — a flake, not a hang.
    // A 15s default removes the flake without masking a real deadlock
    // (which would still fail in isolation).
    testTimeout: 15000,
    hookTimeout: 15000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
    },
  },
});
