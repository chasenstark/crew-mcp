/**
 * M5-8 scenario 1: thorough-review preset fans out to at least two run_agent calls.
 *
 * Scripted fake-captain test: the captain receives a prompt whose system
 * message contains the `thorough-review` hint verbatim, and the scripted
 * sequence emits BOTH a coder run_agent AND a reviewer run_agent before
 * calling finish. This locks the plumbing contract: the preset's hint
 * reaches the captain's system prompt, and the scripted turns (which
 * simulate what a real captain would do under the hint) emit >= 2
 * run_agent calls.
 *
 * Framing: this is a plumbing-level test, not a behavioral one. A real
 * captain's behavior under the hint is M5-9's smoke matrix responsibility.
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

function makeAdapter(name: string, output: string, capabilities: string[]): AgentAdapter {
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

function systemPromptOf(messages: { role: string; content?: string }[] | undefined): string {
  if (!messages || messages.length === 0) return '';
  const sys = messages[0];
  if (sys.role !== 'system') return '';
  return sys.content ?? '';
}

describe('E2E preset — thorough-review (M5-8 scenario 1)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'crew-e2e-thorough-'));
    execSync('git init -q', { cwd: projectRoot });
    execSync('git config user.email t@t', { cwd: projectRoot });
    execSync('git config user.name t', { cwd: projectRoot });
    execSync('git commit -q --allow-empty -m init', { cwd: projectRoot });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('thorough-review hint reaches the captain and drives >=2 run_agent calls before finish', async () => {
    // Pull the REAL thorough-review preset from defaults/workflow.yaml —
    // if the hint text drifts, this test's contains() assertion catches it.
    const defaults = getDefaultConfig();
    const presets = defaults.presets as Record<string, PresetConfig>;
    const thoroughHint = presets['thorough-review'].hint!;
    expect(thoroughHint).toBeTruthy();
    expect(thoroughHint.length).toBeGreaterThan(20);

    // Scripted sequence: coder + reviewer + finish. A captain following the
    // thorough-review hint should dispatch a second reviewer; the test
    // asserts that this plumbing works (the captain's system prompt
    // carried the hint, and the three-turn sequence completes).
    const { adapter, probe } = createFakeCaptain({
      turns: [
        [{
          name: 'mcp__crew__run_agent',
          input: { agent_id: 'codex', prompt: 'add greet() helper + test' },
        }],
        [{
          name: 'mcp__crew__run_agent',
          input: { agent_id: 'claude-code', prompt: 'review the helper for regressions' },
        }],
        [{
          name: 'mcp__crew__finish',
          input: { summary: 'Helper added and reviewed for regressions.' },
        }],
      ],
    });

    const codex = makeAdapter('codex', 'helper added', ['implement']);
    const claude = makeAdapter('claude-code', 'LGTM no regressions', ['review']);
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
        defaultPresetName: 'thorough-review',
      },
    );

    const report = await runner.run(
      'Add a helper function greet(name) in src/util/greet.ts and test it.',
    );
    expect(report).toBe('Helper added and reviewed for regressions.');
    expect(probe.turnCount).toBe(3);

    // Every turn's system prompt carried the thorough-review hint verbatim.
    // The hint is dedented/folded in YAML (`>-`), so the rendered text is
    // a single-line variant; match a distinctive stable phrase.
    const hintSnippet = thoroughHint.slice(0, 50);
    expect(systemPromptOf(probe.allMessages[0])).toContain(hintSnippet);
    expect(systemPromptOf(probe.allMessages[1])).toContain(hintSnippet);
    expect(systemPromptOf(probe.allMessages[2])).toContain(hintSnippet);

    // Scenario 1 acceptance: at least two run_agent calls landed, both
    // produced tool_call records, finish came after.
    const runAgentCalls = session
      .getMessages()
      .filter((m) => m.role === 'tool_call' && m.toolName === 'run_agent');
    expect(runAgentCalls.length).toBeGreaterThanOrEqual(2);

    // Distinct runIds — each dispatch gets its own worktree.
    const toolCallIds = new Set(runAgentCalls.map((m) => m.toolCallId));
    expect(toolCallIds.size).toBe(runAgentCalls.length);

    // No stray wrapper-tool emissions from the scripted captain.
    const emittedByName = (name: string) =>
      probe.toolCalls.filter((c) => c.name === `mcp__crew__${name}`);
    expect(emittedByName('plan_tasks')).toHaveLength(0);
  });
});
