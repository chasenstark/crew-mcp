/**
 * M3-13 / M4-7: end-to-end trivial — plumbing contract.
 *
 * Scripted-fake-captain test: replays a pre-authored turn sequence through
 * the session-loop and asserts plumbing invariants (no extra calls snuck
 * in, turn counts match the script). Does NOT validate that real LLMs
 * produce that sequence — a scripted captain passing
 * `expect(...wrapper calls...).toHaveLength(0)` is tautological until a
 * real captain runs through the same scenario. Real-captain quality is
 * the job of M4-8's smoke matrix.
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

    // Plumbing contract (M4-7): the captain did NOT emit plan_tasks /
    // analyze_output / compress_context. Synchronous inline tools don't
    // leave session.tool_call records, so we read the emitted-call
    // history from probe.toolCalls (every call the fake captain sent to
    // onToolCall across all turns).
    const emittedByName = (name: string) =>
      probe.toolCalls.filter((c) => c.name === `mcp__crew__${name}`);
    expect(emittedByName('plan_tasks')).toHaveLength(0);
    expect(emittedByName('analyze_output')).toHaveLength(0);
    expect(emittedByName('compress_context')).toHaveLength(0);
  });
});
