import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const childProcessMocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  childProcessMocks.execFileSync.mockImplementation(actual.execFileSync as never);
  return { ...actual, execFileSync: childProcessMocks.execFileSync };
});

import { RunStateStore } from '../../../src/orchestrator/run-state.js';
import { ToolDispatcher } from '../../../src/orchestrator/tool-dispatcher.js';
import { getRunStatusToolHandler } from '../../../src/orchestrator/tools/get-run-status.js';
import { WorktreeManager } from '../../../src/git/worktree.js';
import {
  appendMessage,
  setCaptainInboxFsForTest,
} from '../../../src/orchestrator/captain-inbox/store.js';
import {
  TERMINAL_INBOX_MAX_BYTES,
  TERMINAL_INBOX_MAX_MESSAGES,
} from '../../../src/orchestrator/tools/get-run-status.js';
import { UNTRUSTED_WORKER_CONTENT_LABEL } from '../../../src/orchestrator/untrusted-provenance.js';
import {
  installRunLifecycleListeners,
  pendingTerminalPersistCount,
} from '../../../src/orchestrator/run-lifecycle-listeners.js';

describe('getRunStatusToolHandler', () => {
  let crewHome: string;
  let repoRoot: string;
  let store: RunStateStore;
  let priorNotifications: string | undefined;
  let resetCaptainInboxFs: (() => void) | undefined;

  beforeEach(() => {
    childProcessMocks.execFileSync.mockClear();
    priorNotifications = process.env.CREW_OS_NOTIFICATIONS;
    process.env.CREW_OS_NOTIFICATIONS = 'off';
    crewHome = mkdtempSync(join(tmpdir(), 'crew-get-status-home-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'crew-get-status-repo-'));
    store = new RunStateStore({ crewHome, repoRoot });
  });

  afterEach(() => {
    resetCaptainInboxFs?.();
    resetCaptainInboxFs = undefined;
    if (priorNotifications === undefined) delete process.env.CREW_OS_NOTIFICATIONS;
    else process.env.CREW_OS_NOTIFICATIONS = priorNotifications;
    rmSync(crewHome, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('rejects terminal-only waits without an explicit user_requested_wait claim', async () => {
    await store.create({
      runId: 'r-wait-refused',
      agentId: 'codex',
      worktreePath: '/wt/r-wait-refused',
      initialPrompt: 'go',
    });

    const response = await getRunStatusToolHandler({
      run_id: 'r-wait-refused',
      wait_for_terminal_only: true,
    }, { dispatcher: new ToolDispatcher(), runStateStore: store });

    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).toMatch(/^get_run_status\.wait_requires_user_request:/);
    expect(response.content[0]?.text).toContain('crew-wait watcher');
    expect(response.content[0]?.text).toContain('user_requested_wait:true');
  });

  it('allows an explicitly requested criteria-linked wait and warns toward crew-wait', async () => {
    await store.create({
      runId: 'r-linked-wait',
      agentId: 'codex',
      worktreePath: '/wt/r-linked-wait',
      initialPrompt: 'go',
      criteriaSetId: 'criteria-1',
      criteriaEpoch: 0,
    });

    const response = await getRunStatusToolHandler({
      run_id: 'r-linked-wait',
      wait_for_terminal_only: true,
      user_requested_wait: true,
    }, { dispatcher: new ToolDispatcher(), runStateStore: store });

    expect(response.isError).not.toBe(true);
    expect(response.structuredContent?.warnings).toEqual([
      expect.stringMatching(/^get_run_status\.criteria_linked_wait:.*crew-wait watcher/),
    ]);
  });

  it('does not warn for linked snapshots or waits on non-linked runs', async () => {
    await store.create({
      runId: 'r-linked-snapshot',
      agentId: 'codex',
      worktreePath: '/wt/r-linked-snapshot',
      initialPrompt: 'go',
      criteriaSetId: 'criteria-1',
      criteriaEpoch: 0,
    });
    await store.create({
      runId: 'r-unlinked-wait',
      agentId: 'codex',
      worktreePath: '/wt/r-unlinked-wait',
      initialPrompt: 'go',
    });

    const snapshot = await getRunStatusToolHandler({
      run_id: 'r-linked-snapshot',
    }, { dispatcher: new ToolDispatcher(), runStateStore: store });
    const wait = await getRunStatusToolHandler({
      run_id: 'r-unlinked-wait',
      wait_for_terminal_only: true,
      user_requested_wait: true,
    }, { dispatcher: new ToolDispatcher(), runStateStore: store });

    expect(snapshot.structuredContent?.warnings).toBeUndefined();
    expect(wait.structuredContent?.warnings).toBeUndefined();
  });

  it('re-arms a 10-minute watcher from a running iterate implementer snapshot', async () => {
    await store.create({
      runId: 'r-iterate-check-in',
      agentId: 'codex',
      worktreePath: '/wt/r-iterate-check-in',
      initialPrompt: 'go',
      criteriaSetId: 'criteria-1',
      criteriaEpoch: 0,
      runMode: 'write',
    });

    const response = await getRunStatusToolHandler(
      { run_id: 'r-iterate-check-in' },
      {
        dispatcher: new ToolDispatcher(),
        runStateStore: store,
        crewHome,
        projectRoot: repoRoot,
        getClientKind: () => 'codex',
        getCrewWaitCommand: () => 'crew-wait --codex-queue-thread thread-id',
      },
    );

    expect(response.structuredContent?.required_next_action).toMatchObject({
      type: 'spawn_watcher',
      check_in_interval_ms: 600_000,
      check_in_action_id: expect.any(String),
      run_id: 'r-iterate-check-in',
      run_generation: 1,
    });
    expect(
      (response.structuredContent?.required_next_action as { command?: string }).command,
    ).toContain(' --check-in-ms 600000 --check-in-action-id ');
  });

  it('surfaces the latest model selection in snapshots, timeouts, and terminal turns', async () => {
    await store.create({
      runId: 'r-model-status',
      agentId: 'claude-code',
      worktreePath: '/wt/r-model-status',
      initialPrompt: 'go',
      modelSelection: {
        source: 'per_call',
        requestedModel: 'fable',
        modelArgument: 'fable',
        displayName: 'Fable',
        validation: 'catalog',
      },
    });

    const snapshot = await getRunStatusToolHandler(
      { run_id: 'r-model-status' },
      { dispatcher: new ToolDispatcher(), runStateStore: store },
    );
    expect(snapshot.structuredContent?.model_selection).toMatchObject({
      source: 'per_call',
      requested_model: 'fable',
      model_argument: 'fable',
      display_name: 'Fable',
    });

    const timeout = await getRunStatusToolHandler({
      run_id: 'r-model-status',
      wait_for_change_ms: 1,
      wait_for_terminal_only: true,
      user_requested_wait: true,
    }, { dispatcher: new ToolDispatcher(), runStateStore: store });
    expect(timeout.structuredContent).toMatchObject({
      status: 'running',
      timed_out: true,
      model_selection: { requested_model: 'fable', model_argument: 'fable' },
    });

    await store.markTerminal('r-model-status', {
      status: 'success',
      summary: 'done',
      filesChanged: [],
      observedModel: 'claude-fable-5',
    });
    const terminal = await getRunStatusToolHandler(
      { run_id: 'r-model-status' },
      { dispatcher: new ToolDispatcher(), runStateStore: store },
    );
    expect(terminal.structuredContent).toMatchObject({
      model_selection: { observed_model: 'claude-fable-5' },
      prompts: [{ model_selection: { observed_model: 'claude-fable-5' } }],
    });
  });

  it('surfaces in-flight, terminal, per-turn, and cumulative goal state', async () => {
    const request = {
      validationCommand: 'npm test',
      repeatSafe: true as const,
      maxTurns: 4,
      maxWallClockMs: 40_000,
    };
    await store.create({
      runId: 'r-goal-status',
      agentId: 'claude-code',
      worktreePath: '/wt/r-goal-status',
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
        maxWallClockMs: 40_000,
        turnsUsed: 0,
        wallClockMsUsed: 0,
      },
    });
    const running = await getRunStatusToolHandler(
      { run_id: 'r-goal-status' },
      { dispatcher: new ToolDispatcher(), runStateStore: store },
    );
    expect(running.structuredContent?.goal).toMatchObject({
      policy: 'start',
      requested: { validation_command: 'npm test' },
      authoritative: false,
    });

    await store.markTerminal('r-goal-status', {
      status: 'success',
      summary: 'done',
      filesChanged: [],
      goal: {
        outcome: 'achieved',
        authoritative: true,
        turnsUsed: 2,
        wallClockMsUsed: 12_000,
      },
    });
    const terminal = await getRunStatusToolHandler(
      { run_id: 'r-goal-status' },
      { dispatcher: new ToolDispatcher(), runStateStore: store },
    );
    expect(terminal.structuredContent).toMatchObject({
      goal: { outcome: 'achieved', turns_used: 2 },
      goal_budget: { max_turns: 4, turns_used: 2, wall_clock_ms_used: 12_000 },
      prompts: [{ goal: { outcome: 'achieved', authoritative: true } }],
    });
  });

  it('warns for wait_for_change_ms on a criteria-linked run', async () => {
    await store.create({
      runId: 'r-linked-change-wait',
      agentId: 'codex',
      worktreePath: '/wt/r-linked-change-wait',
      initialPrompt: 'go',
      criteriaSetId: 'criteria-1',
      criteriaEpoch: 0,
    });
    await store.markTerminal('r-linked-change-wait', {
      status: 'cancelled',
      summary: 'stopped',
      filesChanged: [],
    });

    const response = await getRunStatusToolHandler({
      run_id: 'r-linked-change-wait',
      wait_for_change_ms: 1,
    }, { dispatcher: new ToolDispatcher(), runStateStore: store });

    expect(response.structuredContent?.warnings).toEqual([
      expect.stringMatching(/^get_run_status\.criteria_linked_wait:/),
    ]);
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
  }, 60_000);

  it('reuses terminal commit cache until host HEAD changes', async () => {
    execSync('git init -q', { cwd: repoRoot });
    execSync('git config user.email test@crew.local', { cwd: repoRoot });
    execSync('git config user.name test', { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'README.md'), 'init\n', 'utf-8');
    execSync('git add README.md', { cwd: repoRoot });
    execSync('git commit -q -m init', { cwd: repoRoot });

    const manager = new WorktreeManager({ projectRoot: repoRoot, crewHome });
    const worktreePath = await manager.createRunWorktree('r-cache');
    await store.create({
      runId: 'r-cache',
      agentId: 'codex',
      worktreePath,
      initialPrompt: 'go',
    });
    writeFileSync(join(worktreePath, 'run-1.txt'), 'run 1\n', 'utf-8');
    execSync('git add run-1.txt', { cwd: worktreePath });
    execSync('git commit -q -m "run: change 1"', { cwd: worktreePath });
    await store.markTerminal('r-cache', {
      status: 'success',
      summary: 'done',
      filesChanged: ['run-1.txt'],
    });

    const first = await getRunStatusToolHandler(
      { run_id: 'r-cache' },
      { dispatcher: new ToolDispatcher(), runStateStore: store },
    );
    expect(first.structuredContent).toMatchObject({ commit_count: 1 });
    expect(childProcessMocks.execFileSync).toHaveBeenCalledTimes(2);

    writeFileSync(join(worktreePath, 'run-2.txt'), 'run 2\n', 'utf-8');
    execSync('git add run-2.txt', { cwd: worktreePath });
    execSync('git commit -q -m "run: change 2"', { cwd: worktreePath });

    childProcessMocks.execFileSync.mockClear();
    const unchangedHost = await getRunStatusToolHandler(
      { run_id: 'r-cache' },
      { dispatcher: new ToolDispatcher(), runStateStore: store },
    );
    expect(unchangedHost.structuredContent).toMatchObject({ commit_count: 1 });
    expect(childProcessMocks.execFileSync).not.toHaveBeenCalled();

    writeFileSync(join(repoRoot, 'host.txt'), 'host moved\n', 'utf-8');
    execSync('git add host.txt', { cwd: repoRoot });
    execSync('git commit -q -m "host: moved"', { cwd: repoRoot });

    const advancedHost = await getRunStatusToolHandler(
      { run_id: 'r-cache' },
      { dispatcher: new ToolDispatcher(), runStateStore: store },
    );
    expect(advancedHost.structuredContent).toMatchObject({ commit_count: 2 });
    expect(childProcessMocks.execFileSync).toHaveBeenCalledTimes(2);
  });

  it('surfaces commits for merge_conflict runs while the worktree remains present', async () => {
    execSync('git init -q', { cwd: repoRoot });
    execSync('git config user.email test@crew.local', { cwd: repoRoot });
    execSync('git config user.name test', { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'README.md'), 'init\n', 'utf-8');
    execSync('git add README.md', { cwd: repoRoot });
    execSync('git commit -q -m init', { cwd: repoRoot });

    const manager = new WorktreeManager({ projectRoot: repoRoot, crewHome });
    const worktreePath = await manager.createRunWorktree('r-conflict-commits');
    await store.create({
      runId: 'r-conflict-commits',
      agentId: 'codex',
      worktreePath,
      initialPrompt: 'go',
    });
    writeFileSync(join(worktreePath, 'conflict.txt'), 'run edit\n', 'utf-8');
    execSync('git add conflict.txt', { cwd: worktreePath });
    execSync('git commit -q -m "run: conflict edit"', { cwd: worktreePath });
    await store.markTerminal('r-conflict-commits', {
      status: 'success',
      summary: 'done',
      filesChanged: ['conflict.txt'],
    });
    await store.markMergeConflict('r-conflict-commits', {
      target: 'main',
      conflicts: ['conflict.txt'],
    });

    const response = await getRunStatusToolHandler(
      { run_id: 'r-conflict-commits' },
      { dispatcher: new ToolDispatcher(), runStateStore: store },
    );

    expect(response.structuredContent).toMatchObject({
      status: 'merge_conflict',
      commit_count: 1,
    });
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
        {
          run_id: 'r-gap',
          wait_for_change_ms: 10_000,
          wait_for_terminal_only: true,
          user_requested_wait: true,
        },
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

  it('embeds a scoped capped inbox and gives merge_or_discard precedence for success write runs', async () => {
    await store.create({
      runId: 'r-inbox-write',
      agentId: 'codex',
      worktreePath: '/wt/r-inbox-write',
      initialPrompt: 'go',
      runMode: 'write',
    });
    await store.markTerminal('r-inbox-write', {
      status: 'success',
      summary: 'worker summary',
      filesChanged: [],
    });
    const scoped = [];
    for (let index = 0; index < 3; index += 1) {
      scoped.push(await appendMessage({
        crewHome,
        message: {
          to: { kind: 'captain' },
          from: { kind: 'run', run_id: 'r-inbox-write', agent_id: 'codex' },
          kind: 'note',
          body: `${'"\\\n'.repeat(120)} tail-${index}`,
          worker_run_id_at_send: 'r-inbox-write',
          worker_agent_id_at_send: 'codex',
          repo_root_at_send: store.repoRoot,
        },
      }));
    }
    await appendMessage({
      crewHome,
      message: {
        to: { kind: 'captain' },
        from: { kind: 'run', run_id: 'other-run', agent_id: 'claude-code' },
        kind: 'review',
        body: 'must stay out of the scoped block',
        worker_run_id_at_send: 'other-run',
        worker_agent_id_at_send: 'claude-code',
        repo_root_at_send: store.repoRoot,
      },
    });

    const response = await getRunStatusToolHandler(
      { run_id: 'r-inbox-write' },
      { dispatcher: new ToolDispatcher(), runStateStore: store, crewHome },
    );
    const inbox = response.structuredContent?.inbox as {
      unread_count: number;
      messages: Array<{ msg_id: string; preview: string; body?: string }>;
      truncated?: true;
    };
    expect(inbox.unread_count).toBe(3);
    expect(inbox.messages).toHaveLength(TERMINAL_INBOX_MAX_MESSAGES);
    expect(inbox.messages.map((message) => message.msg_id)).toEqual([
      scoped[2].msg_id,
      scoped[1].msg_id,
    ]);
    expect(inbox.messages.every((message) => message.body === undefined)).toBe(true);
    expect(inbox.messages.every((message) => !/[\r\n]/u.test(message.preview))).toBe(true);
    expect(inbox.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(inbox), 'utf8')).toBeLessThanOrEqual(
      TERMINAL_INBOX_MAX_BYTES,
    );
    expect(response.structuredContent?.required_next_action).toEqual({
      type: 'merge_or_discard',
      run_id: 'r-inbox-write',
      consequence_if_skipped:
        'Leaving a successful write run unresolved risks garbage collection and loss of its unmerged work.',
    });
    expect(response.content[0].text.match(new RegExp(UNTRUSTED_WORKER_CONTENT_LABEL, 'gu')))
      .toHaveLength(1);
    expect(response.content[0].text).toContain(`msg_id=${scoped[2].msg_id}`);
    expect(response.content[0].text).not.toContain('must stay out of the scoped block');
  });

  it.each(['read_only', 'ephemeral_review'] as const)(
    'does not emit merge_or_discard for successful %s runs',
    async (runMode) => {
      const runId = `r-${runMode}`;
      await store.create({
        runId,
        agentId: 'codex',
        worktreePath: `/wt/${runId}`,
        initialPrompt: 'go',
        runMode,
      });
      await store.markTerminal(runId, {
        status: 'success',
        summary: 'done',
        filesChanged: [],
      });

      const response = await getRunStatusToolHandler(
        { run_id: runId },
        { dispatcher: new ToolDispatcher(), runStateStore: store, crewHome },
      );
      expect(response.structuredContent).not.toHaveProperty('required_next_action');
    },
  );

  it('emits check_inbox for a non-write-success terminal run with scoped unread messages', async () => {
    await store.create({
      runId: 'r-inbox-error',
      agentId: 'claude-code',
      worktreePath: '/wt/r-inbox-error',
      initialPrompt: 'go',
      runMode: 'write',
    });
    await store.markTerminal('r-inbox-error', {
      status: 'error',
      summary: 'failed after sending findings',
      filesChanged: [],
      lastError: 'failed',
    });
    await appendMessage({
      crewHome,
      message: {
        to: { kind: 'captain' },
        from: { kind: 'run', run_id: 'r-inbox-error', agent_id: 'claude-code' },
        kind: 'review',
        body: 'finding',
        worker_run_id_at_send: 'r-inbox-error',
        worker_agent_id_at_send: 'claude-code',
        repo_root_at_send: store.repoRoot,
      },
    });

    const response = await getRunStatusToolHandler(
      { run_id: 'r-inbox-error' },
      { dispatcher: new ToolDispatcher(), runStateStore: store, crewHome },
    );
    expect(response.structuredContent?.required_next_action).toEqual({
      type: 'check_inbox',
      run_id: 'r-inbox-error',
      unread_count: 1,
      consequence_if_skipped: 'Worker-delivered findings from this run may be missed.',
    });
  });

  it('fails open when the terminal inbox store read throws', async () => {
    await store.create({
      runId: 'r-inbox-fail-open',
      agentId: 'codex',
      worktreePath: '/wt/r-inbox-fail-open',
      initialPrompt: 'go',
      runMode: 'read_only',
    });
    await store.markTerminal('r-inbox-fail-open', {
      status: 'error',
      summary: 'status still available',
      filesChanged: [],
      lastError: 'worker error',
    });
    resetCaptainInboxFs = setCaptainInboxFsForTest({
      existsSync: () => true,
      readdirSync: () => {
        throw new Error('inbox unavailable');
      },
    });

    const response = await getRunStatusToolHandler(
      { run_id: 'r-inbox-fail-open' },
      { dispatcher: new ToolDispatcher(), runStateStore: store, crewHome },
    );
    expect(response.structuredContent).toMatchObject({
      status: 'error',
      summary: 'status still available',
    });
    expect(response.structuredContent).not.toHaveProperty('inbox');
    expect(response.structuredContent).not.toHaveProperty('required_next_action');
  });

  it('omits the provenance notice when terminal worker content is empty', async () => {
    await store.create({
      runId: 'r-empty-content',
      agentId: 'codex',
      worktreePath: '/wt/r-empty-content',
      initialPrompt: 'go',
      runMode: 'read_only',
    });
    await store.markTerminal('r-empty-content', {
      status: 'cancelled',
      summary: '',
      filesChanged: [],
    });

    const response = await getRunStatusToolHandler(
      { run_id: 'r-empty-content' },
      { dispatcher: new ToolDispatcher(), runStateStore: store, crewHome },
    );
    expect(response.content[0].text).not.toContain(UNTRUSTED_WORKER_CONTENT_LABEL);
  });
});
