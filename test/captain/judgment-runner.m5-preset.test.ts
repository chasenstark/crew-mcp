/**
 * M5-6: per-turn preset resolution integration test.
 *
 * Scripts a 3-turn sequence and flips the active preset between turns,
 * asserting the captain's system prompt on each turn reflects the
 * current resolution (session.activePreset > config.captain.preset >
 * nothing). Also covers M5-7's "removed preset" fallback — the session's
 * stored name is preserved for re-materialization even when the
 * referenced preset has been dropped from the config.
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
import { logger } from '../../src/utils/logger.js';
import { vi } from 'vitest';
import { __resetPresetWarnLatchForTest } from '../../src/captain/preset-resolver.js';

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

const presets: Record<string, PresetConfig> = {
  default: {
    name: 'default',
    hint: '[preset=default] — verbatim default hint text',
  },
  'thorough-review': {
    name: 'thorough-review',
    hint: '[preset=thorough-review] — always dispatch a second reviewer',
  },
};

describe('JudgmentRunner per-turn preset resolution (M5-6)', () => {
  let projectRoot: string;

  beforeEach(() => {
    __resetPresetWarnLatchForTest();
    projectRoot = mkdtempSync(join(tmpdir(), 'crew-m5-preset-'));
    execSync('git init -q', { cwd: projectRoot });
    execSync('git config user.email t@t', { cwd: projectRoot });
    execSync('git config user.name t', { cwd: projectRoot });
    execSync('git commit -q --allow-empty -m init', { cwd: projectRoot });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  /**
   * Drive a single turn with a scripted fake captain, returning the
   * system prompt that the adapter received. The scripted turn emits one
   * `finish` call so the session-loop exits cleanly after one turn.
   */
  async function runSingleTurnAndCaptureSystemPrompt(args: {
    session: CaptainSession;
    presets: Record<string, PresetConfig>;
    defaultPresetName?: string;
  }): Promise<string> {
    const { adapter, probe } = createFakeCaptain({
      turns: [[{ name: 'mcp__crew__finish', input: { summary: 'done' } }]],
    });
    const stateStore = new StateStore(projectRoot);
    const worktreeManager = new WorktreeManager(projectRoot);
    const dispatcher = new ToolDispatcher();
    const runner = new JudgmentRunner(
      adapter,
      makeRegistry([adapter]),
      workflow,
      stateStore,
      worktreeManager,
      {
        session: args.session,
        dispatcher,
        presets: args.presets,
        defaultPresetName: args.defaultPresetName,
      },
    );
    await runner.run('go');
    return systemPromptOf(probe.lastMessages);
  }

  it('config default hint flows to the captain when session has no override', async () => {
    const session = CaptainSession.create({ projectRoot });
    const prompt = await runSingleTurnAndCaptureSystemPrompt({
      session,
      presets,
      defaultPresetName: 'default',
    });
    expect(prompt).toContain('[preset=default]');
    expect(prompt).not.toContain('[preset=thorough-review]');
  });

  it('session.activePreset beats config default when set on the session before the turn', async () => {
    // Fresh project root for this case so we don't accumulate stale session files.
    const fresh = mkdtempSync(join(tmpdir(), 'crew-m5-preset-fresh-a-'));
    execSync('git init -q', { cwd: fresh });
    execSync('git config user.email t@t', { cwd: fresh });
    execSync('git config user.name t', { cwd: fresh });
    execSync('git commit -q --allow-empty -m init', { cwd: fresh });
    try {
      const session = CaptainSession.create({ projectRoot: fresh });
      session.setActivePreset('thorough-review');

      // Rebuild runSingleTurnAndCaptureSystemPrompt inline so it uses the fresh project root.
      const { adapter, probe } = createFakeCaptain({
        turns: [[{ name: 'mcp__crew__finish', input: { summary: 'done' } }]],
      });
      const stateStore = new StateStore(fresh);
      const worktreeManager = new WorktreeManager(fresh);
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
      await runner.run('go');
      const prompt = systemPromptOf(probe.lastMessages);
      expect(prompt).toContain('[preset=thorough-review]');
      expect(prompt).not.toContain('[preset=default]');
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('clearing the session override reverts future turns to the config default', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'crew-m5-preset-fresh-b-'));
    execSync('git init -q', { cwd: fresh });
    execSync('git config user.email t@t', { cwd: fresh });
    execSync('git config user.name t', { cwd: fresh });
    execSync('git commit -q --allow-empty -m init', { cwd: fresh });
    try {
      const session = CaptainSession.create({ projectRoot: fresh });
      session.setActivePreset('thorough-review');
      session.setActivePreset(undefined);

      const { adapter, probe } = createFakeCaptain({
        turns: [[{ name: 'mcp__crew__finish', input: { summary: 'done' } }]],
      });
      const stateStore = new StateStore(fresh);
      const worktreeManager = new WorktreeManager(fresh);
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
      await runner.run('go');
      const prompt = systemPromptOf(probe.lastMessages);
      expect(prompt).toContain('[preset=default]');
      expect(prompt).not.toContain('[preset=thorough-review]');
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('preserves providerSessionRef across preset changes', () => {
    // The preset is prompt material, not tool-schema material — a preset
    // swap must NOT invalidate providerSessionRef. M5-4's session setter
    // is already unit-tested, but we lock the invariant here in the
    // runner-integration direction too.
    const session = CaptainSession.create({
      projectRoot,
      cliVersionTag: 'claude-code@1.0.0',
    });
    session.providerSessionRef = 'sess-abc';
    session.setActivePreset('thorough-review');
    expect(session.providerSessionRef).toBe('sess-abc');
    session.setActivePreset(undefined);
    expect(session.providerSessionRef).toBe('sess-abc');
  });

  it('removed preset (session points at it, config no longer declares it) falls back + preserves the stored name', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const { adapter, probe } = createFakeCaptain({
      turns: [
        [{ name: 'mcp__crew__message_user', input: { text: 'turn 1' } }],
        [
          { name: 'mcp__crew__message_user', input: { text: 'turn 2' } },
          { name: 'mcp__crew__finish', input: { summary: 'done' } },
        ],
      ],
    });

    const stateStore = new StateStore(projectRoot);
    const worktreeManager = new WorktreeManager(projectRoot);
    const session = CaptainSession.create({ projectRoot });
    // Pre-seed the session with a preset name that will no longer exist
    // in the running config.
    session.setActivePreset('thorough-review');
    const dispatcher = new ToolDispatcher();
    // Config has the default preset only — `thorough-review` is gone.
    const trimmedPresets: Record<string, PresetConfig> = {
      default: presets.default,
    };
    const runner = new JudgmentRunner(
      adapter,
      makeRegistry([adapter]),
      workflow,
      stateStore,
      worktreeManager,
      {
        session,
        dispatcher,
        presets: trimmedPresets,
        defaultPresetName: 'default',
      },
    );

    await runner.run('go');

    // Turn 1's prompt falls through to "no hint" — session.activePreset
    // pointed at an unknown name and the resolver returned undefined
    // (does NOT silently fall back to the config default at the resolver
    // level; the runner renders no preset in that case).
    const sys1 = systemPromptOf(probe.allMessages[0]);
    expect(sys1).toContain('## Preset hint');
    expect(sys1).toContain('(none)');
    expect(sys1).not.toContain('[preset=thorough-review]');
    expect(sys1).not.toContain('[preset=default]');

    // Warn was logged (throttled to once per name).
    expect(warnSpy).toHaveBeenCalled();
    const presetWarns = warnSpy.mock.calls.filter((call) =>
      typeof call[0] === 'string' && (call[0] as string).includes('thorough-review'),
    );
    expect(presetWarns.length).toBeGreaterThanOrEqual(1);

    // The session STILL has 'thorough-review' stored — the runner does not
    // auto-clear it (user may re-add the preset later).
    expect(session.activePreset).toBe('thorough-review');

    warnSpy.mockRestore();
  });
});
