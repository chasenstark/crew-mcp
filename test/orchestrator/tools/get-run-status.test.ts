import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunStateStore } from '../../../src/orchestrator/run-state.js';
import { ToolDispatcher } from '../../../src/orchestrator/tool-dispatcher.js';
import { getRunStatusToolHandler } from '../../../src/orchestrator/tools/get-run-status.js';
import {
  installRunLifecycleListeners,
  pendingTerminalPersistCount,
} from '../../../src/orchestrator/run-lifecycle-listeners.js';

describe('getRunStatusToolHandler', () => {
  let crewHome: string;
  let repoRoot: string;
  let store: RunStateStore;
  let priorNotifications: string | undefined;

  beforeEach(() => {
    priorNotifications = process.env.CREW_OS_NOTIFICATIONS;
    process.env.CREW_OS_NOTIFICATIONS = 'off';
    crewHome = mkdtempSync(join(tmpdir(), 'crew-get-status-home-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'crew-get-status-repo-'));
    store = new RunStateStore({ crewHome, repoRoot });
  });

  afterEach(() => {
    if (priorNotifications === undefined) delete process.env.CREW_OS_NOTIFICATIONS;
    else process.env.CREW_OS_NOTIFICATIONS = priorNotifications;
    rmSync(crewHome, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('surfaces typed failure in payload and markdown', async () => {
    await store.create({
      runId: 'r-failure',
      agentId: 'codex',
      worktreePath: '/wt/r-failure',
      initialPrompt: 'go',
    });
    await store.markTerminal('r-failure', {
      status: 'error',
      summary: 'rate limited',
      filesChanged: [],
      lastError: 'rate limited',
      failure: {
        kind: 'rate_limited',
        confidence: 'high',
        providerCode: '429',
        recommendation: 'backoff',
      },
    });

    const response = await getRunStatusToolHandler(
      { run_id: 'r-failure' },
      { dispatcher: new ToolDispatcher(), runStateStore: store },
    );

    expect(response.structuredContent).toMatchObject({
      status: 'error',
      lastError: 'rate limited',
      failure: {
        kind: 'rate_limited',
        confidence: 'high',
        recommendation: 'backoff',
      },
    });
    expect(response.content[0]?.text).toContain('Failure: `rate_limited` (backoff)');
  });

  it('terminal-only long-poll returns immediately during the terminal persist gap', async () => {
    await store.create({
      runId: 'r-gap',
      agentId: 'codex',
      worktreePath: '/wt/r-gap',
      initialPrompt: 'go',
    });
    const dispatcher = new ToolDispatcher();
    const releasePersist = Promise.withResolvers<void>();
    const originalMarkTerminal = store.markTerminal.bind(store);
    vi.spyOn(store, 'markTerminal').mockImplementation(async (...args) => {
      await releasePersist.promise;
      return originalMarkTerminal(...args);
    });
    void installRunLifecycleListeners({
      dispatcher,
      runStateStore: store,
      runId: 'r-gap',
      agentName: 'codex',
      toolCallId: 'tool-gap',
    });
    const emitter = dispatcher as unknown as {
      emitter: { emit(event: string, info: Record<string, unknown>): boolean };
    };
    emitter.emitter.emit('run:complete', {
      toolCallId: 'tool-gap',
      toolName: 'run_agent',
      runId: 'r-gap',
      result: { output: 'done', filesModified: [], status: 'success', metadata: {} },
    });
    await expect.poll(() => pendingTerminalPersistCount()).toBe(1);

    const response = await Promise.race([
      getRunStatusToolHandler(
        { run_id: 'r-gap', wait_for_change_ms: 10_000, wait_for_terminal_only: true },
        { dispatcher, runStateStore: store },
      ),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('poll slept')), 200)),
    ]);

    expect(response.structuredContent).toMatchObject({ status: 'running' });
    releasePersist.resolve();
  });
});
