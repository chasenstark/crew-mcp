/**
 * M5-8 scenario 3: default preset behavior is unchanged vs M4-7.
 *
 * Regression comparator. The M4-7 plumbing E2Es asserted turn counts and
 * run_agent counts without any preset plumbing hooked up. M5-1 unmasked
 * the `default` preset's hint in the captain's system prompt — this test
 * confirms that under an EXPLICITLY `default`-presetted config, the same
 * trivial / code-review / moderate-feature plumbing contracts hold.
 *
 * The default hint is soft-policy prose ("call finish when done", etc.);
 * it should not alter deterministic scripted-captain behavior.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';
import { JudgmentRunner } from '../../src/captain/judgment-runner.js';
import { StateStore } from '../../src/state/store.js';
import { WorktreeManager } from '../../src/git/worktree.js';
import { CaptainSession } from '../../src/captain/session.js';
import { ToolDispatcher } from '../../src/captain/tool-dispatcher.js';
import type { PresetConfig, WorkflowConfig } from '../../src/workflow/types.js';
import type { AgentRegistry } from '../../src/captain/events.js';
import type { AgentAdapter } from '../../src/adapters/types.js';
import { createFakeCaptain } from '../fixtures/captain/fake-adapter.js';
import { getDefaultConfig } from '../../src/workflow/config-codec.js';

const workflow: WorkflowConfig = {
  name: 'default',
  execution: { mode: 'judgment' },
  steps: [],
  completion: { strategy: 'judge_approval', fallback: 'max_passes' },
};

function makeAdapter(name: string, output: string, capabilities: string[] = ['implement']): AgentAdapter {
  return {
    name,
    capabilities,
    supportsJsonSchema: false,
    execute: async () => ({
      output,
      filesModified: [],
      status: 'success',
      metadata: {},
    }),
    healthCheck: async () => ({ available: true, authenticated: true }),
  };
}

function makeRegistry(adapters: AgentAdapter[]): AgentRegistry {
  const map = new Map(adapters.map((a) => [a.name, a]));
  return {
    get: (name) => map.get(name),
    list: () =>
      Array.from(map.values()).map((a) => ({
        name: a.name,
        capabilities: [...a.capabilities] as string[],
      })),
  };
}

describe('E2E preset — default regression comparator (M5-8 scenario 3)', () => {
  let projectRoot: string;
  let presets: Record<string, PresetConfig>;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'crew-e2e-default-preset-'));
    execSync('git init -q', { cwd: projectRoot });
    execSync('git config user.email t@t', { cwd: projectRoot });
    execSync('git config user.name t', { cwd: projectRoot });
    execSync('git commit -q --allow-empty -m init', { cwd: projectRoot });
    presets = getDefaultConfig().presets as Record<string, PresetConfig>;
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('trivial fix under default preset: one turn, zero run_agent calls (matches M4-7 trivial contract)', async () => {
    const { adapter, probe } = createFakeCaptain({
      turns: [
        [
          {
            name: 'mcp__crew__message_user',
            input: { text: 'This repo is a multi-agent crew orchestration tool.' },
          },
          {
            name: 'mcp__crew__finish',
            input: { summary: 'Repo purpose: multi-agent crew orchestrator.' },
          },
        ],
      ],
    });
    const stateStore = new StateStore(projectRoot);
    const worktreeManager = new WorktreeManager(projectRoot);
    const session = CaptainSession.create({ projectRoot });
    const dispatcher = new ToolDispatcher();
    const runner = new JudgmentRunner(
      adapter,
      makeRegistry([adapter]),
      workflow,
      stateStore,
      worktreeManager,
      {
        session,
        dispatcher,
        presets,
        defaultPresetName: 'default',
      },
    );

    const report = await runner.run('what is this repo?');
    expect(report).toBe('Repo purpose: multi-agent crew orchestrator.');
    expect(probe.turnCount).toBe(1);

    const runAgentCalls = session
      .getMessages()
      .filter((m) => m.role === 'tool_call' && m.toolName === 'run_agent');
    expect(runAgentCalls).toHaveLength(0);
  });

  it('code-review under default preset: exactly two run_agent dispatches + finish (matches M4-7 code-review contract)', async () => {
    const { adapter, probe } = createFakeCaptain({
      turns: [
        [
          {
            name: 'mcp__crew__run_agent',
            input: { agent_id: 'codex', prompt: 'fix typo on README line 10' },
          },
        ],
        [
          {
            name: 'mcp__crew__run_agent',
            input: { agent_id: 'claude-code', prompt: 'review the fix' },
          },
        ],
        [
          {
            name: 'mcp__crew__finish',
            input: { summary: 'Fix applied and reviewed.' },
          },
        ],
      ],
    });
    const codex = makeAdapter('codex', 'typo fixed', ['implement']);
    const claude = makeAdapter('claude-code', 'LGTM', ['review']);
    const stateStore = new StateStore(projectRoot);
    const worktreeManager = new WorktreeManager(projectRoot);
    const session = CaptainSession.create({ projectRoot });
    const dispatcher = new ToolDispatcher();
    const runner = new JudgmentRunner(
      adapter,
      makeRegistry([adapter, codex, claude]),
      workflow,
      stateStore,
      worktreeManager,
      {
        session,
        dispatcher,
        presets,
        defaultPresetName: 'default',
      },
    );

    const report = await runner.run('fix + review README typo');
    expect(report).toBe('Fix applied and reviewed.');
    expect(probe.turnCount).toBe(3);

    const runAgentCalls = session
      .getMessages()
      .filter((m) => m.role === 'tool_call' && m.toolName === 'run_agent');
    expect(runAgentCalls).toHaveLength(2);
  });

  it('under default preset, no stray wrapper-tool dispatches (plumbing contract)', async () => {
    const { adapter, probe } = createFakeCaptain({
      turns: [
        [
          {
            name: 'mcp__crew__run_agent',
            input: { agent_id: 'codex', prompt: 'do work' },
          },
        ],
        [
          { name: 'mcp__crew__finish', input: { summary: 'work done' } },
        ],
      ],
    });
    const codex = makeAdapter('codex', 'work done', ['implement']);
    const stateStore = new StateStore(projectRoot);
    const worktreeManager = new WorktreeManager(projectRoot);
    const session = CaptainSession.create({ projectRoot });
    const dispatcher = new ToolDispatcher();
    const runner = new JudgmentRunner(
      adapter,
      makeRegistry([adapter, codex]),
      workflow,
      stateStore,
      worktreeManager,
      {
        session,
        dispatcher,
        presets,
        defaultPresetName: 'default',
      },
    );
    await runner.run('do work');
    const emittedByName = (name: string) =>
      probe.toolCalls.filter((c) => c.name === `mcp__crew__${name}`);
    expect(emittedByName('plan_tasks')).toHaveLength(0);
    expect(emittedByName('analyze_output')).toHaveLength(0);
    expect(emittedByName('compress_context')).toHaveLength(0);
  });
});
