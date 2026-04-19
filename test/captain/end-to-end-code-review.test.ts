/**
 * M3-13: end-to-end code-review. User asks for a fix + review. Captain
 * emits run_agent(codex, 'fix typo') → waits → run_agent(claude-code,
 * 'review') → waits → finish. Two distinct runIds, two worktrees,
 * cleaned up via the dispatcher's terminal-event listener.
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

describe('E2E code-review (M3-13)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'crew-e2e-review-'));
    execSync('git init -q', { cwd: projectRoot });
    execSync('git config user.email t@t', { cwd: projectRoot });
    execSync('git config user.name t', { cwd: projectRoot });
    execSync('git commit -q --allow-empty -m init', { cwd: projectRoot });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('dispatches fix + review via two distinct runIds and worktrees, then finishes', async () => {
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

    const codex = makeAdapter('codex', 'typo fixed');
    const claude = makeAdapter('claude-code', 'LGTM');
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
      { session, dispatcher },
    );

    const report = await runner.run('fix + review README typo');
    expect(report).toBe('Fix applied and reviewed.');
    // Captain emitted 3 turns: two run_agents (each its own turn after
    // dispatched result arrives) and a finish turn.
    expect(probe.turnCount).toBe(3);

    const runAgentCalls = session
      .getMessages()
      .filter((m) => m.role === 'tool_call' && m.toolName === 'run_agent');
    expect(runAgentCalls).toHaveLength(2);
    const runAgentIds = new Set(runAgentCalls.map((m) => m.toolCallId));
    expect(runAgentIds.size).toBe(2); // distinct toolCallIds

    // Each run_agent produced a tool_result (from dispatcher's run:complete).
    const runAgentResults = session
      .getMessages()
      .filter(
        (m) =>
          m.role === 'tool_result' &&
          runAgentCalls.some((c) => c.toolCallId === m.toolCallId),
      );
    expect(runAgentResults).toHaveLength(2);
  });
});
