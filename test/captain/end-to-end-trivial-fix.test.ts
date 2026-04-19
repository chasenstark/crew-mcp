/**
 * M4-7: end-to-end trivial-fix — plumbing contract.
 *
 * Scripted-fake-captain test: the "fix the typo" scenario from the M4
 * exit gate. Captain emits one run_agent(codex, 'fix typo') → receives
 * the dispatcher result → emits finish. Exactly two captain turns,
 * exactly one run_agent dispatch, zero wrapper tools.
 *
 * Framing: this is a plumbing contract. The session-loop routes a
 * dispatched run_agent → tool_result → next captain turn without
 * inserting any auto-calls. Real-captain quality (whether a real LLM
 * actually chooses this shape on the typo-fix scenario) is M4-8's
 * smoke-matrix concern.
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
import type { WorkflowConfig } from '../../src/workflow/types.js';
import type { AgentRegistry } from '../../src/captain/events.js';
import type { AgentAdapter } from '../../src/adapters/types.js';
import { createFakeCaptain } from '../fixtures/captain/fake-adapter.js';

const workflow: WorkflowConfig = {
  name: 'default',
  execution: { mode: 'judgment' },
  steps: [],
  completion: { strategy: 'judge_approval', fallback: 'max_passes' },
};

function makeAdapter(name: string, output: string): AgentAdapter {
  return {
    name,
    capabilities: ['implement'],
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

describe('E2E trivial-fix (M4-7)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'crew-e2e-trivial-fix-'));
    execSync('git init -q', { cwd: projectRoot });
    execSync('git config user.email t@t', { cwd: projectRoot });
    execSync('git config user.name t', { cwd: projectRoot });
    execSync('git commit -q --allow-empty -m init', { cwd: projectRoot });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('dispatches one run_agent and finishes in 2 captain turns', async () => {
    const { adapter, probe } = createFakeCaptain({
      turns: [
        [
          {
            name: 'mcp__crew__run_agent',
            input: {
              agent_id: 'codex',
              prompt: 'fix the comment in README line 10',
            },
          },
        ],
        [
          {
            name: 'mcp__crew__finish',
            input: { summary: 'Typo fixed.' },
          },
        ],
      ],
    });
    const codex = makeAdapter('codex', 'comment fixed');
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
      { session, dispatcher },
    );

    const report = await runner.run('fix the comment in README line 10');
    expect(report).toBe('Typo fixed.');
    expect(probe.turnCount).toBe(2);

    const messages = session.getMessages();

    const runAgentCalls = messages.filter(
      (m) => m.role === 'tool_call' && m.toolName === 'run_agent',
    );
    expect(runAgentCalls).toHaveLength(1);

    // Plumbing contract (M4-7): the captain did NOT emit wrappers around
    // the single run_agent → finish flow. Synchronous inline tools don't
    // leave session.tool_call records; we read from probe.toolCalls.
    const emittedByName = (name: string) =>
      probe.toolCalls.filter((c) => c.name === `mcp__crew__${name}`);
    expect(emittedByName('plan_tasks')).toHaveLength(0);
    expect(emittedByName('analyze_output')).toHaveLength(0);
    expect(emittedByName('compress_context')).toHaveLength(0);
  });
});
