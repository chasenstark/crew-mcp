/**
 * M4-7: end-to-end moderate-feature — plumbing contract.
 *
 * Scripted-fake-captain test: the "add a feature" scenario from the M4
 * exit gate (vision-plan §6.4 "complex feature"). Captain plans via
 * plan_tasks, dispatches the first subagent, waits for its result,
 * dispatches the second subagent, waits, then finishes. Four turns
 * total (plan+run, run, finish), two run_agent dispatches.
 *
 * Plumbing contract: the fake-captain + fake-agents combo exercises the
 * full scheduler round-trip for a multi-subagent flow. The session-loop
 * must route each run_agent → dispatcher → tool_result → next captain
 * turn without injecting wrappers the captain didn't ask for.
 *
 * Real-captain quality — whether a production LLM actually produces this
 * shape on a moderate-feature request — is M4-8's smoke-matrix concern.
 * This test locks the plumbing, not the model's judgment.
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

describe('E2E moderate-feature (M4-7)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'crew-e2e-moderate-'));
    execSync('git init -q', { cwd: projectRoot });
    execSync('git config user.email t@t', { cwd: projectRoot });
    execSync('git config user.name t', { cwd: projectRoot });
    execSync('git commit -q --allow-empty -m init', { cwd: projectRoot });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('routes plan_tasks + 2 run_agents + finish in ≤5 captain turns without wrapper injections', async () => {
    const { adapter, probe } = createFakeCaptain({
      turns: [
        // Turn 1 — captain plans + dispatches the first subagent in a
        // single turn. The plan_tasks result is synchronous; the
        // run_agent dispatched flow ends the turn with a pending marker.
        [
          {
            name: 'mcp__crew__plan_tasks',
            input: {
              user_request: 'add feature X with tests + docs',
              hints: ['split coder + writer'],
            },
          },
          {
            name: 'mcp__crew__run_agent',
            input: { agent_id: 'codex', prompt: 'implement feature X' },
          },
        ],
        // Turn 2 — coder result arrives, captain dispatches the writer.
        [
          {
            name: 'mcp__crew__run_agent',
            input: { agent_id: 'claude-code', prompt: 'write docs for feature X' },
          },
        ],
        // Turn 3 — writer result arrives, captain finishes.
        [
          {
            name: 'mcp__crew__finish',
            input: { summary: 'Feature X implemented and documented.' },
          },
        ],
      ],
    });

    const codex = makeAdapter('codex', 'feature X implemented');
    const claude = makeAdapter('claude-code', 'docs written');
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

    const report = await runner.run('add feature X with tests + docs');
    expect(report).toBe('Feature X implemented and documented.');
    // The vision-plan §6.4 bar is ≤ 5 turns on moderate-feature flow. The
    // script above uses 3; any scheduler regression that injects extra
    // turns would fail here.
    expect(probe.turnCount).toBeLessThanOrEqual(5);
    expect(probe.turnCount).toBe(3);

    const messages = session.getMessages();

    // Synchronous inline tools (plan_tasks, analyze_output, compress_context,
    // finish, message_user, list_agents) don't leave session.tool_call
    // records — they resolve inside the adapter turn. Assert those via the
    // probe's toolCalls array (every call the captain emitted through
    // onToolCall).
    const emittedByName = (name: string) =>
      probe.toolCalls.filter((c) => c.name === `mcp__crew__${name}`);

    expect(emittedByName('plan_tasks')).toHaveLength(1);
    // The scripted captain emitted 2 run_agents — both go through the
    // scheduler (dispatched) and leave session.tool_call records.
    expect(emittedByName('run_agent')).toHaveLength(2);

    // Dispatched run_agents produce session.tool_call + tool_result pairs.
    const runAgentCalls = messages.filter(
      (m) => m.role === 'tool_call' && m.toolName === 'run_agent',
    );
    expect(runAgentCalls).toHaveLength(2);
    const runAgentIds = new Set(runAgentCalls.map((m) => m.toolCallId));
    expect(runAgentIds.size).toBe(2);
    const runAgentResults = messages.filter(
      (m) =>
        m.role === 'tool_result' &&
        runAgentCalls.some((c) => c.toolCallId === m.toolCallId),
    );
    expect(runAgentResults).toHaveLength(2);

    // Plumbing contract: the captain did NOT emit analyze_output or
    // compress_context. If a regression pushed the session-loop to
    // auto-wrap results, these would appear in probe.toolCalls.
    expect(emittedByName('analyze_output')).toHaveLength(0);
    expect(emittedByName('compress_context')).toHaveLength(0);
  });
});
