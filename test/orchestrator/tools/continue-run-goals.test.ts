import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Task } from '../../../src/adapters/types.js';
import {
  drainPendingTerminalPersists,
  installRunLifecycleListeners,
} from '../../../src/orchestrator/run-lifecycle-listeners.js';
import { cancelRunToolHandler } from '../../../src/orchestrator/tools/cancel-run.js';
import { continueRunToolHandler } from '../../../src/orchestrator/tools/continue-run.js';
import type {
  ToolHandlerDeps,
  ToolRequestExtra,
} from '../../../src/orchestrator/tools/shared.js';
import { getDefaultConfig } from '../../../src/workflow/config-codec.js';
import {
  makeHarness,
  makeMockAdapter,
  type PanelHarness,
  waitFor,
} from './panel-test-harness.js';

const cleanups: Array<() => void> = [];

afterEach(async () => {
  await drainPendingTerminalPersists();
  vi.restoreAllMocks();
  while (cleanups.length > 0) cleanups.pop()?.();
});

const extra: ToolRequestExtra = {
  sendNotification: async () => undefined,
};

function depsFor(h: PanelHarness): ToolHandlerDeps {
  return {
    registry: h.ctx.registry as ToolHandlerDeps['registry'],
    worktreeManager: h.worktreeManager,
    runStateStore: h.runStateStore,
    dispatcher: h.dispatcher,
    crewHome: h.crewHome,
    projectRoot: h.root,
    getClientKind: () => 'codex',
    getCrewWaitCommand: () => undefined,
    progressTokenSeen: {
      presentLogged: false,
      absentLogged: false,
    },
    readAgentPrefs: () => ({}),
    loadWorkflowConfig: () => getDefaultConfig(),
  };
}

describe('continue_run goal recovery', () => {
  it('subtracts a user-cancelled goal turn elapsed time from the next continuation', async () => {
    const observedTasks: Task[] = [];
    const adapter = makeMockAdapter({
      name: 'claude-code',
      goalSupport: 'claude-native',
      supportsResume: true,
      execute: async (task) => {
        observedTasks.push(task);
        return {
          output: 'continued within the remaining budget',
          filesModified: [],
          status: 'success',
          sessionId: 'native-session',
          goal: {
            outcome: 'achieved',
            authoritative: true,
            turnsUsed: 1,
            wallClockMsUsed: 1_000,
          },
          metadata: {},
        };
      },
    });
    const h = makeHarness([adapter]);
    cleanups.push(h.cleanup);
    const request = {
      validationCommand: 'npm test',
      repeatSafe: true as const,
      maxTurns: 4,
      maxWallClockMs: 30_000,
    };
    await h.runStateStore.create({
      runId: 'run-user-cancel-budget',
      agentId: 'claude-code',
      worktreePath: h.root,
      initialPrompt: 'initial goal work',
      runMode: 'write',
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
    await h.runStateStore.update('run-user-cancel-budget', (state) => ({
      ...state,
      sessionId: 'native-session',
    }));
    void installRunLifecycleListeners({
      dispatcher: h.dispatcher,
      runStateStore: h.runStateStore,
      runId: 'run-user-cancel-budget',
      agentName: 'claude-code',
      toolCallId: 'tc-user-cancel-budget',
    });

    let signalTaskStarted!: () => void;
    const taskStarted = new Promise<void>((resolve) => {
      signalTaskStarted = resolve;
    });
    const cancelledEvent = new Promise<{ elapsedMs: number }>((resolve) => {
      const sub = h.dispatcher.onEvent('run:cancelled', (info) => {
        if (info.toolCallId !== 'tc-user-cancel-budget') return;
        sub.dispose();
        resolve({ elapsedMs: info.elapsedMs });
      });
    });
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    h.dispatcher.start({
      toolCallId: 'tc-user-cancel-budget',
      toolName: 'run_agent',
      runId: 'run-user-cancel-budget',
      run: async ({ signal }) => {
        signalTaskStarted();
        return await new Promise((_resolve, reject) => {
          const rejectForAbort = () => reject(signal.reason);
          if (signal.aborted) rejectForAbort();
          else signal.addEventListener('abort', rejectForAbort, { once: true });
        });
      },
    });
    await taskStarted;
    nowSpy.mockReturnValue(11_000);

    const cancelResult = cancelRunToolHandler(
      { run_id: 'run-user-cancel-budget' },
      { dispatcher: h.dispatcher, runStateStore: h.runStateStore },
    );
    expect(cancelResult.structuredContent).toMatchObject({ ok: true });
    await expect(cancelledEvent).resolves.toEqual({ elapsedMs: 10_000 });
    nowSpy.mockRestore();
    await drainPendingTerminalPersists();

    expect(h.runStateStore.read('run-user-cancel-budget')).toMatchObject({
      status: 'cancelled',
      sessionId: 'native-session',
      goalBudget: {
        maxWallClockMs: 30_000,
        wallClockMsUsed: 10_000,
      },
      prompts: [{
        goal: expect.objectContaining({
          outcome: 'cancelled',
          authoritative: true,
          wallClockMsUsed: 10_000,
        }),
      }],
    });

    vi.spyOn(h.worktreeManager, 'appendAndSyncUncommittedToRunWorktree')
      .mockImplementation(async (_runId, append) => append());
    vi.spyOn(h.worktreeManager, 'getRunGitCommitWritablePaths').mockReturnValue({
      worktreeGitDir: h.root,
      objectsDir: h.root,
      branchRefsDir: h.root,
      branchLogsDir: h.root,
      paths: [h.root],
    });
    vi.spyOn(h.worktreeManager, 'getModifiedFilesByRun').mockResolvedValue([]);

    const continued = await continueRunToolHandler({
      run_id: 'run-user-cancel-budget',
      prompt: 'continue the same bounded goal',
      goal_policy: 'inherit',
    }, extra, depsFor(h));

    expect(continued.isError).not.toBe(true);
    await waitFor(() => observedTasks.length === 1);
    expect(observedTasks[0].constraints).toMatchObject({
      resumeSessionId: 'native-session',
      goal: {
        action: 'inherit',
        maxTurns: 4,
        maxWallClockMs: 20_000,
      },
    });
  });

  it('retries a failed default clear in the retained provider session', async () => {
    const observedTasks: Task[] = [];
    const adapter = makeMockAdapter({
      name: 'claude-code',
      goalSupport: 'claude-native',
      execute: async (task) => {
        observedTasks.push(task);
        return {
          output: 'goal cleared and work continued',
          filesModified: [],
          status: 'success',
          sessionId: 'native-session',
          goal: {
            outcome: 'not_requested',
            authoritative: true,
            reason: 'Claude confirmed that the native goal was cleared.',
            turnsUsed: 0,
            wallClockMsUsed: 0,
          },
          metadata: {},
        };
      },
    });
    const h = makeHarness([adapter]);
    cleanups.push(h.cleanup);
    const request = {
      validationCommand: 'npm test',
      repeatSafe: true as const,
      maxTurns: 4,
      maxWallClockMs: 30_000,
    };
    await h.runStateStore.create({
      runId: 'run-clear-retry',
      agentId: 'claude-code',
      worktreePath: h.root,
      initialPrompt: 'initial goal work',
      runMode: 'write',
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
    await h.runStateStore.markTerminal('run-clear-retry', {
      status: 'partial',
      summary: 'provider did not expose a terminal goal event',
      filesChanged: [],
      sessionId: 'native-session',
      goal: {
        outcome: 'evaluator_error',
        authoritative: false,
        turnsUsed: 2,
        wallClockMsUsed: 5_000,
      },
    });
    vi.spyOn(h.worktreeManager, 'appendAndSyncUncommittedToRunWorktree')
      .mockImplementation(async (_runId, append) => append());
    vi.spyOn(h.worktreeManager, 'getRunGitCommitWritablePaths').mockReturnValue({
      worktreeGitDir: h.root,
      objectsDir: h.root,
      branchRefsDir: h.root,
      branchLogsDir: h.root,
      paths: [h.root],
    });
    vi.spyOn(h.worktreeManager, 'getModifiedFilesByRun').mockResolvedValue([]);
    const startSpy = vi.spyOn(h.dispatcher, 'start').mockImplementationOnce(() => {
      throw new Error('mock start failure');
    });

    const failed = await continueRunToolHandler({
      run_id: 'run-clear-retry',
      prompt: 'first default clear',
    }, extra, depsFor(h));

    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toContain('mock start failure');
    expect(h.runStateStore.read('run-clear-retry')).toMatchObject({
      status: 'error',
      sessionId: 'native-session',
      goalBudget: {
        maxTurns: 4,
        maxWallClockMs: 30_000,
        turnsUsed: 2,
        wallClockMsUsed: 5_000,
      },
      prompts: [
        expect.any(Object),
        expect.objectContaining({
          goal: expect.objectContaining({
            policy: 'clear',
            outcome: 'provider_error',
            authoritative: false,
          }),
        }),
      ],
    });

    startSpy.mockRestore();

    const retried = await continueRunToolHandler({
      run_id: 'run-clear-retry',
      prompt: 'second default clear',
    }, extra, depsFor(h));

    expect(retried.isError).not.toBe(true);
    await waitFor(() => observedTasks.length === 1);
    expect(observedTasks[0].constraints).toMatchObject({
      resumeSessionId: 'native-session',
      goal: {
        action: 'clear',
        maxTurns: 0,
        maxWallClockMs: 0,
      },
    });
    await waitFor(() => h.runStateStore.read('run-clear-retry')?.status === 'success');
    expect(h.runStateStore.read('run-clear-retry')).toMatchObject({
      sessionId: 'native-session',
      goalBudget: {
        maxTurns: 4,
        maxWallClockMs: 30_000,
        turnsUsed: 2,
        wallClockMsUsed: 5_000,
      },
      prompts: [
        expect.any(Object),
        expect.any(Object),
        expect.objectContaining({
          goal: expect.objectContaining({
            policy: 'clear',
            outcome: 'not_requested',
            authoritative: true,
          }),
        }),
      ],
    });
  });
});
