import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installRunLifecycleListeners } from '../../src/orchestrator/run-lifecycle-listeners.js';
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
});

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor: timeout');
}
