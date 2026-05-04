import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import {
  planRunAgent,
  type RunAgentHandlerContext,
} from '../../../src/orchestrator/tools/run-agent.js';
import type { AdapterRegistry } from '../../../src/adapters/registry.js';
import type { AgentAdapter, TaskResult } from '../../../src/adapters/types.js';
import { WorktreeManager } from '../../../src/git/worktree.js';

function makeMockAdapter(overrides?: Partial<AgentAdapter>): AgentAdapter {
  const adapter: AgentAdapter = {
    name: overrides?.name ?? 'mock',
    capabilities: overrides?.capabilities ?? ['analyze'],
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
      resolveModel: () => 'preferred-model',
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
      constraints: { model?: string };
    };
    expect(args.prompt).toBe('fix the typo');
    expect(args.context.workingDirectory).toBe(plan.worktreePath);
    expect(args.constraints.model).toBe('preferred-model');
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

  it('overrides resolveModel when the caller supplies model in the input', async () => {
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
      resolveModel: () => 'preferred-model',
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
});
