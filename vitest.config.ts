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
    // lock-contending test past Vitest's default — a flake, not a hang.
    // A 30s default matches the repo's explicit long git-test budget
    // (which would still fail in isolation).
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
    },
  },
});
