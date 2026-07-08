import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';
import {
  planRunAgent,
  buildAdapterDispatchTask,
  readOnlyAdvisoryWarning,
  readOnlyRejectMessage,
  crewWorktreeRejectMessage,
  resolveEffectiveEffort,
  resolveEffectiveModel,
  applyModelPreflight,
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
    enforcesReadOnly: overrides?.enforcesReadOnly ?? true,
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
      ctx,
    );
    const planB = await planRunAgent(
      { agent_id: 'codex', prompt: 'second' },
      ctx,
    );
    expect(planA.kind).toBe('dispatched');
    expect(planB.kind).toBe('dispatched');
    if (planA.kind === 'dispatched' && planB.kind === 'dispatched') {
      expect(planA.runId).not.toBe(planB.runId);
      expect(planA.worktreePath).not.toBe(planB.worktreePath);
    }
  });

  it('invokes the adapter.execute with the composed prompt + working directory', async () => {
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
      ctx,
    );
    expect(plan.kind).toBe('dispatched');
    if (plan.kind !== 'dispatched') throw new Error('expected dispatched');
    const result = await plan.buildTask('composed prompt').run({ signal: makeAbortSignal() });
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
    expect(args.prompt).toBe('composed prompt');
    expect(args.context.workingDirectory).toBe(plan.worktreePath);
    expect(args.constraints.model).toBe('preferred-model');
    expect(args.constraints.sandbox).toBe('workspace-write');
    expect(args.constraints.writablePaths).toEqual(
      worktreeManager.getRunGitCommitWritablePaths(plan.runId).paths,
    );
  });

  it('hard-fails a requested resume when a resume-capable adapter returns no session id', async () => {
    const executeMock = vi.fn<(t: unknown) => Promise<TaskResult>>(async () => ({
      output: 'looked successful',
      filesModified: [],
      status: 'success',
      metadata: {},
    }));
    const adapter = makeMockAdapter({
      name: 'codex',
      supportsResume: true,
      execute: executeMock,
    });
    const task = buildAdapterDispatchTask({
      toolCallId: 'tool-1',
      runId: 'run-1',
      adapter,
      prompt: 'composed prompt',
      effectiveWorkingDirectory: root,
      worktreePath: root,
      runMode: 'read_only',
      effectiveModel: undefined,
      effectiveEffort: undefined,
      resumeSessionId: 'thread-1',
      worktreeManager,
      input: {},
    });
    const result = await task.run({ signal: makeAbortSignal() });

    expect(result.status).toBe('error');
    expect(result.output).toContain('resume_id_missing');
    expect(result.failure).toMatchObject({
      providerCode: 'resume_id_missing',
      confidence: 'high',
      recommendation: 'ask_user',
    });
  });

  it('preserves adapter diagnostics when a requested resume returns no session id', async () => {
    const executeMock = vi.fn<(t: unknown) => Promise<TaskResult>>(async () => ({
      output: 'Codex command failed with exit code 2 and no JSONL output',
      filesModified: [],
      status: 'error',
      failure: {
        kind: 'process',
        confidence: 'low',
        rawSignal: "exit code 2\nerror: unexpected argument '--sandbox' found",
      },
      metadata: {},
    }));
    const adapter = makeMockAdapter({
      name: 'codex',
      supportsResume: true,
      execute: executeMock,
    });
    const task = buildAdapterDispatchTask({
      toolCallId: 'tool-1',
      runId: 'run-1',
      adapter,
      prompt: 'composed prompt',
      effectiveWorkingDirectory: root,
      worktreePath: root,
      runMode: 'read_only',
      effectiveModel: undefined,
      effectiveEffort: undefined,
      resumeSessionId: 'thread-1',
      worktreeManager,
      input: {},
    });
    const result = await task.run({ signal: makeAbortSignal() });

    expect(result.status).toBe('error');
    expect(result.failure?.providerCode).toBe('resume_id_missing');
    expect(result.failure?.rawSignal).toContain('resume_id_missing:');
    expect(result.failure?.rawSignal).toContain('exit code 2');
    expect(result.failure?.rawSignal).toContain("error: unexpected argument '--sandbox' found");
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
      ctx,
    );
    if (plan.kind !== 'dispatched') throw new Error('expected dispatched');

    const result = await plan.buildTask('create a file').run({ signal: makeAbortSignal() });

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

  it('unions branch-point file reporting even when adapter filesModified is reliable', async () => {
    const executeMock = vi.fn<(t: unknown) => Promise<TaskResult>>(async (task) => {
      const typedTask = task as { context: { workingDirectory: string } };
      writeFileSync(join(typedTask.context.workingDirectory, 'reliable-empty.txt'), 'changed\n', 'utf-8');
      return {
        output: 'done',
        filesModified: [],
        status: 'success',
        metadata: {},
      };
    });
    const adapter = makeMockAdapter({
      name: 'codex',
      execute: executeMock,
      filesModifiedReliable: true,
    });
    const getModifiedFilesByRun = vi.spyOn(worktreeManager, 'getModifiedFilesByRun');
    const ctx: RunAgentHandlerContext = {
      registry: makeRegistry([adapter]),
      worktreeManager,
    };
    const plan = await planRunAgent(
      { agent_id: 'codex', prompt: 'create a file' },
      ctx,
    );
    if (plan.kind !== 'dispatched') throw new Error('expected dispatched');

    const result = await plan.buildTask('create a file').run({ signal: makeAbortSignal() });

    expect(getModifiedFilesByRun).toHaveBeenCalled();
    expect(result).toMatchObject({
      output: 'done',
      filesModified: ['reliable-empty.txt'],
      status: 'success',
    });
    expect(readFileSync(join(plan.worktreePath, 'reliable-empty.txt'), 'utf-8')).toBe('changed\n');
  });

  it('does not over-report synced host dirt that the agent did not change', async () => {
    writeFileSync(join(root, 'README.md'), 'host edit before dispatch\n', 'utf-8');
    writeFileSync(join(root, 'scratch.md'), 'host untracked before dispatch\n', 'utf-8');
    const executeMock = vi.fn<(t: unknown) => Promise<TaskResult>>(async (task) => {
      const typedTask = task as { context: { workingDirectory: string } };
      writeFileSync(join(typedTask.context.workingDirectory, 'agent.txt'), 'agent edit\n', 'utf-8');
      return {
        output: 'done',
        filesModified: [],
        status: 'success',
        metadata: {},
      };
    });
    const adapter = makeMockAdapter({ name: 'claude-code', execute: executeMock });
    const ctx: RunAgentHandlerContext = {
      registry: makeRegistry([adapter]),
      worktreeManager,
    };
    const plan = await planRunAgent(
      { agent_id: 'claude-code', prompt: 'create a file' },
      ctx,
    );
    if (plan.kind !== 'dispatched') throw new Error('expected dispatched');

    const result = await plan.buildTask('create a file').run({ signal: makeAbortSignal() });

    expect(result.filesModified).toEqual(['agent.txt']);
  });

  it('does not over-report synced host dirt for reliable adapters that report no changes', async () => {
    writeFileSync(join(root, 'README.md'), 'host edit before dispatch\n', 'utf-8');
    writeFileSync(join(root, 'scratch.md'), 'host untracked before dispatch\n', 'utf-8');
    const executeMock = vi.fn<(t: unknown) => Promise<TaskResult>>(async () => ({
      output: 'done',
      filesModified: [],
      status: 'success',
      metadata: {},
    }));
    const adapter = makeMockAdapter({
      name: 'codex',
      execute: executeMock,
      filesModifiedReliable: true,
    });
    const ctx: RunAgentHandlerContext = {
      registry: makeRegistry([adapter]),
      worktreeManager,
    };
    const plan = await planRunAgent(
      { agent_id: 'codex', prompt: 'inspect only' },
      ctx,
    );
    if (plan.kind !== 'dispatched') throw new Error('expected dispatched');

    const result = await plan.buildTask('inspect only').run({ signal: makeAbortSignal() });

    expect(result.filesModified).toEqual([]);
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
      ctx,
    );
    if (plan.kind !== 'dispatched') throw new Error('expected dispatched');
    await plan.buildTask('do x').run({ signal: makeAbortSignal() });
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
      ctx,
    );
    if (plan.kind !== 'dispatched') throw new Error('expected dispatched');
    await plan.buildTask('x').run({ signal: makeAbortSignal() });
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
      ctx,
    );
    if (plan.kind !== 'dispatched') throw new Error('expected dispatched');
    expect(onStart).toHaveBeenCalledWith({
      agentName: 'codex',
      runId: plan.runId,
      worktreePath: plan.worktreePath,
    });
  });

  it('preserves the planner toolCallId in tasks built after prompt composition', async () => {
    const ctx: RunAgentHandlerContext = {
      registry: makeRegistry([makeMockAdapter({ name: 'codex' })]),
      worktreeManager,
    };
    const plan = await planRunAgent(
      { agent_id: 'codex', prompt: 'do x' },
      ctx,
    );
    if (plan.kind !== 'dispatched') throw new Error('expected dispatched');
    const task = plan.buildTask('composed after state create');
    expect(task.toolCallId).toBe(plan.toolCallId);
    expect(task.runId).toBe(plan.runId);
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
      ctx,
    );
    if (plan.kind !== 'dispatched') throw new Error('expected dispatched');
    await plan.buildTask('go').run({ signal: makeAbortSignal(), onStream: () => undefined });
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
      ctx,
    );
    if (plan.kind !== 'dispatched') throw new Error('expected dispatched');

    await plan.buildTask('commit from the run worktree').run({
      signal: makeAbortSignal(),
      onStream: () => undefined,
    });

    const expected = worktreeManager.getRunGitCommitWritablePaths(plan.runId);
    expect(observedWritablePaths).toEqual(expected.paths);
    expect(observedWritablePaths).toContain(expected.worktreeGitDir);
    expect(observedWritablePaths).toContain(expected.objectsDir);
    expect(observedWritablePaths).toContain(expected.branchRefsDir);
    expect(observedWritablePaths).toContain(expected.branchLogsDir);
    expect(observedWritablePaths).not.toContain(join(root, '.git'));
  });
});

describe('planRunAgent — agy scratch-escape guard', () => {
  let root: string;
  let crewHome: string;
  let worktreeManager: WorktreeManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'crew-agy-escape-'));
    crewHome = mkdtempSync(join(tmpdir(), 'crew-agy-escape-home-'));
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

  it('warns when agy reports a write but the worktree has no changes (scratch escape)', async () => {
    // agy claims it wrote a file, but nothing landed in the worktree — the
    // classic silent escape to agy's scratch dir. The guard must surface it
    // rather than let the empty diff read as a clean success.
    const executeMock = vi.fn<(t: unknown) => Promise<TaskResult>>(async () => ({
      output: 'I have successfully created the file config.txt with the requested content.',
      filesModified: [],
      status: 'success',
      metadata: {},
    }));
    const adapter = makeMockAdapter({ name: 'agy', execute: executeMock, filesModifiedReliable: false });
    const ctx: RunAgentHandlerContext = {
      registry: makeRegistry([adapter]),
      worktreeManager,
    };
    const plan = await planRunAgent({ agent_id: 'agy', prompt: 'create config.txt' }, ctx);
    if (plan.kind !== 'dispatched') throw new Error('expected dispatched');

    const result = await plan.buildTask('create config.txt').run({ signal: makeAbortSignal() });

    expect(result.status).toBe('success');
    expect(result.filesModified).toEqual([]);
    expect(result.warnings?.some((w) => /scratch/i.test(w))).toBe(true);
  });

  it('does NOT warn when agy actually wrote into the worktree', async () => {
    const executeMock = vi.fn<(t: unknown) => Promise<TaskResult>>(async (task) => {
      const typedTask = task as { context: { workingDirectory: string } };
      writeFileSync(join(typedTask.context.workingDirectory, 'config.txt'), 'landed\n', 'utf-8');
      return {
        output: 'I have successfully created config.txt.',
        filesModified: [],
        status: 'success',
        metadata: {},
      };
    });
    const adapter = makeMockAdapter({ name: 'agy', execute: executeMock, filesModifiedReliable: false });
    const ctx: RunAgentHandlerContext = {
      registry: makeRegistry([adapter]),
      worktreeManager,
    };
    const plan = await planRunAgent({ agent_id: 'agy', prompt: 'create config.txt' }, ctx);
    if (plan.kind !== 'dispatched') throw new Error('expected dispatched');

    const result = await plan.buildTask('create config.txt').run({ signal: makeAbortSignal() });

    expect(result.filesModified).toEqual(['config.txt']);
    expect(result.warnings?.some((w) => /scratch/i.test(w))).toBeFalsy();
  });

  it('does NOT warn on an honest no-op agy run whose output claims no writes', async () => {
    const executeMock = vi.fn<(t: unknown) => Promise<TaskResult>>(async () => ({
      output: 'The code already handles this case; no changes were necessary.',
      filesModified: [],
      status: 'success',
      metadata: {},
    }));
    const adapter = makeMockAdapter({ name: 'agy', execute: executeMock, filesModifiedReliable: false });
    const ctx: RunAgentHandlerContext = {
      registry: makeRegistry([adapter]),
      worktreeManager,
    };
    const plan = await planRunAgent({ agent_id: 'agy', prompt: 'check if a fix is needed' }, ctx);
    if (plan.kind !== 'dispatched') throw new Error('expected dispatched');

    const result = await plan.buildTask('check if a fix is needed').run({ signal: makeAbortSignal() });

    expect(result.warnings?.some((w) => /scratch/i.test(w))).toBeFalsy();
  });

  it('does NOT warn for a non-agy adapter with a write-like empty result', async () => {
    // The guard is agy-scoped: another adapter's honest no-op must not be
    // second-guessed just because its prose contains a write verb.
    const executeMock = vi.fn<(t: unknown) => Promise<TaskResult>>(async () => ({
      output: 'I updated my understanding but made no file changes.',
      filesModified: [],
      status: 'success',
      metadata: {},
    }));
    const adapter = makeMockAdapter({ name: 'codex', execute: executeMock, filesModifiedReliable: false });
    const ctx: RunAgentHandlerContext = {
      registry: makeRegistry([adapter]),
      worktreeManager,
    };
    const plan = await planRunAgent({ agent_id: 'codex', prompt: 'inspect' }, ctx);
    if (plan.kind !== 'dispatched') throw new Error('expected dispatched');

    const result = await plan.buildTask('inspect').run({ signal: makeAbortSignal() });

    expect(result.warnings?.some((w) => /scratch/i.test(w))).toBeFalsy();
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

    await plan.buildTask('just look').run({ signal: makeAbortSignal(), onStream: () => undefined });
    expect(observedWorkingDir).toBe(root);
  });

  it('runs read_only on non-enforcing adapters with a loud advisory warning', async () => {
    const adapter = makeMockAdapter({
      name: 'claude-code',
      enforcesReadOnly: false,
      execute: async () => ({
        output: 'reviewed',
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
      { agent_id: 'claude-code', prompt: 'just review', read_only: true },
      ctx,
    );
    if (plan.kind !== 'dispatched') throw new Error('expected dispatched');
    expect(plan.dispatchWarnings).toEqual([
      expect.stringContaining('read_only advisory: adapter "claude-code" does not enforce'),
    ]);

    const result = await plan.buildTask('just review').run({
      signal: makeAbortSignal(),
      onStream: () => undefined,
    }) as TaskResult;
    expect(result.status).toBe('success');
    expect(result.warnings).toEqual([
      expect.stringContaining('read_only advisory: adapter "claude-code" does not enforce'),
    ]);
  });

  it('runs read_only on enforcing adapters without an advisory warning', async () => {
    const adapter = makeMockAdapter({
      name: 'codex',
      enforcesReadOnly: true,
      execute: async (task) => ({
        output: task.constraints?.sandbox ?? '',
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
      { agent_id: 'codex', prompt: 'just review', read_only: true },
      ctx,
    );
    if (plan.kind !== 'dispatched') throw new Error('expected dispatched');
    expect(plan.dispatchWarnings).toEqual([]);

    const result = await plan.buildTask('just review').run({
      signal: makeAbortSignal(),
      onStream: () => undefined,
    }) as TaskResult;
    expect(result.output).toBe('read-only');
    expect(result.warnings).toBeUndefined();
  });

  it('readOnlyAdvisoryWarning names the adapter in the generic advisory', () => {
    const claude = readOnlyAdvisoryWarning('claude-code');
    expect(claude).toContain('adapter "claude-code"');
    expect(claude).toContain('does not enforce a read-only filesystem sandbox');
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
      ctx,
    );
    if (plan.kind !== 'dispatched') throw new Error('expected dispatched');
    expect(plan.worktreePath).toBe(target);
    await plan.buildTask('p').run({ signal: makeAbortSignal(), onStream: () => undefined });
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
      ctx,
    );
    if (plan.kind !== 'dispatched') throw new Error('expected dispatched');
    const result = await plan.buildTask('just review').run({
      signal: makeAbortSignal(),
      onStream: () => undefined,
    }) as TaskResult;
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
      ctx,
    );
    if (plan.kind !== 'dispatched') throw new Error('expected dispatched');
    const result = await plan.buildTask('review').run({
      signal: makeAbortSignal(),
      onStream: () => undefined,
    }) as TaskResult;
    expect(result.warnings).toBeUndefined();
  });

  // Regression: the dirty-tree probe used to report every dirty file
  // in the host repo as an agent contract violation, even though those
  // files were already dirty before the dispatch. Both review-style
  // crew runs in 2026-05-11 surfaced this as a false-positive warning
  // listing files the reviewer never touched. The probe now snapshots
  // pre-dispatch and diffs post.
  it('ignores host-repo dirt that pre-existed the dispatch', async () => {
    // Seed: the host repo already has a modified tracked file and an
    // untracked file BEFORE the read-only run starts.
    writeFileSync(join(root, 'README.md'), 'user was editing\n', 'utf-8');
    writeFileSync(join(root, 'scratch.md'), 'untracked draft\n', 'utf-8');
    const adapter = makeMockAdapter({
      name: 'reviewer',
      execute: async () => ({
        output: 'looked, touched nothing',
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
      ctx,
    );
    if (plan.kind !== 'dispatched') throw new Error('expected dispatched');
    const result = await plan.buildTask('review').run({
      signal: makeAbortSignal(),
      onStream: () => undefined,
    }) as TaskResult;
    expect(result.warnings).toBeUndefined();
  });

  it('warns only on agent-introduced changes when host repo started dirty', async () => {
    // Seed: pre-existing dirt the agent does not own.
    writeFileSync(join(root, 'README.md'), 'user-in-flight\n', 'utf-8');
    writeFileSync(join(root, 'scratch.md'), 'pre-existing untracked\n', 'utf-8');
    const adapter = makeMockAdapter({
      name: 'reviewer',
      execute: async (task) => {
        // Reviewer breaks contract: writes one new file. README.md and
        // scratch.md are already dirty but not from the agent.
        const cwd = (task as { context: { workingDirectory: string } }).context.workingDirectory;
        writeFileSync(join(cwd, 'leaked.md'), 'agent wrote this\n', 'utf-8');
        return { output: 'broke contract', filesModified: [], status: 'success', metadata: {} };
      },
    });
    const ctx: RunAgentHandlerContext = {
      registry: makeRegistry([adapter]),
      worktreeManager,
    };
    const plan = await planRunAgent(
      { agent_id: 'reviewer', prompt: 'review', read_only: true },
      ctx,
    );
    if (plan.kind !== 'dispatched') throw new Error('expected dispatched');
    const result = await plan.buildTask('review').run({
      signal: makeAbortSignal(),
      onStream: () => undefined,
    }) as TaskResult;
    expect(result.warnings).toBeDefined();
    expect(result.warnings?.length).toBe(1);
    // Warning names the agent-introduced file, NOT the pre-existing
    // dirt the user was already editing.
    expect(result.warnings?.[0]).toMatch(/leaked\.md/);
    expect(result.warnings?.[0]).not.toMatch(/README\.md/);
    expect(result.warnings?.[0]).not.toMatch(/scratch\.md/);
    // Cleanup so afterEach is well-behaved.
    rmSync(join(root, 'leaked.md'), { force: true });
  });

  it('detects when a read-only agent edits a file that was already dirty before dispatch', async () => {
    writeFileSync(join(root, 'README.md'), 'user-in-flight\n', 'utf-8');
    const adapter = makeMockAdapter({
      name: 'reviewer',
      execute: async (task) => {
        const cwd = (task as { context: { workingDirectory: string } }).context.workingDirectory;
        writeFileSync(join(cwd, 'README.md'), 'agent changed preexisting dirt\n', 'utf-8');
        return { output: 'broke contract', filesModified: [], status: 'success', metadata: {} };
      },
    });
    const ctx: RunAgentHandlerContext = {
      registry: makeRegistry([adapter]),
      worktreeManager,
    };
    const plan = await planRunAgent(
      { agent_id: 'reviewer', prompt: 'review', read_only: true },
      ctx,
    );
    if (plan.kind !== 'dispatched') throw new Error('expected dispatched');
    const result = await plan.buildTask('review').run({
      signal: makeAbortSignal(),
      onStream: () => undefined,
    }) as TaskResult;

    expect(result.warnings).toEqual([
      expect.stringContaining('README.md'),
    ]);
  });
});

describe('resolveEffectiveEffort', () => {
  function adapterWith(
    defaultEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max',
    supportedEfforts?: readonly ('low' | 'medium' | 'high' | 'xhigh' | 'max')[],
  ): AgentAdapter {
    return makeMockAdapter({ name: 'codex', defaultEffort, supportedEfforts });
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

  it('clamps per-call max down to xhigh when adapter declares supportedEfforts', () => {
    // Codex 0.130 rejects `max` with an `unknown variant` error. The
    // captain should be able to pass canonical `max` without knowing
    // that; resolveEffectiveEffort silently maps to the nearest
    // supported level (`xhigh`).
    const a = adapterWith('medium', ['low', 'medium', 'high', 'xhigh']);
    expect(resolveEffectiveEffort(a, 'max', undefined)).toBe('xhigh');
  });

  it('clamps agents.json override above adapter supported set', () => {
    const a = adapterWith('medium', ['low', 'medium', 'high', 'xhigh']);
    expect(resolveEffectiveEffort(a, undefined, { codex: { effort: 'max' } })).toBe('xhigh');
  });

  it('leaves supported levels untouched', () => {
    const a = adapterWith('medium', ['low', 'medium', 'high', 'xhigh']);
    expect(resolveEffectiveEffort(a, 'xhigh', undefined)).toBe('xhigh');
    expect(resolveEffectiveEffort(a, 'low', undefined)).toBe('low');
  });

  it('does not clamp when adapter omits supportedEfforts (no constraint)', () => {
    const a = adapterWith('medium');
    expect(resolveEffectiveEffort(a, 'max', undefined)).toBe('max');
  });
});

describe('planRunAgent fail-closed capability rejects (agy)', () => {
  let root: string;
  let crewHome: string;
  let worktreeManager: WorktreeManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'crew-run-agent-reject-'));
    crewHome = mkdtempSync(join(tmpdir(), 'crew-run-agent-reject-home-'));
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

  function ctxWith(adapter: AgentAdapter): RunAgentHandlerContext {
    return { registry: makeRegistry([adapter]), worktreeManager };
  }

  it('hard-rejects a read-only dispatch for a rejectsReadOnly adapter — fail-closed, no advisory', async () => {
    const execute = vi.fn();
    const agy = makeMockAdapter({
      name: 'agy',
      enforcesReadOnly: false,
      rejectsReadOnly: true,
      execute: execute as never,
    });
    const plan = await planRunAgent(
      { agent_id: 'agy', prompt: 'review this', read_only: true },
      ctxWith(agy),
    );
    expect(plan.kind).toBe('error');
    if (plan.kind === 'error') {
      expect(plan.message).toBe(readOnlyRejectMessage('agy'));
      // The contradictory "Crew will run it anyway" advisory must NOT appear.
      expect(plan.message).not.toContain('run it anyway');
    }
    // Refused before any dispatch — the adapter never executed.
    expect(execute).not.toHaveBeenCalled();
  });

  it('still emits the advisory (not a reject) for a non-rejecting read-only adapter', async () => {
    const generic = makeMockAdapter({ name: 'gen', enforcesReadOnly: false });
    const plan = await planRunAgent(
      { agent_id: 'gen', prompt: 'review', read_only: true },
      ctxWith(generic),
    );
    expect(plan.kind).toBe('dispatched');
    if (plan.kind === 'dispatched') {
      expect(plan.dispatchWarnings).toContain(readOnlyAdvisoryWarning('gen'));
    }
  });

  it('refuses a write-mode working_directory override for a requiresCrewWorktree adapter', async () => {
    const agy = makeMockAdapter({ name: 'agy', requiresCrewWorktree: true });
    const plan = await planRunAgent(
      { agent_id: 'agy', prompt: 'implement', working_directory: '/somewhere/else' },
      ctxWith(agy),
    );
    expect(plan.kind).toBe('error');
    if (plan.kind === 'error') {
      expect(plan.message).toBe(crewWorktreeRejectMessage('agy', '/somewhere/else'));
    }
  });

  it('allows a write-mode dispatch with no working_directory override (fresh worktree)', async () => {
    const agy = makeMockAdapter({ name: 'agy', requiresCrewWorktree: true });
    const plan = await planRunAgent(
      { agent_id: 'agy', prompt: 'implement' },
      ctxWith(agy),
    );
    expect(plan.kind).toBe('dispatched');
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

describe('applyModelPreflight', () => {
  it('passes recognized models through untouched', () => {
    const adapter = makeMockAdapter({
      name: 'codex',
      recognizesModel: (m) => m.startsWith('gpt-'),
    });
    expect(applyModelPreflight(adapter, 'gpt-5.3-codex')).toEqual({ model: 'gpt-5.3-codex' });
  });

  it('drops unrecognized models and warns', () => {
    const adapter = makeMockAdapter({
      name: 'codex',
      recognizesModel: (m) => m.startsWith('gpt-'),
    });
    const result = applyModelPreflight(adapter, 'sonnnet');
    expect(result.model).toBeUndefined();
    expect(result.warning).toContain('model preflight');
    expect(result.warning).toContain('agent "codex"');
    expect(result.warning).toContain('"sonnnet"');
    expect(result.warning).toContain("CLI's default model");
  });

  it('adds the exact-label hint for agy', () => {
    const adapter = makeMockAdapter({
      name: 'agy',
      recognizesModel: () => false,
    });
    const result = applyModelPreflight(adapter, 'Gemini 3.1 Pro');
    expect(result.model).toBeUndefined();
    expect(result.warning).toContain('exact labels');
  });

  it('skips the check when the adapter has no matcher or no model resolved', () => {
    const noMatcher = makeMockAdapter({ name: 'generic-x' });
    expect(applyModelPreflight(noMatcher, 'anything-goes')).toEqual({ model: 'anything-goes' });

    const withMatcher = makeMockAdapter({ name: 'codex', recognizesModel: () => false });
    expect(applyModelPreflight(withMatcher, undefined)).toEqual({ model: undefined });
  });
});

describe('planRunAgent — model preflight', () => {
  let worktreeManager: WorktreeManager;
  let tmpRepo: string;
  let crewHome: string;

  beforeEach(() => {
    tmpRepo = mkdtempSync(join(tmpdir(), 'crew-preflight-'));
    crewHome = mkdtempSync(join(tmpdir(), 'crew-preflight-home-'));
    execSync('git init -q', { cwd: tmpRepo });
    execSync('git config user.email test@crew.local', { cwd: tmpRepo });
    execSync('git config user.name test', { cwd: tmpRepo });
    writeFileSync(join(tmpRepo, 'README.md'), 'init\n', 'utf-8');
    execSync('git add README.md', { cwd: tmpRepo });
    execSync('git commit -q -m init', { cwd: tmpRepo });
    worktreeManager = new WorktreeManager({ projectRoot: tmpRepo, crewHome });
  });

  afterEach(() => {
    rmSync(tmpRepo, { recursive: true, force: true });
    rmSync(crewHome, { recursive: true, force: true });
  });

  it('unrecognized pinned model → dispatch proceeds modelless with the preflight warning', async () => {
    let observedConstraints: Record<string, unknown> | undefined;
    const adapter = makeMockAdapter({
      name: 'strict-labels',
      recognizesModel: (m) => m === 'Known Label',
      execute: async (task) => {
        observedConstraints = task.constraints as Record<string, unknown>;
        return { output: 'done', filesModified: [], status: 'success', metadata: {} };
      },
    });
    const ctx: RunAgentHandlerContext = {
      registry: makeRegistry([adapter]),
      worktreeManager,
    };
    const plan = await planRunAgent(
      { agent_id: 'strict-labels', prompt: 'go', model: 'Unknown Label' },
      ctx,
    );
    if (plan.kind !== 'dispatched') throw new Error('expected dispatched');
    expect(plan.dispatchWarnings).toEqual([
      expect.stringContaining('model preflight: agent "strict-labels" does not recognize model "Unknown Label"'),
    ]);

    await plan.buildTask('go').run({ signal: makeAbortSignal(), onStream: () => undefined });
    expect(observedConstraints?.model).toBeUndefined();
  });

  it('recognized pinned model reaches the adapter with no warning', async () => {
    let observedConstraints: Record<string, unknown> | undefined;
    const adapter = makeMockAdapter({
      name: 'strict-labels',
      recognizesModel: (m) => m === 'Known Label',
      execute: async (task) => {
        observedConstraints = task.constraints as Record<string, unknown>;
        return { output: 'done', filesModified: [], status: 'success', metadata: {} };
      },
    });
    const ctx: RunAgentHandlerContext = {
      registry: makeRegistry([adapter]),
      worktreeManager,
    };
    const plan = await planRunAgent(
      { agent_id: 'strict-labels', prompt: 'go', model: 'Known Label' },
      ctx,
    );
    if (plan.kind !== 'dispatched') throw new Error('expected dispatched');
    expect(plan.dispatchWarnings).toEqual([]);

    await plan.buildTask('go').run({ signal: makeAbortSignal(), onStream: () => undefined });
    expect(observedConstraints?.model).toBe('Known Label');
  });

  it('preflights the agents.json model too, not just per-call pins', async () => {
    const adapter = makeMockAdapter({
      name: 'strict-labels',
      recognizesModel: (m) => m === 'Known Label',
    });
    const ctx: RunAgentHandlerContext = {
      registry: makeRegistry([adapter]),
      worktreeManager,
      agentPrefs: { 'strict-labels': { model: 'Stale Label' } },
    };
    const plan = await planRunAgent(
      { agent_id: 'strict-labels', prompt: 'go' },
      ctx,
    );
    if (plan.kind !== 'dispatched') throw new Error('expected dispatched');
    expect(plan.dispatchWarnings).toEqual([
      expect.stringContaining('"Stale Label"'),
    ]);
  });
});
