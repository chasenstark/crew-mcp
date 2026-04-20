/**
 * M5-4: session.activePreset persistence + atomicity contract.
 *
 * Covers the three guarantees the /preset command depends on:
 *   1. setActivePreset(x) + process restart → the next load sees x.
 *   2. setActivePreset(undefined) clears the override.
 *   3. A preset swap mid-turn does NOT retroactively change the current
 *      turn's already-rendered system prompt, and DOES surface on the next
 *      turn. The runner builds the prompt once at turn-start; re-reading
 *      session.activePreset on subsequent turns is per-turn resolution.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CaptainSession } from '../../src/captain/session.js';
import { SessionStore } from '../../src/captain/session-store.js';
import { buildCaptainSystemPrompt } from '../../src/captain/prompts/captain-system.js';
import { resolveActivePreset } from '../../src/captain/preset-resolver.js';
import type { PresetConfig, WorkflowConfig } from '../../src/workflow/types.js';

const workflow: WorkflowConfig = {
  name: 'default',
  execution: { mode: 'judgment' },
  steps: [],
  completion: { strategy: 'judge_approval', fallback: 'max_passes' },
};

const presets: Record<string, PresetConfig> = {
  default: { name: 'default', hint: 'the default hint verbatim' },
  'thorough-review': {
    name: 'thorough-review',
    hint: 'dispatch a second reviewer after implementation',
    suggestedAgentRoles: ['reviewer'],
  },
  'read-only': { name: 'read-only', hint: 'do not modify files' },
};

describe('CaptainSession.activePreset (M5-4)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'crew-preset-persist-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('setActivePreset + reload sees the same value', () => {
    const s = CaptainSession.create({ projectRoot: root });
    s.appendUserMessage('hi', '2026-04-19T00:00:00.000Z');
    s.setActivePreset('thorough-review');
    expect(s.activePreset).toBe('thorough-review');

    const loaded = CaptainSession.load({ projectRoot: root });
    expect(loaded).not.toBeNull();
    expect(loaded!.activePreset).toBe('thorough-review');
    // Message log preserved.
    expect(loaded!.getMessages().length).toBe(1);
  });

  it('setActivePreset(undefined) clears the field and persists', () => {
    const s = CaptainSession.create({ projectRoot: root });
    s.setActivePreset('read-only');
    expect(s.activePreset).toBe('read-only');
    s.setActivePreset(undefined);
    expect(s.activePreset).toBeUndefined();

    const loaded = CaptainSession.load({ projectRoot: root });
    expect(loaded?.activePreset).toBeUndefined();
  });

  it('emits a preset_changed event to the event log', () => {
    const s = CaptainSession.create({ projectRoot: root });
    s.setActivePreset('thorough-review');
    const store = new SessionStore(root);
    const events = store.readAllEvents();
    const changeEvents = events.filter((e) => e.kind === 'preset_changed');
    expect(changeEvents.length).toBe(1);
    if (changeEvents[0].kind === 'preset_changed') {
      expect(changeEvents[0].preset).toBe('thorough-review');
    }
  });

  it('does NOT invalidate providerSessionRef on preset change (preset is prompt material)', () => {
    const s = CaptainSession.create({
      projectRoot: root,
      cliVersionTag: 'claude-code@1.0.0',
    });
    s.providerSessionRef = 'sess-123';
    s.setActivePreset('read-only');
    expect(s.providerSessionRef).toBe('sess-123');
    s.setActivePreset(undefined);
    expect(s.providerSessionRef).toBe('sess-123');
  });

  it('mid-turn swap race: current turn keeps its already-built prompt; next turn sees the new preset', () => {
    // Simulation of a race where /preset fires after the turn started
    // building its system prompt but before the turn returns. The contract
    // is: per-turn resolution reads session.activePreset ONCE at turn start
    // and hands it to buildCaptainSystemPrompt. A subsequent swap does not
    // rewrite the already-computed prompt.
    const s = CaptainSession.create({ projectRoot: root });
    s.setActivePreset(undefined); // start with no override → config default

    // Turn 1: resolve + build prompt up-front (like the runner does).
    const resolvedT1 = resolveActivePreset({
      presets,
      defaultPresetName: 'default',
      sessionOverride: s.activePreset,
    });
    const promptT1 = buildCaptainSystemPrompt({
      workflow,
      agents: [{ name: 'codex', capabilities: ['implement'] }],
      preset: resolvedT1?.preset,
      tools: [{ name: 'run_agent', description: 'x' }],
    });
    expect(promptT1).toContain('the default hint verbatim');

    // Swap happens DURING turn 1 (after prompt is built, before return).
    s.setActivePreset('thorough-review');

    // The turn 1 prompt is an already-captured string — not re-rendered.
    expect(promptT1).toContain('the default hint verbatim');
    expect(promptT1).not.toContain('dispatch a second reviewer after implementation');

    // Turn 2: re-resolve + build. The new value wins.
    const resolvedT2 = resolveActivePreset({
      presets,
      defaultPresetName: 'default',
      sessionOverride: s.activePreset,
    });
    const promptT2 = buildCaptainSystemPrompt({
      workflow,
      agents: [{ name: 'codex', capabilities: ['implement'] }],
      preset: resolvedT2?.preset,
      tools: [{ name: 'run_agent', description: 'x' }],
    });
    expect(promptT2).toContain('dispatch a second reviewer after implementation');
    expect(promptT2).not.toContain('the default hint verbatim');
  });

  it('setActivePreset is a no-op when the value is unchanged', () => {
    const s = CaptainSession.create({ projectRoot: root });
    s.setActivePreset('read-only');
    const store = new SessionStore(root);
    const firstEvents = store.readAllEvents().filter((e) => e.kind === 'preset_changed');
    // Repeat the same value.
    s.setActivePreset('read-only');
    const secondEvents = store.readAllEvents().filter((e) => e.kind === 'preset_changed');
    // Still just the initial event — no churn.
    expect(secondEvents.length).toBe(firstEvents.length);
  });

  it('treats empty string as "clear" (matches the resolver contract)', () => {
    const s = CaptainSession.create({ projectRoot: root });
    s.setActivePreset('read-only');
    s.setActivePreset('');
    expect(s.activePreset).toBeUndefined();
  });
});
