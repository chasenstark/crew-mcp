/**
 * M5-8 scenario 2: read-only preset refuses write-dispatches.
 *
 * The read-only hint tells the captain NOT to dispatch run_agent calls
 * that write files. A scripted captain under this preset replies with a
 * diff via `message_user` and then `finish` — no run_agent calls.
 *
 * Plumbing-level assertion: the hint reaches the system prompt, and the
 * scripted sequence completes with exactly the tools the hint allows.
 * Real-captain behavior under the hint is M5-9 smoke-matrix territory.
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

describe('E2E preset — read-only (M5-8 scenario 2)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'crew-e2e-readonly-'));
    execSync('git init -q', { cwd: projectRoot });
    execSync('git config user.email t@t', { cwd: projectRoot });
    execSync('git config user.name t', { cwd: projectRoot });
    execSync('git commit -q --allow-empty -m init', { cwd: projectRoot });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('read-only hint reaches the captain; scripted captain returns a diff without run_agent', async () => {
    const defaults = getDefaultConfig();
    const presets = defaults.presets as Record<string, PresetConfig>;
    const readOnlyHint = presets['read-only'].hint!;
    expect(readOnlyHint).toBeTruthy();

    const { adapter, probe } = createFakeCaptain({
      turns: [
        [
          {
            name: 'mcp__crew__message_user',
            input: {
              text: "Here's the diff for line 10:\n- aligment\n+ alignment\n\nApply it?",
            },
          },
          {
            name: 'mcp__crew__finish',
            input: {
              summary: 'Proposed diff for the typo on README line 10; awaiting your confirmation.',
            },
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
        defaultPresetName: 'read-only',
      },
    );

    const report = await runner.run('Fix the typo on line 10 of README.md.');
    expect(report).toContain('Proposed diff');
    expect(probe.turnCount).toBe(1);

    const hintSnippet = readOnlyHint.slice(0, 50);
    expect(systemPromptOf(probe.allMessages[0])).toContain(hintSnippet);

    // Scenario 2 acceptance: zero run_agent calls.
    const runAgentCalls = session
      .getMessages()
      .filter((m) => m.role === 'tool_call' && m.toolName === 'run_agent');
    expect(runAgentCalls).toHaveLength(0);

    const emittedByName = (name: string) =>
      probe.toolCalls.filter((c) => c.name === `mcp__crew__${name}`);
    expect(emittedByName('run_agent')).toHaveLength(0);
    // message_user + finish were the only calls.
    expect(emittedByName('message_user')).toHaveLength(1);
    expect(emittedByName('finish')).toHaveLength(1);
  });
});
