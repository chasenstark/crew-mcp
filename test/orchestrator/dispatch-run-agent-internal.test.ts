import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
import { RunStateStore } from '../../src/orchestrator/run-state.js';
import { ToolDispatcher, type DispatchTask } from '../../src/orchestrator/tool-dispatcher.js';
import { crewTailUrl } from '../../src/cli/commands/tail-url.js';

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
  timeoutMs = 2000,
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

  afterEach(() => {
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

    expect(result.runId).toMatch(/^[0-9a-f-]{36}$/);
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
});
