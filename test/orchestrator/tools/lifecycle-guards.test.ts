import { describe, expect, it } from 'vitest';

import type { RunStateStore, RunStateV1 } from '../../../src/orchestrator/run-state.js';
import { assertNoBusyWorktreeBlockers } from '../../../src/orchestrator/tools/lifecycle-guards.js';
import type { ToolDispatcher } from '../../../src/orchestrator/tool-dispatcher.js';

function state(runId: string, status: RunStateV1['status'], worktreePath: string): RunStateV1 {
  return {
    schemaVersion: 1,
    runId,
    agentId: 'mock',
    status,
    startedAt: new Date().toISOString(),
    worktreePath,
    repoRoot: '/repo',
    prompts: [],
    filesChanged: [],
  };
}

function deps(states: Record<string, RunStateV1>, inFlightRunIds: string[]) {
  return {
    runStateStore: {
      repoRoot: '/repo',
      read: (runId: string) => states[runId],
    } as unknown as RunStateStore,
    dispatcher: {
      listInFlight: () => inFlightRunIds.map((runId) => ({
        toolCallId: `tool-${runId}`,
        toolName: 'run_agent',
        runId,
      })),
    } as unknown as Pick<ToolDispatcher, 'listInFlight'>,
  };
}

describe('lifecycle busy-worktree guards', () => {
  it('refuses when a live run is inside the target worktree', () => {
    const target = state('target', 'success', '/tmp/target/worktree');
    const blocker = state('reviewer', 'running', '/tmp/target/worktree/subdir');
    const d = deps({ target, reviewer: blocker }, ['reviewer']);

    expect(() => assertNoBusyWorktreeBlockers({
      targetRun: target,
      ...d,
    })).toThrow(/busy_worktree: .*reviewer:/);
  });

  it('does not block on terminal runs in the target worktree', () => {
    const target = state('target', 'success', '/tmp/target/worktree');
    const done = state('reviewer', 'success', '/tmp/target/worktree');
    const d = deps({ target, reviewer: done }, ['reviewer']);

    expect(() => assertNoBusyWorktreeBlockers({
      targetRun: target,
      ...d,
    })).not.toThrow();
  });

  it('merge guard refuses host-checkout-bound runs unless forced', () => {
    const target = state('target', 'success', '/tmp/target/worktree');
    const hostReader = state('host-reader', 'running', '/repo/packages/app');
    const d = deps({ target, 'host-reader': hostReader }, ['host-reader']);

    expect(() => assertNoBusyWorktreeBlockers({
      targetRun: target,
      includeHostCheckout: true,
      ...d,
    })).toThrow(/busy_worktree: .*host-reader:/);

    expect(() => assertNoBusyWorktreeBlockers({
      targetRun: target,
      includeHostCheckout: true,
      force: true,
      ...d,
    })).not.toThrow();
  });
});
