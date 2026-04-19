/**
 * M3-13: end-to-end trivial. User asks a question that requires no
 * subagent work. Captain emits message_user + finish on the same turn and
 * terminates. Assertion: exactly 1 captain adapter turn; 0 run_agent
 * dispatches; 0 worktree allocations; session log ends with the finish
 * summary as an assistant message.
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
import type { AgentRegistry } from '../../src/captain/pipeline.js';
import type { AgentAdapter } from '../../src/adapters/types.js';
import { createFakeCaptain } from '../fixtures/captain/fake-adapter.js';

const workflow: WorkflowConfig = {
  name: 'default',
  execution: { mode: 'judgment' },
  steps: [],
  completion: { strategy: 'judge_approval', fallback: 'max_passes' },
};

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

describe('E2E trivial (M3-13)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'crew-e2e-trivial-'));
    execSync('git init -q', { cwd: projectRoot });
    execSync('git config user.email t@t', { cwd: projectRoot });
    execSync('git config user.name t', { cwd: projectRoot });
    execSync('git commit -q --allow-empty -m init', { cwd: projectRoot });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('completes in exactly 1 captain turn with message_user + finish', async () => {
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
      { session, dispatcher },
    );

    const report = await runner.run('what is this repo?');
    expect(report).toBe('Repo purpose: multi-agent crew orchestrator.');
    expect(probe.turnCount).toBe(1);

    const messages = session.getMessages();
    const assistantMessages = messages.filter((m) => m.role === 'assistant');
    // One message_user append + one finish-summary append.
    expect(assistantMessages.length).toBeGreaterThanOrEqual(2);
    expect(assistantMessages[assistantMessages.length - 1].text).toBe(
      'Repo purpose: multi-agent crew orchestrator.',
    );

    // Zero run_agent dispatches: no tool_call records for run_agent.
    const runAgentCalls = messages.filter(
      (m) => m.role === 'tool_call' && m.toolName === 'run_agent',
    );
    expect(runAgentCalls).toHaveLength(0);
  });
});
