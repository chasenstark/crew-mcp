import { defineConfig } from 'vitest/config';

const serveRealGitIntegrationTests = [
  'test/cli/commands/serve.test.ts',
  'test/cli/commands/serve.subprocess.test.ts',
];

const parallelRealGitIntegrationTests = [
  'test/git/worktree-host-repo-clean.test.ts',
  'test/orchestrator/run-gc.test.ts',
  'test/orchestrator/dispatch-run-agent-internal.test.ts',
  'test/orchestrator/run-lifecycle-listeners.test.ts',
  'test/orchestrator/tools/run-agent.test.ts',
  'test/orchestrator/tools/ephemeral-review*.test.ts',
  'test/orchestrator/tools/run-panel.test.ts',
];

const realGitIntegrationTests = [
  ...serveRealGitIntegrationTests,
  ...parallelRealGitIntegrationTests,
];

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./test/setup-env.ts'],
    // Keep 30s as the per-file integration budget: real process teardown,
    // state-lock recovery, and git worktree operations can be legitimately
    // slow on loaded machines. The real-git files below run in a separate
    // single-worker project so this timeout is no longer compensating for
    // full-suite parallel Git contention.
    testTimeout: 30000,
    hookTimeout: 30000,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/**/*.test.{ts,tsx}'],
          exclude: realGitIntegrationTests,
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'real-git-parallel',
          include: parallelRealGitIntegrationTests,
          maxWorkers: 3,
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: 'real-git-serve',
          include: serveRealGitIntegrationTests,
          maxWorkers: 1,
          sequence: { groupOrder: 2 },
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
    },
  },
});
