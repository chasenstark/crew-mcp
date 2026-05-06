import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import {
  planRunAgent,
  resolveEffectiveEffort,
  resolveEffectiveModel,
  type RunAgentHandlerContext,
} from '../../../src/orchestrator/tools/run-agent.js';
import type { AdapterRegistry } from '../../../src/adapters/registry.js';
import type { AgentAdapter, TaskResult } from '../../../src/adapters/types.js';
import { WorktreeManager } from '../../../src/git/worktree.js';

function makeMockAdapter(overrides?: Partial<AgentAdapter>): AgentAdapter {
  const adapter: AgentAdapter = {
    name: overrides?.name ?? 'mock',
    strengths: overrides?.strengths ?? [],
    supportsJsonSchema: false,
    execute: overrides?.execute ?? (async () => ({
      output: 'ok',
      filesModified: [],
      status: 'success',
      metadata: {},
    })),
    healthCheck: overrides?.healthCheck ?? (async () => ({
      available: true,
      authenticated: true,
    })),
    ...overrides,
  };
  return adapter;
}

function makeRegistry(adapters: AgentAdapter[]): AdapterRegistry {
  const map = new Map<string, AgentAdapter>(adapters.map((a) => [a.name, a]));
  return {
    register: () => undefined,
    get: (name: string) => map.get(name),
    getOrThrow: (name: string) => {
      const a = map.get(name);
      if (!a) throw new Error(`adapter not found: ${name}`);
      return a;
    },
    healthCheckAll: async () => ({}),
    listAvailable: () => Array.from(map.values()),
  } as unknown as AdapterRegistry;
}

function makeAbortSignal(): AbortSignal {
  return new AbortController().signal;
}

describe('planRunAgent', () => {
  let root: string;
  let crewHome: string;
  let worktreeManager: WorktreeManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'crew-run-agent-'));
    crewHome = mkdtempSync(join(tmpdir(), 'crew-run-agent-home-'));
    execSync('git init -q', { cwd: root });
    execSync('git config user.email test@crew.local', { cwd: root });
    execSync('git config user.name test', { cwd: root });
    writeFileSync(join(root, 'README.md'), 'init\n', 'utf-8');
    execSync('git add README.md', { cwd: root });
    execSync('git commit -q -m init', { cwd: root });
    worktreeManager = new WorktreeManager({ projectRoot: root, crewHome });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(crewHome, { recursive: true, force: true });
  });

  it('returns an error plan when agent_id is unknown', async () => {
    const ctx: RunAgentHandlerContext = {
      registry: makeRegistry([makeMockAdapter({ name: 'codex' })]),
      worktreeManager,
    };
    const plan = await planRunAgent(
      { agent_id: 'nonexistent', prompt: 'do a thing' },
      randomUUID(),
      ctx,
    );
    expect(plan.kind).toBe('error');
    if (plan.kind === 'error') {
      expect(plan.message).toMatch(/Unknown agent_id "nonexistent"/);
      expect(plan.message).toContain('codex');
    }
  });

  it('allocates a fresh run worktree per call', async () => {
    const adapter = makeMockAdapter({ name: 'codex' });
    const ctx: RunAgentHandlerContext = {
      registry: makeRegistry([adapter]),
      worktreeManager,
    };
    const planA = await planRunAgent(
      { agent_id: 'codex', prompt: 'first' },
      'call-a',
      ctx,
    );
    const planB = await planRunAgent(
      { agent_id: 'codex', prompt: 'second' },
      'call-b',
      ctx,
    );
    expect(planA.kind).toBe('dispatched');
    expect(planB.kind).toBe('dispatched');
    if (planA.kind === 'dispatched' && planB.kind === 'dispatched') {
      expect(planA.runId).not.toBe(planB.runId);
      expect(planA.worktreePath).not.toBe(planB.worktreePath);
    }
  });

  it('invokes the adapter.execute with the supplied prompt + working directory', async () => {
    const executeMock = vi.fn<(t: unknown) => Promise<TaskResult>>(async () => ({
      output: 'done',
      filesModified: [],
      status: 'success',
      metadata: {},
    }));
    const adapter = makeMockAdapter({ name: 'codex', execute: executeMock });
    const ctx: RunAgentHandlerContext = {
      registry: makeRegistry([adapter]),
      worktreeManager,
      // Per-machine model pref simulates the user's agents.json setting
      // — exercises the same plumbing the legacy resolveModel hook used
      // to cover, just through the prefs path that's actually wired.
      agentPrefs: { codex: { model: 'preferred-model' } },
    };
    const plan = await planRunAgent(
      { agent_id: 'codex', prompt: 'fix the typo' },
      'call-x',
      ctx,
    );
    expect(plan.kind).toBe('dispatched');
    if (plan.kind !== 'dispatched') throw new Error('expected dispatched');
    const result = await plan.task.run({ signal: makeAbortSignal() });
    expect(result).toEqual({
      output: 'done',
      filesModified: [],
      status: 'success',
      metadata: {},
    });
    expect(executeMock).toHaveBeenCalledOnce();
    const args = executeMock.mock.calls[0][0] as {
      prompt: string;
      context: { workingDirectory: string };
      constraints: { model?: string; sandbox?: string; writablePaths?: readonly string[] };
    };
    expect(args.prompt).toBe('fix the typo');
    expect(args.context.workingDirectory).toBe(plan.worktreePath);
    expect(args.constraints.model).toBe('preferred-model');
    expect(args.constraints.sandbox).toBe('workspace-write');
    expect(args.constraints.writablePaths).toEqual(
      worktreeManager.getRunGitCommitWritablePaths(plan.runId).paths,
    );
  });

  it('leaves successful worktree edits in the worktree (no auto-merge in v2)', async () => {
    const executeMock = vi.fn<(t: unknown) => Promise<TaskResult>>(async (task) => {
      const typedTask = task as { context: { workingDirectory: string } };
      const srcDir = join(typedTask.context.workingDirectory, 'src');
      mkdirSync(srcDir, { recursive: true });
      writeFileSync(join(srcDir, 'generated.ts'), 'export const value = 1;\n', 'utf-8');
      return {
        output: 'done',
        filesModified: [],
        status: 'success',
        metadata: {},
      };
    });
    const adapter = makeMockAdapter({ name: 'codex', execute: executeMock });
    const ctx: RunAgentHandlerContext = {
      registry: makeRegistry([adapter]),
      worktreeManager,
    };
    const plan = await planRunAgent(
      { agent_id: 'codex', prompt: 'create a file' },
      'call-x',
      ctx,
    );
    if (plan.kind !== 'dispatched') throw new Error('expected dispatched');

    const result = await plan.task.run({ signal: makeAbortSignal() });

    // The dispatch enriches filesModified from the worktree status, but does
    // NOT merge: the file lives only in the worktree, not at project root.
    expect(result).toMatchObject({
      output: 'done',
      filesModified: ['src/generated.ts'],
      status: 'success',
    });
    expect(
      readFileSync(join(plan.worktreePath, 'src', 'generated.ts'), 'utf-8'),
    ).toBe('export const value = 1;\n');
    expect(() => readFileSync(join(root, 'src', 'generated.ts'), 'utf-8')).toThrow();
  });

  it('per-call model wins over agents.json prefs', async () => {
    const executeMock = vi.fn<(t: unknown) => Promise<TaskResult>>(async () => ({
      output: '',
      filesModified: [],
      status: 'success',
      metadata: {},
    }));
    const adapter = makeMockAdapter({ name: 'codex', execute: executeMock });
    const ctx: RunAgentHandlerContext = {
      registry: makeRegistry([adapter]),
      worktreeManager,
      agentPrefs: { codex: { model: 'preferred-model' } },
    };
    const plan = await planRunAgent(
      { agent_id: 'codex', prompt: 'do x', model: 'explicit-model' },
      'call-x',
      ctx,
    );
    if (plan.kind !== 'dispatched') throw new Error('expected dispatched');
    await plan.task.run({ signal: makeAbortSignal() });
    const args = executeMock.mock.calls[0][0] as { constraints: { model?: string } };
    expect(args.constraints.model).toBe('explicit-model');
  });

  it('forwards working_directory from the input verbatim', async () => {
    const executeMock = vi.fn<(t: unknown) => Promise<TaskResult>>(async () => ({
      output: '',
      filesModified: [],
      status: 'success',
      metadata: {},
    }));
    const adapter = makeMockAdapter({ name: 'codex', execute: executeMock });
    const ctx: RunAgentHandlerContext = {
      registry: makeRegistry([adapter]),
      worktreeManager,
    };
    const custom = join(root, 'custom-wd');
    const plan = await planRunAgent(
      { agent_id: 'codex', prompt: 'x', working_directory: custom },
      'call-x',
      ctx,
    );
    if (plan.kind !== 'dispatched') throw new Error('expected dispatched');
    await plan.task.run({ signal: makeAbortSignal() });
    const args = executeMock.mock.calls[0][0] as { context: { workingDirectory: string } };
    expect(args.context.workingDirectory).toBe(custom);
  });

  it('onStart fires after worktree allocation with agentName/runId/worktreePath', async () => {
    const onStart = vi.fn();
    const ctx: RunAgentHandlerContext = {
      registry: makeRegistry([makeMockAdapter({ name: 'codex' })]),
      worktreeManager,
      onStart,
    };
    const plan = await planRunAgent(
      { agent_id: 'codex', prompt: 'do x' },
      'call-x',
      ctx,
    );
    if (plan.kind !== 'dispatched') throw new Error('expected dispatched');
    expect(onStart).toHaveBeenCalledWith({
      agentName: 'codex',
      runId: plan.runId,
      worktreePath: plan.worktreePath,
    });
  });

  it('threads the resolved effort into the dispatched task constraints', async () => {
    // The full precedence test lives in `resolveEffectiveEffort` below;
    // this verifies the dispatch path actually plumbs the value through
    // to the adapter (the layer that translates to a CLI flag).
    let observedEffort: string | undefined;
    const adapter = makeMockAdapter({
      name: 'codex',
      execute: async (task) => {
        observedEffort = task.constraints?.effort;
        return { output: 'ok', filesModified: [], status: 'success', metadata: {} };
      },
    });
    const ctx: RunAgentHandlerContext = {
      registry: makeRegistry([adapter]),
      worktreeManager,
      agentPrefs: { codex: { effort: 'low' } },
    };
    const plan = await planRunAgent(
      { agent_id: 'codex', prompt: 'go', effort: 'high' },
      'tool-call-1',
      ctx,
    );
    if (plan.kind !== 'dispatched') throw new Error('expected dispatched');
    await plan.task.run({ signal: makeAbortSignal(), onStream: () => undefined });
    // Per-call wins over agents.json override.
    expect(observedEffort).toBe('high');
  });

  it('threads only the run worktree git commit paths into write-mode dispatches', async () => {
    let observedWritablePaths: readonly string[] | undefined;
    const adapter = makeMockAdapter({
      name: 'codex',
      execute: async (task) => {
        observedWritablePaths = task.constraints?.writablePaths;
        return { output: 'ok', filesModified: [], status: 'success', metadata: {} };
      },
    });
    const ctx: RunAgentHandlerContext = {
      registry: makeRegistry([adapter]),
      worktreeManager,
    };
    const plan = await planRunAgent(
      { agent_id: 'codex', prompt: 'commit from the run worktree' },
      'tool-call-1',
      ctx,
    );
    if (plan.kind !== 'dispatched') throw new Error('expected dispatched');

    await plan.task.run({ signal: makeAbortSignal(), onStream: () => undefined });

    const expected = worktreeManager.getRunGitCommitWritablePaths(plan.runId);
    expect(observedWritablePaths).toEqual(expected.paths);
    expect(observedWritablePaths).toContain(expected.worktreeGitDir);
    expect(observedWritablePaths).toContain(expected.objectsDir);
    expect(observedWritablePaths).toContain(expected.branchRefsDir);
    expect(observedWritablePaths).toContain(expected.branchLogsDir);
    expect(observedWritablePaths).not.toContain(join(root, '.git'));
  });
});

describe('planRunAgent — read_only path', () => {
  let root: string;
  let crewHome: string;
  let worktreeManager: WorktreeManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'crew-run-agent-ro-'));
    crewHome = mkdtempSync(join(tmpdir(), 'crew-run-agent-ro-home-'));
    execSync('git init -q', { cwd: root });
    execSync('git config user.email test@crew.local', { cwd: root });
    execSync('git config user.name test', { cwd: root });
    writeFileSync(join(root, 'README.md'), 'init\n', 'utf-8');
    execSync('git add README.md', { cwd: root });
    execSync('git commit -q -m init', { cwd: root });
    worktreeManager = new WorktreeManager({ projectRoot: root, crewHome });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(crewHome, { recursive: true, force: true });
  });

  it('skips worktree allocation and defaults working_directory to host repo root', async () => {
    let observedWorkingDir: string | undefined;
    const adapter = makeMockAdapter({
      name: 'reviewer',
      execute: async (task) => {
        observedWorkingDir = task.context?.workingDirectory;
        return { output: 'looked', filesModified: [], status: 'success', metadata: {} };
      },
    });
    const ctx: RunAgentHandlerContext = {
      registry: makeRegistry([adapter]),
      worktreeManager,
    };
    const plan = await planRunAgent(
      { agent_id: 'reviewer', prompt: 'just look', read_only: true },
      'call-ro',
      ctx,
    );
    expect(plan.kind).toBe('dispatched');
    if (plan.kind !== 'dispatched') throw new Error('expected dispatched');

    expect(plan.readOnly).toBe(true);
    // worktreePath echoes the host repo root rather than allocating a fresh tree.
    expect(plan.worktreePath).toBe(root);
    // ~/.crew/runs/.meta carries one record per allocated worktree; a
    // skipped allocation leaves it empty.
    const metaDir = join(crewHome, 'runs', '.meta');
    const metas = readdirSync(metaDir).filter((f) => f.endsWith('.json'));
    expect(metas).toHaveLength(0);

    await plan.task.run({ signal: makeAbortSignal(), onStream: () => undefined });
    expect(observedWorkingDir).toBe(root);
  });

  it('forwards explicit working_directory when read_only=true', async () => {
    let observed: string | undefined;
    const adapter = makeMockAdapter({
      name: 'reviewer',
      execute: async (task) => {
        observed = task.context?.workingDirectory;
        return { output: '', filesModified: [], status: 'success', metadata: {} };
      },
    });
    const target = join(root, 'some-other-tree');
    mkdirSync(target, { recursive: true });
    const ctx: RunAgentHandlerContext = {
      registry: makeRegistry([adapter]),
      worktreeManager,
    };
    const plan = await planRunAgent(
      {
        agent_id: 'reviewer',
        prompt: 'p',
        read_only: true,
        working_directory: target,
      },
      'call-x',
      ctx,
    );
    if (plan.kind !== 'dispatched') throw new Error('expected dispatched');
    expect(plan.worktreePath).toBe(target);
    await plan.task.run({ signal: makeAbortSignal(), onStream: () => undefined });
    expect(observed).toBe(target);
  });

  it('attaches a warnings field when a read-only run dirties the working tree', async () => {
    const adapter = makeMockAdapter({
      name: 'reviewer',
      execute: async (task) => {
        // Reviewer breaks contract: writes a file despite read_only: true.
        const cwd = (task as { context: { workingDirectory: string } }).context.workingDirectory;
        writeFileSync(join(cwd, 'leaked.md'), 'oops\n', 'utf-8');
        return { output: 'broke contract', filesModified: [], status: 'success', metadata: {} };
      },
    });
    const ctx: RunAgentHandlerContext = {
      registry: makeRegistry([adapter]),
      worktreeManager,
    };
    const plan = await planRunAgent(
      { agent_id: 'reviewer', prompt: 'just review', read_only: true },
      'call-x',
      ctx,
    );
    if (plan.kind !== 'dispatched') throw new Error('expected dispatched');
    const result = await plan.task.run({ signal: makeAbortSignal(), onStream: () => undefined }) as TaskResult;
    expect(result.warnings).toBeDefined();
    expect(result.warnings?.length).toBeGreaterThan(0);
    expect(result.warnings?.[0]).toMatch(/leaked\.md/);
    // Clean up the host repo dirt so afterEach's rmSync is well-behaved.
    rmSync(join(root, 'leaked.md'), { force: true });
  });

  it('omits warnings when a read-only run leaves the working tree clean', async () => {
    const adapter = makeMockAdapter({
      name: 'reviewer',
      execute: async () => ({
        output: 'looked, said nothing, touched nothing',
        filesModified: [],
        status: 'success',
        metadata: {},
      }),
    });
    const ctx: RunAgentHandlerContext = {
      registry: makeRegistry([adapter]),
      worktreeManager,
    };
    const plan = await planRunAgent(
      { agent_id: 'reviewer', prompt: 'review', read_only: true },
      'call-x',
      ctx,
    );
    if (plan.kind !== 'dispatched') throw new Error('expected dispatched');
    const result = await plan.task.run({ signal: makeAbortSignal(), onStream: () => undefined }) as TaskResult;
    expect(result.warnings).toBeUndefined();
  });
});

describe('resolveEffectiveEffort', () => {
  function adapterWith(defaultEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'): AgentAdapter {
    return makeMockAdapter({ name: 'codex', defaultEffort });
  }

  it('per-call > agents.json > adapter default', () => {
    const a = adapterWith('medium');
    expect(resolveEffectiveEffort(a, 'high', { codex: { effort: 'low' } })).toBe('high');
  });

  it('falls back to agents.json when no per-call value', () => {
    const a = adapterWith('medium');
    expect(resolveEffectiveEffort(a, undefined, { codex: { effort: 'low' } })).toBe('low');
  });

  it('falls back to adapter defaultEffort when prefs file lacks an entry', () => {
    const a = adapterWith('medium');
    expect(resolveEffectiveEffort(a, undefined, {})).toBe('medium');
    expect(resolveEffectiveEffort(a, undefined, undefined)).toBe('medium');
  });

  it('returns undefined when adapter has no default and no override exists', () => {
    const a = adapterWith(undefined);
    expect(resolveEffectiveEffort(a, undefined, {})).toBeUndefined();
  });
});

describe('resolveEffectiveModel', () => {
  const adapter = makeMockAdapter({ name: 'codex' });

  it('per-call wins over agents.json', () => {
    expect(
      resolveEffectiveModel(adapter, 'opus', { codex: { model: 'sonnet' } }),
    ).toBe('opus');
  });

  it('agents.json wins when no per-call value', () => {
    expect(
      resolveEffectiveModel(adapter, undefined, { codex: { model: 'sonnet' } }),
    ).toBe('sonnet');
  });

  it('returns undefined when nothing is configured (CLI default wins)', () => {
    expect(resolveEffectiveModel(adapter, undefined, {})).toBeUndefined();
    expect(resolveEffectiveModel(adapter, undefined, undefined)).toBeUndefined();
  });
});
