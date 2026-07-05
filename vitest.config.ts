import { defineConfig } from 'vitest/config';

const realGitIntegrationTests = [
  'test/git/**/*.test.{ts,tsx}',
  'test/cli/commands/serve.test.ts',
  'test/cli/commands/serve.subprocess.test.ts',
  'test/orchestrator/run-gc.test.ts',
  'test/orchestrator/dispatch-run-agent-internal.test.ts',
  'test/orchestrator/run-lifecycle-listeners.test.ts',
  'test/orchestrator/tools/run-agent.test.ts',
  'test/orchestrator/tools/*merge*.test.ts',
  'test/orchestrator/tools/*discard*.test.ts',
  'test/orchestrator/tools/ephemeral-review*.test.ts',
  'test/orchestrator/tools/run-panel.test.ts',
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
          name: 'real-git',
          include: realGitIntegrationTests,
          maxWorkers: 1,
          sequence: { groupOrder: 1 },
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
    },
  },
});
