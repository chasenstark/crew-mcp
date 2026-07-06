import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AdapterRegistry } from '../../src/adapters/registry.js';
import type { AgentAdapter, TaskResult } from '../../src/adapters/types.js';
import { WorktreeManager } from '../../src/git/worktree.js';
import {
  DispatchError,
  dispatchRunAgentInternal,
  type DispatchContext,
} from '../../src/orchestrator/dispatch-run-agent-internal.js';
import {
  criteriaDir,
  readCriteriaState,
} from '../../src/orchestrator/criteria/store.js';
import { RunStateStore } from '../../src/orchestrator/run-state.js';
import { drainPendingTerminalPersists } from '../../src/orchestrator/run-lifecycle-listeners.js';
import { ToolDispatcher, type DispatchTask } from '../../src/orchestrator/tool-dispatcher.js';
import { readRunAuthSidecar, runAuthSidecarPath } from '../../src/orchestrator/auth/index.js';
import { crewTailUrl } from '../../src/cli/commands/tail-url.js';
import { confirmCriteriaHandler } from '../../src/orchestrator/tools/confirm-criteria.js';
import { createCriteriaHandler } from '../../src/orchestrator/tools/create-criteria.js';

function makeMockAdapter(overrides?: Partial<AgentAdapter>): AgentAdapter {
  return {
    name: overrides?.name ?? 'mock',
    strengths: overrides?.strengths ?? [],
    supportsJsonSchema: false,
    filesModifiedReliable: true,
    execute:
      overrides?.execute ??
      (async () => ({
        output: 'ok',
        filesModified: [],
        status: 'success',
        metadata: {},
      })),
    healthCheck:
      overrides?.healthCheck ??
      (async () => ({
        available: true,
        authenticated: true,
      })),
    ...overrides,
  };
}

function makeRegistry(adapters: AgentAdapter[]): AdapterRegistry {
  const map = new Map<string, AgentAdapter>(adapters.map((a) => [a.name, a]));
  return {
    register: () => undefined,
    get: (name: string) => map.get(name),
    getOrThrow: (name: string) => {
      const adapter = map.get(name);
      if (!adapter) throw new Error(`adapter not found: ${name}`);
      return adapter;
    },
    healthCheckAll: async () => ({}),
    listAvailable: () => Array.from(map.values()),
  } as unknown as AdapterRegistry;
}

function makeHarness(adapters: AgentAdapter[]): {
  root: string;
  crewHome: string;
  worktreeManager: WorktreeManager;
  runStateStore: RunStateStore;
  dispatcher: ToolDispatcher;
  ctx: DispatchContext;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), 'crew-dispatch-helper-'));
  const crewHome = mkdtempSync(join(tmpdir(), 'crew-dispatch-helper-home-'));
  execSync('git init -q', { cwd: root });
  execSync('git config user.email test@crew.local', { cwd: root });
  execSync('git config user.name test', { cwd: root });
  writeFileSync(join(root, 'README.md'), 'init\n', 'utf-8');
  execSync('git add README.md', { cwd: root });
  execSync('git commit -q -m init', { cwd: root });

  const worktreeManager = new WorktreeManager({ projectRoot: root, crewHome });
  const runStateStore = new RunStateStore({ crewHome, repoRoot: root });
  const dispatcher = new ToolDispatcher();
  const ctx: DispatchContext = {
    registry: makeRegistry(adapters),
    worktreeManager,
    runStateStore,
    agentPrefs: {},
    dispatcher,
    crewHome,
    repoRoot: runStateStore.repoRoot,
    projectRoot: root,
  };
  return {
    root,
    crewHome,
    worktreeManager,
    runStateStore,
    dispatcher,
    ctx,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(crewHome, { recursive: true, force: true });
    },
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor: timeout');
}

function withEnv(overrides: Record<string, string>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

async function createConfirmedCriteria(
  h: ReturnType<typeof makeHarness>,
  id = 'criteria-1',
  repoRoot = h.runStateStore.repoRoot,
): Promise<void> {
  createCriteriaHandler({
    criteria: [
      {
        title: 'Tests green',
        type: 'mechanical',
        detail: 'npm run test:run exits 0',
        signal: 'test output',
      },
      {
        title: 'Contract enforced',
        type: 'behavioral',
        subCriteria: [
          'contract is prepended before peer messages',
          'criteriaContract is stored separately',
        ],
      },
      {
        title: 'No regressions',
        type: 'negative',
        detail: 'dispatch without criteria stays unchanged',
      },
    ],
  }, {
    crewHome: h.crewHome,
    repoRoot,
    makeCriteriaSetId: () => id,
    now: () => '2026-01-01T00:00:00.000Z',
  });
  await confirmCriteriaHandler({
    criteria_set_id: id,
  }, {
    crewHome: h.crewHome,
    now: () => '2026-01-02T00:00:00.000Z',
  });
}

function runWorktreePath(crewHome: string, runId: string): string {
  return join(crewHome, 'runs', runId, 'worktree');
}

function userRunDirs(crewHome: string): string[] {
  return readdirSync(join(crewHome, 'runs'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
}

describe('dispatchRunAgentInternal', () => {
  const cleanups: Array<() => void> = [];

  afterEach(async () => {
    await drainPendingTerminalPersists();
    vi.restoreAllMocks();
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  it('returns dispatch fields and has stream listeners installed before dispatcher.start', async () => {
    const terminal = createDeferred<TaskResult>();
    const adapter = makeMockAdapter({
      name: 'mock',
      execute: async (task) => {
        task.onOutput?.('boot');
        return terminal.promise;
      },
    });
    const h = makeHarness([adapter]);
    cleanups.push(h.cleanup);
    const progressMessages: string[] = [];

    const result = await dispatchRunAgentInternal({
      input: { agent_id: 'mock', prompt: 'do work' },
      ctx: h.ctx,
      progress: { send: (message) => progressMessages.push(message) },
    });

    expect(result.runId).toMatch(/^mock-do-work-[0-9a-f]{8}$/);
    expect(result.worktreePath).toBe(runWorktreePath(h.crewHome, result.runId));
    expect(result.readOnly).toBe(false);
    expect(result.tailCommandPath).toBe(h.runStateStore.tailCommandPath(result.runId));
    expect(result.tailUrl).toBe(crewTailUrl(h.runStateStore.eventsLogPath(result.runId)));
    expect(result.toolCallId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.warnings).toEqual([]);

    await waitFor(() => h.runStateStore.tailEvents(result.runId, 10).includes('[mock] boot'));
    expect(progressMessages).toEqual(['[mock] boot']);

    terminal.resolve({
      output: 'done',
      filesModified: [],
      status: 'success',
      metadata: {},
    });
    await waitFor(() => h.runStateStore.read(result.runId)?.status === 'success');
  });

  it('issues a sidecar and revokes it on success terminal', async () => {
    const terminal = createDeferred<TaskResult>();
    const adapter = makeMockAdapter({
      name: 'mock',
      execute: async () => terminal.promise,
    });
    const h = makeHarness([adapter]);
    cleanups.push(h.cleanup);

    const result = await dispatchRunAgentInternal({
      input: { agent_id: 'mock', prompt: 'do work' },
      ctx: h.ctx,
    });
    const issued = readRunAuthSidecar(h.crewHome, result.runId);
    expect(issued.revoked).toBe(false);
    expect(issued.agent_id).toBe('mock');
    expect(issued.repo_root).toBe(h.runStateStore.repoRoot);

    terminal.resolve({
      output: 'done',
      filesModified: [],
      status: 'success',
      metadata: {},
    });
    await waitFor(() => readRunAuthSidecar(h.crewHome, result.runId).revoked === true);
  });

  it('revokes sidecars for error terminals but not cancelled terminals', async () => {
    const errorAdapter = makeMockAdapter({
      name: 'mock-error',
      execute: async () => ({
        output: 'failed',
        filesModified: [],
        status: 'error',
        metadata: {},
      }),
    });
    const cancelTerminal = createDeferred<TaskResult>();
    const cancelAdapter = makeMockAdapter({
      name: 'mock-cancel',
      execute: async () => cancelTerminal.promise,
    });
    const h = makeHarness([errorAdapter, cancelAdapter]);
    cleanups.push(h.cleanup);

    const errorResult = await dispatchRunAgentInternal({
      input: { agent_id: 'mock-error', prompt: 'fail' },
      ctx: h.ctx,
    });
    await waitFor(() => readRunAuthSidecar(h.crewHome, errorResult.runId).revoked === true);

    const cancelResult = await dispatchRunAgentInternal({
      input: { agent_id: 'mock-cancel', prompt: 'cancel' },
      ctx: h.ctx,
    });
    h.dispatcher.cancel(cancelResult.toolCallId, 'test cancel');
    cancelTerminal.resolve({
      output: 'late',
      filesModified: [],
      status: 'success',
      metadata: {},
    });
    await waitFor(() => h.runStateStore.read(cancelResult.runId)?.status === 'cancelled');
    expect(readRunAuthSidecar(h.crewHome, cancelResult.runId).revoked).toBe(false);
  });

  it('creates sidecars for ephemeral_review dispatches', async () => {
    const terminal = createDeferred<TaskResult>();
    const adapter = makeMockAdapter({
      name: 'agy-review',
      rejectsReadOnly: true,
      reviewDispatchMode: 'ephemeral-worktree',
      execute: async () => terminal.promise,
    });
    const h = makeHarness([adapter]);
    cleanups.push(h.cleanup);

    const result = await dispatchRunAgentInternal({
      input: { agent_id: 'agy-review', prompt: 'review', run_mode: 'ephemeral_review' },
      ctx: h.ctx,
    });

    expect(existsSync(runAuthSidecarPath(h.crewHome, result.runId))).toBe(true);
    terminal.resolve({
      output: 'done',
      filesModified: [],
      status: 'success',
      metadata: {},
    });
  });

  it('revokes the issued sidecar when dispatcher.start fails after state creation', async () => {
    const adapter = makeMockAdapter({ name: 'mock' });
    const h = makeHarness([adapter]);
    cleanups.push(h.cleanup);
    vi.spyOn(h.dispatcher, 'start').mockImplementation(() => {
      throw new Error('boom');
    });

    await expect(dispatchRunAgentInternal({
      input: { agent_id: 'mock', prompt: 'do work' },
      ctx: h.ctx,
    })).rejects.toThrow(/boom/);

    const runId = userRunDirs(h.crewHome)[0];
    const sidecar = JSON.parse(
      readFileSync(runAuthSidecarPath(h.crewHome, runId), 'utf-8'),
    ) as { revoked: boolean };
    expect(sidecar.revoked).toBe(true);
    expect(h.runStateStore.read(runId)?.status).toBe('error');
  });

  it('throws DispatchError for peer_messages preflight failures without state mutation', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'mock' })]);
    cleanups.push(h.cleanup);

    await expect(dispatchRunAgentInternal({
      input: {
        agent_id: 'mock',
        prompt: 'p',
        peer_messages: Array.from({ length: h.runStateStore.caps.maxItems + 1 }, (_, index) => ({
          body: `body ${index}`,
          kind: 'review' as const,
        })),
      },
      ctx: h.ctx,
    })).rejects.toMatchObject({
      name: 'DispatchError',
      message: expect.stringContaining('peer_messages.too_many:'),
      warnings: [],
    });
    expect(userRunDirs(h.crewHome)).toEqual([]);
  });

  it('throws DispatchError for planner errors without state mutation', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'codex' })]);
    cleanups.push(h.cleanup);

    await expect(dispatchRunAgentInternal({
      input: { agent_id: 'missing', prompt: 'p' },
      ctx: h.ctx,
    })).rejects.toMatchObject({
      name: 'DispatchError',
      message: expect.stringContaining('Unknown agent_id "missing"'),
      warnings: [],
    });
    expect(userRunDirs(h.crewHome)).toEqual([]);
  });

  it('cleans up a non-readonly worktree when runStateStore.create throws', async () => {
    const restore = withEnv({
      CREW_PEER_MESSAGES_PREPEND_CAP_CHARS: '100',
      CREW_PEER_MESSAGES_HARD_CEILING: '150',
      CREW_DISPATCH_PROMPT_CAP_CHARS: '160',
    });
    try {
      const h = makeHarness([makeMockAdapter({ name: 'mock' })]);
      cleanups.push(h.cleanup);
      const cleanupSpy = vi.spyOn(h.worktreeManager, 'cleanupByRunId');

      await expect(dispatchRunAgentInternal({
        input: { agent_id: 'mock', prompt: 'x'.repeat(200) },
        ctx: h.ctx,
      })).rejects.toMatchObject({
        name: 'DispatchError',
        message: expect.stringContaining('peer_messages.composed_prompt_too_large:'),
        warnings: [],
      });

      expect(cleanupSpy).toHaveBeenCalledOnce();
      const runId = cleanupSpy.mock.calls[0][0];
      expect(existsSync(runWorktreePath(h.crewHome, runId))).toBe(false);
      expect(h.runStateStore.read(runId)).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('marks state terminal-error, cleans up, and preserves warnings when dispatcher.start throws', async () => {
    const restore = withEnv({ CREW_PEER_MESSAGE_BODY_CAP_CHARS: '8' });
    try {
      const h = makeHarness([makeMockAdapter({ name: 'mock' })]);
      cleanups.push(h.cleanup);
      let startedTask: DispatchTask | undefined;
      vi.spyOn(h.dispatcher, 'start').mockImplementation((task) => {
        startedTask = task;
        throw new Error('duplicate toolCallId');
      });

      let err: unknown;
      try {
        await dispatchRunAgentInternal({
          input: {
            agent_id: 'mock',
            prompt: 'p',
            peer_messages: [{ body: 'this body will truncate', kind: 'review' }],
          },
          ctx: h.ctx,
        });
      } catch (caught) {
        err = caught;
      }

      expect(err).toBeInstanceOf(DispatchError);
      expect((err as DispatchError).message).toBe('duplicate toolCallId');
      expect((err as DispatchError).warnings).toEqual([
        expect.stringContaining('peer_messages.body_truncated:'),
      ]);
      const runId = startedTask?.runId;
      expect(runId).toBeDefined();
      const state = h.runStateStore.read(runId!);
      expect(state?.status).toBe('error');
      expect(state?.prompts.at(-1)?.summary).toBe('duplicate toolCallId');
      expect(state?.filesChanged).toEqual([]);
      expect(existsSync(runWorktreePath(h.crewHome, runId!))).toBe(false);
    } finally {
      restore();
    }
  });

  it('marks the run terminal through the installed lifecycle listeners', async () => {
    const adapter = makeMockAdapter({
      name: 'mock',
      execute: async () => ({
        output: 'terminal summary',
        filesModified: ['changed.ts'],
        status: 'partial',
        metadata: {},
      }),
    });
    const h = makeHarness([adapter]);
    cleanups.push(h.cleanup);

    const result = await dispatchRunAgentInternal({
      input: { agent_id: 'mock', prompt: 'p' },
      ctx: h.ctx,
    });

    await waitFor(() => h.runStateStore.read(result.runId)?.status === 'partial');
    const state = h.runStateStore.read(result.runId);
    expect(state?.prompts.at(-1)?.summary).toBe('terminal summary');
    expect(state?.filesChanged).toEqual(['changed.ts']);
  });

  it('persists enriched filesChanged for adapter-returned errors but not thrown failures', async () => {
    const returnedErrorAdapter = makeMockAdapter({
      name: 'returns-error',
      execute: async (task) => {
        writeFileSync(join(task.context.workingDirectory, 'adapter-reported.ts'), 'reported\n', 'utf-8');
        writeFileSync(join(task.context.workingDirectory, 'worktree-discovered.ts'), 'discovered\n', 'utf-8');
        return {
          output: 'quota stopped',
          filesModified: ['adapter-reported.ts'],
          status: 'error',
          warnings: ['adapter quota warning'],
          metadata: {},
        };
      },
    });
    const thrownErrorAdapter = makeMockAdapter({
      name: 'throws-error',
      execute: async (task) => {
        writeFileSync(join(task.context.workingDirectory, 'thrown-edited.ts'), 'edited\n', 'utf-8');
        throw new Error('process crashed');
      },
    });
    const h = makeHarness([returnedErrorAdapter, thrownErrorAdapter]);
    cleanups.push(h.cleanup);

    const returned = await dispatchRunAgentInternal({
      input: { agent_id: 'returns-error', prompt: 'touch files then stop' },
      ctx: h.ctx,
    });
    await waitFor(() => h.runStateStore.read(returned.runId)?.status === 'error');

    const returnedState = h.runStateStore.read(returned.runId);
    expect(returnedState?.lastError).toBe('quota stopped');
    expect(returnedState?.prompts.at(-1)?.summary).toBe('quota stopped');
    expect(returnedState?.filesChanged.slice().sort()).toEqual([
      'adapter-reported.ts',
      'worktree-discovered.ts',
    ]);
    expect(returnedState?.warnings).toEqual(['adapter quota warning']);

    const thrown = await dispatchRunAgentInternal({
      input: { agent_id: 'throws-error', prompt: 'throw after touching files' },
      ctx: h.ctx,
    });
    await waitFor(() => h.runStateStore.read(thrown.runId)?.status === 'error');

    const thrownState = h.runStateStore.read(thrown.runId);
    expect(thrownState?.lastError).toBe('process crashed');
    expect(thrownState?.prompts.at(-1)?.summary).toBe('process crashed');
    expect(thrownState?.filesChanged).toEqual([]);
    expect(thrownState?.warnings).toBeUndefined();
  });

  it('injects confirmed criteria ahead of peer messages and stores contract metadata untruncated', async () => {
    const restore = withEnv({ CREW_PROMPT_STORAGE_CAP_CHARS: '24' });
    try {
      let capturedPrompt = '';
      const adapter = makeMockAdapter({
        name: 'mock',
        execute: async (task) => {
          capturedPrompt = task.prompt;
          return {
            output: 'done',
            filesModified: [],
            status: 'success',
            metadata: {},
          };
        },
      });
      const h = makeHarness([adapter]);
      cleanups.push(h.cleanup);
      await createConfirmedCriteria(h);

      const result = await dispatchRunAgentInternal({
        input: {
          agent_id: 'mock',
          criteria_set_id: 'criteria-1',
          prompt: 'x'.repeat(100),
          peer_messages: [{ body: 'review context', kind: 'review', from_label: 'reviewer' }],
        },
        ctx: h.ctx,
      });
      await waitFor(() => h.runStateStore.read(result.runId)?.status === 'success');

      const state = h.runStateStore.read(result.runId);
      const promptRecord = state?.prompts[0];
      expect(capturedPrompt.startsWith('Acceptance Criteria Contract\ncriteria_set_id: criteria-1')).toBe(true);
      expect(capturedPrompt.indexOf('Acceptance Criteria Contract')).toBeLessThan(
        capturedPrompt.indexOf('## Peer messages'),
      );
      expect(state?.criteriaSetId).toBe('criteria-1');
      expect(state?.criteriaEpoch).toBe(0);
      expect(promptRecord?.criteriaSetId).toBe('criteria-1');
      expect(promptRecord?.criteriaEpoch).toBe(0);
      expect(promptRecord?.criteriaContract).toContain('criteria_set_id: criteria-1');
      expect(promptRecord?.prompt).toContain('[... truncated for storage; original was');
      expect(readCriteriaState(criteriaDir(h.crewHome, 'criteria-1'))?.implementerRunId)
        .toBe(result.runId);
    } finally {
      restore();
    }
  });

  it('refuses unknown, unconfirmed, and cross-repo criteria before creating state', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'mock' })]);
    cleanups.push(h.cleanup);

    await expect(dispatchRunAgentInternal({
      input: { agent_id: 'mock', prompt: 'p', criteria_set_id: 'missing' },
      ctx: h.ctx,
    })).rejects.toMatchObject({ message: expect.stringMatching(/^criteria\.unknown:/) });

    createCriteriaHandler({
      criteria: [
        {
          title: 'Tests green',
          type: 'mechanical',
          detail: 'npm run test:run exits 0',
          signal: 'test output',
        },
      ],
    }, {
      crewHome: h.crewHome,
      repoRoot: h.runStateStore.repoRoot,
      makeCriteriaSetId: () => 'proposed',
    });
    await expect(dispatchRunAgentInternal({
      input: { agent_id: 'mock', prompt: 'p', criteria_set_id: 'proposed' },
      ctx: h.ctx,
    })).rejects.toMatchObject({ message: expect.stringMatching(/^criteria\.not_confirmed:/) });

    await createConfirmedCriteria(h, 'foreign', '/other/repo');
    await expect(dispatchRunAgentInternal({
      input: { agent_id: 'mock', prompt: 'p', criteria_set_id: 'foreign' },
      ctx: h.ctx,
    })).rejects.toMatchObject({ message: expect.stringMatching(/^criteria\.cross_repo:/) });
  });

  it('throws criteria.contract_too_large when the resolved contract exceeds the composed prompt cap', async () => {
    const restore = withEnv({
      CREW_PEER_MESSAGES_PREPEND_CAP_CHARS: '64',
      CREW_PEER_MESSAGES_HARD_CEILING: '128',
      CREW_DISPATCH_PROMPT_CAP_CHARS: '160',
    });
    try {
      const h = makeHarness([makeMockAdapter({ name: 'mock' })]);
      cleanups.push(h.cleanup);
      createCriteriaHandler({
        criteria: [
          {
            title: 'Large contract',
            type: 'mechanical',
            detail: 'x'.repeat(500),
            signal: 'large detail',
          },
        ],
      }, {
        crewHome: h.crewHome,
        repoRoot: h.runStateStore.repoRoot,
        makeCriteriaSetId: () => 'large',
      });
      await confirmCriteriaHandler({ criteria_set_id: 'large' }, { crewHome: h.crewHome });

      await expect(dispatchRunAgentInternal({
        input: { agent_id: 'mock', prompt: 'p', criteria_set_id: 'large' },
        ctx: h.ctx,
      })).rejects.toMatchObject({
        name: 'DispatchError',
        message: expect.stringMatching(/^criteria\.contract_too_large:/),
      });
    } finally {
      restore();
    }
  });

  it('warns when criteria-shaped peer_messages are passed without criteria_set_id', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'mock' })]);
    cleanups.push(h.cleanup);

    const result = await dispatchRunAgentInternal({
      input: {
        agent_id: 'mock',
        prompt: 'p',
        peer_messages: [{
          body: '1. Tests pass',
          kind: 'note',
          from_label: 'acceptance criteria',
        }],
      },
      ctx: h.ctx,
    });

    expect(result.warnings).toContain(
      'criteria.peer_message_without_criteria_set_id: criteria passed as peer_message without criteria_set_id - store enforcement bypassed',
    );
  });

  it('dispatch without criteria_set_id keeps the legacy prompt and state shape', async () => {
    let capturedPrompt = '';
    const h = makeHarness([makeMockAdapter({
      name: 'mock',
      execute: async (task) => {
        capturedPrompt = task.prompt;
        return {
          output: 'ok',
          filesModified: [],
          status: 'success',
          metadata: {},
        };
      },
    })]);
    cleanups.push(h.cleanup);

    const result = await dispatchRunAgentInternal({
      input: { agent_id: 'mock', prompt: 'plain prompt' },
      ctx: h.ctx,
    });
    await waitFor(() => h.runStateStore.read(result.runId)?.status === 'success');

    const state = h.runStateStore.read(result.runId);
    expect(capturedPrompt).toBe('plain prompt');
    expect(state?.criteriaSetId).toBeUndefined();
    expect(state?.prompts[0].criteriaContract).toBeUndefined();
  });
});
