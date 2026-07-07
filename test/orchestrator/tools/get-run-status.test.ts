import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunStateStore } from '../../../src/orchestrator/run-state.js';
import { ToolDispatcher } from '../../../src/orchestrator/tool-dispatcher.js';
import { getRunStatusToolHandler } from '../../../src/orchestrator/tools/get-run-status.js';
import { WorktreeManager } from '../../../src/git/worktree.js';
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

  it('includes newest-first run commits capped at 20 for terminal write runs', async () => {
    execSync('git init -q', { cwd: repoRoot });
    execSync('git config user.email test@crew.local', { cwd: repoRoot });
    execSync('git config user.name test', { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'README.md'), 'init\n', 'utf-8');
    execSync('git add README.md', { cwd: repoRoot });
    execSync('git commit -q -m init', { cwd: repoRoot });

    const manager = new WorktreeManager({ projectRoot: repoRoot, crewHome });
    const worktreePath = await manager.createRunWorktree('r-commits');
    await store.create({
      runId: 'r-commits',
      agentId: 'codex',
      worktreePath,
      initialPrompt: 'go',
    });
    for (let index = 1; index <= 21; index += 1) {
      writeFileSync(join(worktreePath, `file-${index}.txt`), `${index}\n`, 'utf-8');
      execSync(`git add file-${index}.txt`, { cwd: worktreePath });
      execSync(`git commit -q -m "chore: change ${index}"`, { cwd: worktreePath });
    }
    await store.markTerminal('r-commits', {
      status: 'success',
      summary: 'done',
      filesChanged: ['file-21.txt'],
    });

    const response = await getRunStatusToolHandler(
      { run_id: 'r-commits' },
      { dispatcher: new ToolDispatcher(), runStateStore: store },
    );

    expect(response.structuredContent).toMatchObject({
      status: 'success',
      commit_count: 21,
    });
    const commits = response.structuredContent?.commits as Array<{ sha: string; subject: string }>;
    expect(commits).toHaveLength(20);
    expect(commits[0].subject).toBe('chore: change 21');
    expect(commits[19].subject).toBe('chore: change 2');
    expect(commits[0].sha).toMatch(/^[0-9a-f]{40}$/);
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

  it('surfaces peer message counts and worker_ready', async () => {
    await store.create({
      runId: 'r-peer-ready',
      agentId: 'codex',
      worktreePath: '/wt/r-peer-ready',
      initialPrompt: 'go',
      initialPeerMessagesInput: [
        { kind: 'note', body: 'one', from_label: 'reviewer-a' },
        { kind: 'status', body: 'two', from_label: 'reviewer-b' },
      ],
    });
    await store.setWorkerReady('r-peer-ready', {
      status: 'ready',
      markerObservedAt: '2026-07-06T00:00:01.000Z',
      markerServerPid: 12345,
      markerServerInstance: 'worker-server',
    });
    await store.markTerminal('r-peer-ready', {
      status: 'success',
      summary: 'done',
      filesChanged: [],
    });

    const response = await getRunStatusToolHandler(
      { run_id: 'r-peer-ready' },
      { dispatcher: new ToolDispatcher(), runStateStore: store },
    );

    expect(response.structuredContent).toMatchObject({
      status: 'success',
      worker_ready: {
        status: 'ready',
        markerServerPid: 12345,
        markerServerInstance: 'worker-server',
      },
      prompts: [
        {
          turn: 1,
          peer_messages_count: 2,
        },
      ],
    });
  });

  it('emits peer_messages_count as 0 when a prompt has no peer messages', async () => {
    await store.create({
      runId: 'r-no-peer',
      agentId: 'codex',
      worktreePath: '/wt/r-no-peer',
      initialPrompt: 'go',
    });
    await store.markTerminal('r-no-peer', {
      status: 'success',
      summary: 'done',
      filesChanged: [],
    });

    const response = await getRunStatusToolHandler(
      { run_id: 'r-no-peer' },
      { dispatcher: new ToolDispatcher(), runStateStore: store },
    );

    expect(response.structuredContent).toMatchObject({
      prompts: [
        {
          turn: 1,
          peer_messages_count: 0,
        },
      ],
    });
  });
});
