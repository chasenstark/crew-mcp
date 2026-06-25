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

  it('tracks detached terminal persist promises until they settle', async () => {
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
