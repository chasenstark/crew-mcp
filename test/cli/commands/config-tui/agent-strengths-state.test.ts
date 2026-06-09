import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveAgentPrefsPath } from '../../../../src/agent-prefs/store.js';
import {
  AgentStrengthsState,
  applyAgentStrengthsState,
  setAgentStrengths,
} from '../../../../src/cli/commands/config-tui/agent-strengths-state.js';

let crewHome: string;

beforeEach(() => {
  crewHome = mkdtempSync(join(tmpdir(), 'crew-agent-strengths-state-'));
  mkdirSync(crewHome, { recursive: true });
});

afterEach(() => {
  rmSync(crewHome, { recursive: true, force: true });
});

describe('setAgentStrengths', () => {
  it('persists strengths: [] as an explicit override while preserving sibling fields', () => {
    writeJson({
      _readme: ['keep'],
      codex: {
        adapter: 'codex',
        model: 'gpt-5-codex',
        effort: 'high',
        strengths: ['fast-iteration'],
      },
    });

    setAgentStrengths(crewHome, 'codex', { strengths: [] });

    expect(readJson()).toEqual({
      _readme: ['keep'],
      codex: {
        adapter: 'codex',
        model: 'gpt-5-codex',
        effort: 'high',
        strengths: [],
      },
    });
  });

  it('deletes strengths on explicit undefined intent and deletes useWhen on blank string', () => {
    writeJson({
      codex: {
        strengths: ['fast-iteration'],
        useWhen: 'Use for edits.',
        model: 'gpt-5-codex',
      },
    });

    setAgentStrengths(crewHome, 'codex', {
      strengths: undefined,
      useWhen: '',
    });

    expect(readJson()).toEqual({
      codex: {
        model: 'gpt-5-codex',
      },
    });
  });

  it('trims and writes non-empty useWhen', () => {
    writeJson({ codex: { strengths: ['fast-iteration'] } });

    setAgentStrengths(crewHome, 'codex', { useWhen: '  Use for quick edits.  ' });

    expect(readJson().codex).toEqual({
      strengths: ['fast-iteration'],
      useWhen: 'Use for quick edits.',
    });
  });

  it('throws a clear error for corrupt non-object agents.json roots', () => {
    writeFileSync(resolveAgentPrefsPath(crewHome), JSON.stringify([]), 'utf-8');

    expect(() =>
      setAgentStrengths(crewHome, 'codex', { strengths: ['code-review'] }),
    ).toThrow(/must be a JSON object/);
  });
});

describe('applyAgentStrengthsState', () => {
  it('writes only touched agents', () => {
    const state = new AgentStrengthsState([
      { name: 'codex', strengths: ['fast-iteration'] },
      { name: 'claude-code', strengths: ['code-review'] },
    ]);
    state.setStrengths('codex', ['bulk-implementation']);
    const calls: string[] = [];

    applyAgentStrengthsState(crewHome, state, {
      setAgentStrengths: (_crewHome, agentName) => calls.push(agentName),
    });

    expect(calls).toEqual(['codex']);
  });
});

function writeJson(value: Record<string, unknown>): void {
  writeFileSync(resolveAgentPrefsPath(crewHome), JSON.stringify(value, null, 2), 'utf-8');
}

function readJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(resolveAgentPrefsPath(crewHome), 'utf-8')) as Record<string, unknown>;
}
