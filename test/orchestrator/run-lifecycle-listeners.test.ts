import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  drainPendingTerminalPersists,
  installRunLifecycleListeners,
  pendingTerminalPersistCount,
} from '../../src/orchestrator/run-lifecycle-listeners.js';
import { RunStateStore } from '../../src/orchestrator/run-state.js';
import { ToolDispatcher } from '../../src/orchestrator/tool-dispatcher.js';

describe('installRunLifecycleListeners', () => {
  let crewHome: string;
  let repoRoot: string;
  let store: RunStateStore;
  let dispatcher: ToolDispatcher;

  beforeEach(() => {
    crewHome = mkdtempSync(join(tmpdir(), 'crew-lifecycle-home-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'crew-lifecycle-repo-'));
    store = new RunStateStore({ crewHome, repoRoot });
    dispatcher = new ToolDispatcher();
  });

  afterEach(() => {
    rmSync(crewHome, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('settles synchronously so duplicate terminal events do not both write state', async () => {
    await store.create({
      runId: 'r-1',
      agentId: 'mock',
      worktreePath: '/wt',
      initialPrompt: 'go',
    });

    const terminal = installRunLifecycleListeners({
      dispatcher,
      runStateStore: store,
      runId: 'r-1',
      agentName: 'mock',
      toolCallId: 'tc-1',
    });
    const emitter = dispatcher as unknown as {
      emitter: {
        emit(event: string, info: Record<string, unknown>): boolean;
      };
    };

    emitter.emitter.emit('run:complete', {
      toolCallId: 'tc-1',
      toolName: 'run_agent',
      result: {
        status: 'success',
        output: 'first terminal',
        filesModified: ['a.ts'],
        metadata: {},
      },
      runId: 'r-1',
    });
    emitter.emitter.emit('run:failed', {
      toolCallId: 'tc-1',
      toolName: 'run_agent',
      error: 'late terminal',
      runId: 'r-1',
    });

    await expect(terminal).resolves.toMatchObject({ kind: 'complete' });
    await waitFor(() => store.read('r-1')?.status === 'success');

    const state = store.read('r-1');
    expect(state?.status).toBe('success');
    expect(state?.prompts[0].summary).toBe('first terminal');
    expect(state?.filesChanged).toEqual(['a.ts']);
    expect(state?.lastError).toBeUndefined();
  });

  it('persists typed failure from failed task results', async () => {
    await store.create({
      runId: 'r-failure',
      agentId: 'mock',
      worktreePath: '/wt',
      initialPrompt: 'go',
    });

    const terminal = installRunLifecycleListeners({
      dispatcher,
      runStateStore: store,
      runId: 'r-failure',
      agentName: 'mock',
      toolCallId: 'tc-failure',
    });
    const emitter = dispatcher as unknown as {
      emitter: {
        emit(event: string, info: Record<string, unknown>): boolean;
      };
    };

    emitter.emitter.emit('run:failed', {
      toolCallId: 'tc-failure',
      toolName: 'run_agent',
      error: 'rate limited',
      result: {
        status: 'error',
        output: 'rate limited',
        filesModified: ['a.ts'],
        failure: {
          kind: 'rate_limited',
          confidence: 'high',
          providerCode: '429',
          recommendation: 'backoff',
        },
        metadata: {},
      },
      runId: 'r-failure',
    });

    await expect(terminal).resolves.toMatchObject({ kind: 'failed' });
    await waitFor(() => store.read('r-failure')?.status === 'error');

    expect(store.read('r-failure')).toMatchObject({
      status: 'error',
      filesChanged: ['a.ts'],
      lastError: 'rate limited',
      failure: {
        kind: 'rate_limited',
        recommendation: 'backoff',
      },
    });
  });

  it('persists typed failure from partial task results without setting lastError', async () => {
    await store.create({
      runId: 'r-partial',
      agentId: 'mock',
      worktreePath: '/wt',
      initialPrompt: 'go',
    });

    const terminal = installRunLifecycleListeners({
      dispatcher,
      runStateStore: store,
      runId: 'r-partial',
      agentName: 'mock',
      toolCallId: 'tc-partial',
    });
    const emitter = dispatcher as unknown as {
      emitter: {
        emit(event: string, info: Record<string, unknown>): boolean;
      };
    };

    emitter.emitter.emit('run:complete', {
      toolCallId: 'tc-partial',
      toolName: 'run_agent',
      result: {
        status: 'partial',
        output: 'final worker summary',
        filesModified: [],
        failure: {
          kind: 'unknown',
          confidence: 'low',
          providerCode: 'missing_result_envelope',
          rawSignal: 'missing_result_envelope',
        },
        metadata: {},
      },
      runId: 'r-partial',
    });

    await expect(terminal).resolves.toMatchObject({ kind: 'complete' });
    await waitFor(() => store.read('r-partial')?.status === 'partial');

    expect(store.read('r-partial')).toMatchObject({
      status: 'partial',
      prompts: [expect.objectContaining({ summary: 'final worker summary' })],
      failure: {
        kind: 'unknown',
        providerCode: 'missing_result_envelope',
        rawSignal: 'missing_result_envelope',
      },
    });
    expect(store.read('r-partial')?.lastError).toBeUndefined();
  });

  it('tracks detached terminal persist promises until they settle', async () => {
    let resolvePersist!: () => void;
    const persistPromise = new Promise<void>((resolve) => {
      resolvePersist = resolve;
    });
    const slowStore = {
      read: vi.fn(() => undefined),
      markTerminal: vi.fn(() => persistPromise),
    } as unknown as RunStateStore;

    const terminal = installRunLifecycleListeners({
      dispatcher,
      runStateStore: slowStore,
      runId: 'r-slow',
      agentName: 'mock',
      toolCallId: 'tc-slow',
    });
    const emitter = dispatcher as unknown as {
      emitter: {
        emit(event: string, info: Record<string, unknown>): boolean;
      };
    };

    emitter.emitter.emit('run:cancelled', {
      toolCallId: 'tc-slow',
      toolName: 'run_agent',
      reason: 'shutdown',
      runId: 'r-slow',
    });

    await expect(terminal).resolves.toMatchObject({ kind: 'cancelled' });
    expect(pendingTerminalPersistCount()).toBe(1);

    const drain = drainPendingTerminalPersists({ maxWaitMs: 200 });
    await Promise.resolve();
    expect(pendingTerminalPersistCount()).toBe(1);

    resolvePersist();
    await expect(drain).resolves.toBe(true);
    expect(pendingTerminalPersistCount()).toBe(0);
    expect(slowStore.markTerminal).toHaveBeenCalledWith('r-slow', {
      status: 'cancelled',
      summary: 'shutdown',
      filesChanged: [],
    });
  });

  it('charges elapsed wall time when the user cancels a pending goal turn', async () => {
    const elapsedMs = 6_500;
    await store.create({
      runId: 'r-user-goal-cancel',
      agentId: 'claude-code',
      worktreePath: '/wt',
      initialPrompt: 'go',
      goal: {
        policy: 'start',
        request: {
          validationCommand: 'npm test',
          repeatSafe: true,
          maxTurns: 4,
          maxWallClockMs: 30_000,
        },
        authoritative: false,
        turnsUsed: 0,
        wallClockMsUsed: 0,
      },
      goalBudget: {
        maxTurns: 4,
        maxWallClockMs: 30_000,
        turnsUsed: 0,
        wallClockMsUsed: 0,
      },
    });

    const terminal = installRunLifecycleListeners({
      dispatcher,
      runStateStore: store,
      runId: 'r-user-goal-cancel',
      agentName: 'claude-code',
      toolCallId: 'tc-user-goal-cancel',
    });
    const emitter = dispatcher as unknown as {
      emitter: {
        emit(event: string, info: Record<string, unknown>): boolean;
      };
    };
    emitter.emitter.emit('run:cancelled', {
      toolCallId: 'tc-user-goal-cancel',
      toolName: 'run_agent',
      reason: 'cancel_run requested',
      abortOrigin: 'user',
      elapsedMs,
      runId: 'r-user-goal-cancel',
    });

    await expect(terminal).resolves.toMatchObject({
      kind: 'cancelled',
      abortOrigin: 'user',
      elapsedMs,
    });
    await waitFor(() => store.read('r-user-goal-cancel')?.status === 'cancelled');
    expect(store.read('r-user-goal-cancel')).toMatchObject({
      status: 'cancelled',
      goalBudget: {
        turnsUsed: 0,
        wallClockMsUsed: elapsedMs,
      },
      prompts: [{
        goal: {
          outcome: 'cancelled',
          authoritative: true,
          reason: 'cancel_run requested',
          turnsUsed: 0,
          wallClockMsUsed: elapsedMs,
        },
      }],
    });
  });

  it.each([
    ['streaming_watchdog', 'stall watchdog: no output', 4_000],
    ['buffered_watchdog', 'absolute cap: buffering adapter', 7_500],
  ] as const)(
    'persists %s aborts as authoritative watchdog_timeout goal outcomes',
    async (abortOrigin, reason, elapsedMs) => {
      const runId = `r-${abortOrigin}`;
      const toolCallId = `tc-${abortOrigin}`;
      const request = {
        validationCommand: 'npm test',
        repeatSafe: true as const,
        maxTurns: 4,
        maxWallClockMs: 30_000,
      };
      await store.create({
        runId,
        agentId: 'claude-code',
        worktreePath: '/wt',
        initialPrompt: 'go',
        goal: {
          policy: 'start',
          request,
          authoritative: false,
          turnsUsed: 0,
          wallClockMsUsed: 0,
        },
        goalBudget: {
          maxTurns: 4,
          maxWallClockMs: 30_000,
          turnsUsed: 0,
          wallClockMsUsed: 0,
        },
      });

      const terminal = installRunLifecycleListeners({
        dispatcher,
        runStateStore: store,
        runId,
        agentName: 'claude-code',
        toolCallId,
      });
      const emitter = dispatcher as unknown as {
        emitter: {
          emit(event: string, info: Record<string, unknown>): boolean;
        };
      };
      emitter.emitter.emit('run:cancelled', {
        toolCallId,
        toolName: 'run_agent',
        reason,
        abortOrigin,
        elapsedMs,
        runId,
      });

      await expect(terminal).resolves.toMatchObject({
        kind: 'cancelled',
        abortOrigin,
        elapsedMs,
      });
      await waitFor(() => store.read(runId)?.status === 'cancelled');

      expect(store.read(runId)).toMatchObject({
        status: 'cancelled',
        goalBudget: {
          turnsUsed: 0,
          wallClockMsUsed: elapsedMs,
        },
        prompts: [{
          goal: {
            outcome: 'watchdog_timeout',
            authoritative: true,
            reason,
            turnsUsed: 0,
            wallClockMsUsed: elapsedMs,
          },
        }],
      });
    },
  );

  it.each([
    { outcome: 'unsupported' as const, policy: 'start' as const },
    { outcome: 'not_requested' as const, policy: 'not_requested' as const },
  ])(
    'does not replace settled $outcome with watchdog_timeout',
    async ({ outcome, policy }) => {
      const runId = `r-watchdog-settled-${outcome}`;
      const toolCallId = `tc-watchdog-settled-${outcome}`;
      await store.create({
        runId,
        agentId: outcome === 'unsupported' ? 'codex' : 'claude-code',
        worktreePath: '/wt',
        initialPrompt: 'go',
        goal: {
          policy,
          outcome,
          authoritative: true,
          reason: `planner settled ${outcome}`,
          turnsUsed: 0,
          wallClockMsUsed: 0,
        },
        goalBudget: {
          maxTurns: 4,
          maxWallClockMs: 30_000,
          turnsUsed: 1,
          wallClockMsUsed: 2_000,
        },
      });
      const markTerminal = vi.spyOn(store, 'markTerminal');

      const terminal = installRunLifecycleListeners({
        dispatcher,
        runStateStore: store,
        runId,
        agentName: 'claude-code',
        toolCallId,
      });
      const emitter = dispatcher as unknown as {
        emitter: {
          emit(event: string, info: Record<string, unknown>): boolean;
        };
      };
      emitter.emitter.emit('run:cancelled', {
        toolCallId,
        toolName: 'run_agent',
        reason: 'stall watchdog: no output',
        abortOrigin: 'streaming_watchdog',
        elapsedMs: 9_000,
        runId,
      });

      await expect(terminal).resolves.toMatchObject({ kind: 'cancelled' });
      await waitFor(() => store.read(runId)?.status === 'cancelled');
      expect(markTerminal).toHaveBeenCalledWith(runId, {
        status: 'cancelled',
        summary: 'stall watchdog: no output',
        filesChanged: [],
      });
      expect(store.read(runId)).toMatchObject({
        goalBudget: {
          turnsUsed: 1,
          wallClockMsUsed: 2_000,
        },
        prompts: [{
          goal: {
            policy,
            outcome,
            authoritative: true,
            reason: `planner settled ${outcome}`,
            turnsUsed: 0,
            wallClockMsUsed: 0,
          },
        }],
      });
    },
  );

  it('does not let an adapter completion overwrite a settled goal', async () => {
    await store.create({
      runId: 'r-adapter-settled-goal',
      agentId: 'codex',
      worktreePath: '/wt',
      initialPrompt: 'go',
      goal: {
        policy: 'start',
        outcome: 'unsupported',
        authoritative: true,
        reason: 'Codex goals are unsupported',
        turnsUsed: 0,
        wallClockMsUsed: 0,
      },
      goalBudget: {
        maxTurns: 4,
        maxWallClockMs: 30_000,
        turnsUsed: 0,
        wallClockMsUsed: 0,
      },
    });

    const terminal = installRunLifecycleListeners({
      dispatcher,
      runStateStore: store,
      runId: 'r-adapter-settled-goal',
      agentName: 'codex',
      toolCallId: 'tc-adapter-settled-goal',
    });
    const emitter = dispatcher as unknown as {
      emitter: {
        emit(event: string, info: Record<string, unknown>): boolean;
      };
    };
    emitter.emitter.emit('run:complete', {
      toolCallId: 'tc-adapter-settled-goal',
      toolName: 'run_agent',
      result: {
        status: 'success',
        output: 'adapter completed',
        filesModified: [],
        metadata: {},
        goal: {
          outcome: 'achieved',
          authoritative: true,
          reason: 'late adapter result',
          turnsUsed: 3,
          wallClockMsUsed: 12_000,
        },
      },
      runId: 'r-adapter-settled-goal',
    });

    await expect(terminal).resolves.toMatchObject({ kind: 'complete' });
    await waitFor(() => store.read('r-adapter-settled-goal')?.status === 'success');
    expect(store.read('r-adapter-settled-goal')).toMatchObject({
      goalBudget: {
        turnsUsed: 0,
        wallClockMsUsed: 0,
      },
      prompts: [{
        goal: {
          policy: 'start',
          outcome: 'unsupported',
          authoritative: true,
          reason: 'Codex goals are unsupported',
          turnsUsed: 0,
          wallClockMsUsed: 0,
        },
      }],
    });
  });

  it('bounds terminal persist draining when a write does not settle', async () => {
    let resolvePersist!: () => void;
    const persistPromise = new Promise<void>((resolve) => {
      resolvePersist = resolve;
    });
    const slowStore = {
      markTerminal: vi.fn(() => persistPromise),
    } as unknown as RunStateStore;
    const terminal = installRunLifecycleListeners({
      dispatcher,
      runStateStore: slowStore,
      runId: 'r-stuck',
      agentName: 'mock',
      toolCallId: 'tc-stuck',
    });
    const emitter = dispatcher as unknown as {
      emitter: {
        emit(event: string, info: Record<string, unknown>): boolean;
      };
    };

    emitter.emitter.emit('run:failed', {
      toolCallId: 'tc-stuck',
      toolName: 'run_agent',
      error: 'boom',
      runId: 'r-stuck',
    });
    await expect(terminal).resolves.toMatchObject({ kind: 'failed' });
    expect(pendingTerminalPersistCount()).toBe(1);

    await expect(drainPendingTerminalPersists({ maxWaitMs: 10 })).resolves.toBe(false);
    resolvePersist();
    await expect(drainPendingTerminalPersists()).resolves.toBe(true);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor: timeout');
}
