import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveAgentPrefsPath } from '../../../../src/agent-prefs/store.js';
import {
  ProviderModelDefaultsState,
  applyProviderModelDefaultsState,
  patchProviderModelDefaults,
} from '../../../../src/cli/commands/config-tui/provider-model-defaults-state.js';

let crewHome: string;

beforeEach(() => {
  crewHome = mkdtempSync(join(tmpdir(), 'crew-provider-model-defaults-'));
});

afterEach(() => {
  rmSync(crewHome, { recursive: true, force: true });
});

describe('ProviderModelDefaultsState', () => {
  it('tracks only semantic model changes and trims custom ids', () => {
    const state = makeState();

    state.setModel('codex', '  gpt-5.6-sol  ');
    expect(state.changes()).toEqual([
      { providerName: 'codex', model: 'gpt-5.6-sol' },
    ]);

    state.setModel('codex', undefined);
    expect(state.hasChanges()).toBe(false);
  });

  it('formats an unset value as the provider CLI default', () => {
    expect(makeState().formatModel('codex')).toBe('(provider CLI default)');
  });
});

describe('provider model default persistence', () => {
  it('updates models atomically while preserving sibling fields and comments', () => {
    writeJson({
      _readme: ['keep'],
      codex: { strengths: ['fast-iteration'], effort: 'high' },
      'claude-code': { strengths: ['code-review'], model: 'sonnet' },
    });
    const state = makeState('sonnet');
    state.setModel('codex', 'gpt-5.6-sol');
    state.setModel('claude-code', undefined);

    applyProviderModelDefaultsState(crewHome, state);

    expect(readJson()).toEqual({
      _readme: ['keep'],
      codex: {
        strengths: ['fast-iteration'],
        effort: 'high',
        model: 'gpt-5.6-sol',
      },
      'claude-code': { strengths: ['code-review'] },
    });
  });

  it('removes an otherwise-empty provider entry when restoring the CLI default', () => {
    expect(patchProviderModelDefaults(
      { codex: { model: 'gpt-5.6-sol' } },
      [{ providerName: 'codex' }],
    )).toEqual({});
  });

  it('refuses to overwrite a malformed provider entry', () => {
    expect(() => patchProviderModelDefaults(
      { codex: 'broken' },
      [{ providerName: 'codex', model: 'gpt-5.6-sol' }],
    )).toThrow(/entry for "codex" must be an object/);
  });
});

function makeState(claudeModel?: string): ProviderModelDefaultsState {
  return new ProviderModelDefaultsState([
    {
      name: 'claude-code',
      displayName: 'Claude Code',
      ...(claudeModel ? { configuredModel: claudeModel } : {}),
      models: [{ model: 'sonnet', displayName: 'Sonnet' }],
    },
    {
      name: 'codex',
      displayName: 'Codex',
      models: [{ model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol' }],
    },
  ]);
}

function writeJson(value: Record<string, unknown>): void {
  writeFileSync(resolveAgentPrefsPath(crewHome), JSON.stringify(value, null, 2), 'utf-8');
}

function readJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(resolveAgentPrefsPath(crewHome), 'utf-8')) as Record<string, unknown>;
}
