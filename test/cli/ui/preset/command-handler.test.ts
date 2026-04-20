import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CaptainSession } from '../../../../src/captain/session.js';
import { handlePresetSlashCommand } from '../../../../src/cli/ui/preset/command-handler.js';
import type { FullConfig, PresetConfig } from '../../../../src/workflow/types.js';
import { __resetPresetWarnLatchForTest } from '../../../../src/captain/preset-resolver.js';
import { logger } from '../../../../src/utils/logger.js';

function makeConfig(overrides: Partial<FullConfig> = {}): FullConfig {
  const presets: Record<string, PresetConfig> = {
    default: { name: 'default', description: 'balanced default', hint: 'default hint' },
    'thorough-review': {
      name: 'thorough-review',
      description: 'fan out to reviewers',
      hint: 'always review twice',
      suggestedAgentRoles: ['reviewer', 'security'],
    },
    'read-only': { name: 'read-only', description: 'no writes', hint: 'refuse to write files' },
  };
  return {
    workflow: {
      name: 'default',
      execution: { mode: 'judgment' },
      steps: [],
      completion: { strategy: 'judge_approval', fallback: 'max_passes' },
    },
    agents: {},
    captain: { cli: 'claude-code', preset: 'default' },
    presets,
    errorHandling: { default: { retry: 1, fallback: null, onExhausted: 'ask_user' } },
    ...overrides,
  };
}

describe('handlePresetSlashCommand (M5-5)', () => {
  let root: string;
  let session: CaptainSession;

  beforeEach(() => {
    __resetPresetWarnLatchForTest();
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    root = mkdtempSync(join(tmpdir(), 'crew-preset-handler-'));
    session = CaptainSession.create({ projectRoot: root });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('returns null when the input is not /preset (falls through to /cancel etc.)', () => {
    const config = makeConfig();
    expect(handlePresetSlashCommand('hello', { session, config })).toBeNull();
    expect(handlePresetSlashCommand('/config show', { session, config })).toBeNull();
  });

  it('/preset help shows the help text and lists declared presets', () => {
    const out = handlePresetSlashCommand('/preset help', { session, config: makeConfig() });
    expect(out).toContain('Preset commands');
    expect(out).toContain('default');
    expect(out).toContain('thorough-review');
    expect(out).toContain('read-only');
  });

  it('/preset list marks the active preset with * (config default by default)', () => {
    const out = handlePresetSlashCommand('/preset list', { session, config: makeConfig() });
    expect(out).toContain('* default');
    expect(out).toContain('  thorough-review');
  });

  it('/preset <name> calls setActivePreset and confirms with the description', () => {
    const spy = vi.spyOn(session, 'setActivePreset');
    const out = handlePresetSlashCommand('/preset thorough-review', {
      session,
      config: makeConfig(),
    });
    expect(spy).toHaveBeenCalledWith('thorough-review');
    expect(out).toContain("'thorough-review'");
    expect(out).toContain('fan out to reviewers');
    expect(out).toContain('next turn');
    expect(session.activePreset).toBe('thorough-review');
  });

  it('/preset <unknown> does NOT call setActivePreset (locks the no-mutation-on-error invariant)', () => {
    const config = makeConfig();
    // Pre-seed an active preset so we can verify it isn't cleared.
    session.setActivePreset('thorough-review');
    const spy = vi.spyOn(session, 'setActivePreset');
    const out = handlePresetSlashCommand('/preset bogus', { session, config });
    expect(spy).not.toHaveBeenCalled();
    expect(out).toContain("Unknown preset 'bogus'");
    expect(session.activePreset).toBe('thorough-review');
  });

  it('/preset clear resets the override and confirms with the config fallback', () => {
    session.setActivePreset('thorough-review');
    const out = handlePresetSlashCommand('/preset clear', {
      session,
      config: makeConfig(),
    });
    expect(session.activePreset).toBeUndefined();
    expect(out).toContain("'default'");
    expect(out).toContain('next turn');
  });

  it('/preset show reports the effective preset with scope', () => {
    session.setActivePreset('thorough-review');
    const out = handlePresetSlashCommand('/preset show', {
      session,
      config: makeConfig(),
    });
    expect(out).toContain('thorough-review');
    expect(out).toContain('session override');
    expect(out).toContain('always review twice');
    expect(out).toContain('reviewer, security');
  });

  it('/preset show when no override is set reports "from captain.preset"', () => {
    const out = handlePresetSlashCommand('/preset show', {
      session,
      config: makeConfig(),
    });
    expect(out).toContain('default');
    expect(out).toContain('from captain.preset');
  });

  it('/preset show when no preset is resolvable reports a helpful message', () => {
    const config = makeConfig({
      captain: { cli: 'claude-code', preset: undefined },
      presets: undefined,
    });
    const out = handlePresetSlashCommand('/preset show', { session, config });
    expect(out).toContain('No active preset');
  });

  it('invalid identifier triggers the parser error', () => {
    const out = handlePresetSlashCommand('/preset my.preset', {
      session,
      config: makeConfig(),
    });
    expect(out).toContain('must match');
    expect(out).toContain('help');
  });
});
