import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AdapterRegistry } from '../../../src/adapters/registry.js';
import type { AgentAdapter, TaskResult } from '../../../src/adapters/types.js';
import { WorktreeManager } from '../../../src/git/worktree.js';
import type { DispatchContext } from '../../../src/orchestrator/dispatch-run-agent-internal.js';
import { RunStateStore, type RunStateV1 } from '../../../src/orchestrator/run-state.js';
import { ToolDispatcher } from '../../../src/orchestrator/tool-dispatcher.js';

export function makeMockAdapter(overrides?: Partial<AgentAdapter>): AgentAdapter {
  return {
    name: overrides?.name ?? 'mock',
    strengths: overrides?.strengths ?? [],
    supportsJsonSchema: false,
    filesModifiedReliable: true,
    execute:
      overrides?.execute ??
      (async (): Promise<TaskResult> => ({
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

export function makeRegistry(adapters: AgentAdapter[]): AdapterRegistry {
  const map = new Map<string, AgentAdapter>(adapters.map((adapter) => [adapter.name, adapter]));
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

export interface PanelHarness {
  readonly root: string;
  readonly crewHome: string;
  readonly worktreeManager: WorktreeManager;
  readonly runStateStore: RunStateStore;
  readonly dispatcher: ToolDispatcher;
  readonly ctx: DispatchContext;
  readonly cleanup: () => void;
}

export function makeHarness(adapters: AgentAdapter[]): PanelHarness {
  const root = mkdtempSync(join(tmpdir(), 'crew-panel-repo-'));
  const crewHome = mkdtempSync(join(tmpdir(), 'crew-panel-home-'));
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

export async function createRunState(
  h: PanelHarness,
  overrides: {
    readonly runId?: string;
    readonly agentId?: string;
    readonly status?: RunStateV1['status'];
    readonly summary?: string;
    readonly filesChanged?: readonly string[];
    readonly worktreePath?: string;
    readonly repoRoot?: string | null;
    readonly readOnly?: boolean;
  } = {},
): Promise<RunStateV1> {
  const runId = overrides.runId ?? `run-${Math.random().toString(16).slice(2)}`;
  const worktreePath = overrides.worktreePath ?? join(h.crewHome, 'manual-worktrees', runId);
  mkdirSync(worktreePath, { recursive: true });
  await h.runStateStore.create({
    runId,
    agentId: overrides.agentId ?? 'implementer',
    worktreePath,
    initialPrompt: 'initial prompt',
    readOnly: overrides.readOnly,
  });

  const status = overrides.status ?? 'success';
  if (status === 'running') {
    return applyRepoRootOverride(h, runId, overrides.repoRoot);
  }
  if (
    status === 'success'
    || status === 'partial'
    || status === 'error'
    || status === 'cancelled'
  ) {
    await h.runStateStore.markTerminal(runId, {
      status,
      summary: overrides.summary ?? `${status} summary`,
      filesChanged: overrides.filesChanged ?? [],
      ...(status === 'error' ? { lastError: overrides.summary ?? 'error summary' } : {}),
    });
  } else {
    await h.runStateStore.update(runId, (state) => ({
      ...state,
      status,
      completedAt: new Date().toISOString(),
      ...(status === 'merged'
        ? { mergeStatus: { target: 'main', commitSha: 'abc123' } }
        : {}),
      ...(status === 'merge_conflict'
        ? { mergeStatus: { target: 'main', conflicts: ['src/a.ts'] } }
        : {}),
    }));
  }
  return applyRepoRootOverride(h, runId, overrides.repoRoot);
}

export function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export async function waitFor(
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

async function applyRepoRootOverride(
  h: PanelHarness,
  runId: string,
  repoRoot: string | null | undefined,
): Promise<RunStateV1> {
  if (repoRoot === undefined) return h.runStateStore.read(runId)!;
  return h.runStateStore.update(runId, (state) => {
    if (repoRoot === null) {
      const { repoRoot: _repoRoot, ...legacy } = state;
      return legacy;
    }
    return {
      ...state,
      repoRoot,
    };
  });
}
