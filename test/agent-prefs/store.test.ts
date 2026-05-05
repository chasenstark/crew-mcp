/**
 * Agent-prefs store tests — read/write/seed semantics + the merge rule.
 *
 * Coverage focus: the read path's tolerance (missing file, bad JSON,
 * non-object values, bad effort values, comment keys) since list_agents
 * runs through this on every call and a crash would silently break the
 * captain's adapter discovery.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AGENT_PREFS_FILENAME,
  effectiveAgentPrefs,
  isEffortLevel,
  readAgentPrefsFile,
  resolveAgentPrefsPath,
  seedAgentPrefsFile,
  writeAgentPrefsFile,
} from '../../src/agent-prefs/store.js';

let crewHome: string;

beforeEach(() => {
  crewHome = mkdtempSync(join(tmpdir(), 'crew-agent-prefs-'));
});

afterEach(() => {
  rmSync(crewHome, { recursive: true, force: true });
});

describe('readAgentPrefsFile', () => {
  it('returns {} when the file does not exist', () => {
    expect(readAgentPrefsFile(crewHome)).toEqual({});
  });

  it('parses a valid file with both fields per agent', () => {
    writeFileSync(
      resolveAgentPrefsPath(crewHome),
      JSON.stringify({
        'claude-code': { strengths: ['code-review'], effort: 'medium' },
        codex: { strengths: ['fast-iteration'], effort: 'high' },
      }),
      'utf-8',
    );
    expect(readAgentPrefsFile(crewHome)).toEqual({
      'claude-code': { strengths: ['code-review'], effort: 'medium' },
      codex: { strengths: ['fast-iteration'], effort: 'high' },
    });
  });

  it('strips underscore-prefixed comment keys', () => {
    writeFileSync(
      resolveAgentPrefsPath(crewHome),
      JSON.stringify({
        _readme: ['ignored'],
        _comment: 'also ignored',
        codex: { strengths: ['fast-iteration'] },
      }),
      'utf-8',
    );
    expect(readAgentPrefsFile(crewHome)).toEqual({
      codex: { strengths: ['fast-iteration'] },
    });
  });

  it('returns {} on invalid JSON without throwing', () => {
    writeFileSync(resolveAgentPrefsPath(crewHome), '{ this is not json', 'utf-8');
    expect(readAgentPrefsFile(crewHome)).toEqual({});
  });

  it('returns {} when the root is not an object', () => {
    writeFileSync(resolveAgentPrefsPath(crewHome), JSON.stringify(['oops']), 'utf-8');
    expect(readAgentPrefsFile(crewHome)).toEqual({});
  });

  it('drops entries whose value is not an object', () => {
    writeFileSync(
      resolveAgentPrefsPath(crewHome),
      JSON.stringify({
        codex: 'not-an-object',
        'claude-code': { strengths: ['ok'] },
      }),
      'utf-8',
    );
    expect(readAgentPrefsFile(crewHome)).toEqual({
      'claude-code': { strengths: ['ok'] },
    });
  });

  it('drops a bad strengths field but keeps a valid effort field on the same entry', () => {
    writeFileSync(
      resolveAgentPrefsPath(crewHome),
      JSON.stringify({ codex: { strengths: 'oops', effort: 'high' } }),
      'utf-8',
    );
    expect(readAgentPrefsFile(crewHome)).toEqual({ codex: { effort: 'high' } });
  });

  it('drops a bad effort value but keeps strengths', () => {
    writeFileSync(
      resolveAgentPrefsPath(crewHome),
      JSON.stringify({ codex: { strengths: ['ok'], effort: 'sky-high' } }),
      'utf-8',
    );
    expect(readAgentPrefsFile(crewHome)).toEqual({ codex: { strengths: ['ok'] } });
  });

  it('filters non-string elements out of strengths', () => {
    writeFileSync(
      resolveAgentPrefsPath(crewHome),
      JSON.stringify({ codex: { strengths: ['fast', 42, null, 'autonomous'] } }),
      'utf-8',
    );
    expect(readAgentPrefsFile(crewHome)).toEqual({
      codex: { strengths: ['fast', 'autonomous'] },
    });
  });
});

describe('writeAgentPrefsFile', () => {
  it('writes the file atomically (no .tmp left behind)', () => {
    writeAgentPrefsFile(crewHome, { codex: { strengths: ['fast-iteration'] } });
    expect(readAgentPrefsFile(crewHome)).toEqual({
      codex: { strengths: ['fast-iteration'] },
    });
    const tmpish = join(crewHome, `${AGENT_PREFS_FILENAME}.tmp.${process.pid}`);
    expect(existsSync(tmpish)).toBe(false);
  });

  it('overwrites an existing file', () => {
    writeAgentPrefsFile(crewHome, { codex: { strengths: ['old'] } });
    writeAgentPrefsFile(crewHome, { codex: { strengths: ['new'] } });
    expect(readAgentPrefsFile(crewHome)).toEqual({ codex: { strengths: ['new'] } });
  });
});

describe('seedAgentPrefsFile', () => {
  it('creates the file with defaults + a _readme on first install', () => {
    const wrote = seedAgentPrefsFile(crewHome, {
      'claude-code': { strengths: ['careful-reasoning'], effort: 'medium' },
      codex: { strengths: ['fast-iteration'], effort: 'medium' },
    });
    expect(wrote).toBe(true);
    expect(readAgentPrefsFile(crewHome)).toEqual({
      'claude-code': { strengths: ['careful-reasoning'], effort: 'medium' },
      codex: { strengths: ['fast-iteration'], effort: 'medium' },
    });
    // _readme should physically exist in the file (helps users editing it).
    const onDiskRaw = readFileSync(resolveAgentPrefsPath(crewHome), 'utf-8');
    expect(onDiskRaw).toContain('_readme');
  });

  it('does NOT overwrite an existing file', () => {
    writeAgentPrefsFile(crewHome, { codex: { strengths: ['user-edit'] } });
    const wrote = seedAgentPrefsFile(crewHome, {
      codex: { strengths: ['default'], effort: 'high' },
    });
    expect(wrote).toBe(false);
    expect(readAgentPrefsFile(crewHome)).toEqual({
      codex: { strengths: ['user-edit'] },
    });
  });
});

describe('effectiveAgentPrefs', () => {
  it('returns the override fields when present', () => {
    expect(
      effectiveAgentPrefs(
        'codex',
        { strengths: ['default'], effort: 'medium' },
        { codex: { strengths: ['user-pick'], effort: 'high' } },
      ),
    ).toEqual({ strengths: ['user-pick'], effort: 'high' });
  });

  it('returns adapter defaults when no override exists', () => {
    expect(
      effectiveAgentPrefs('codex', { strengths: ['default'], effort: 'medium' }, {}),
    ).toEqual({ strengths: ['default'], effort: 'medium' });
  });

  it('merges per-field — override only effort, keep default strengths', () => {
    expect(
      effectiveAgentPrefs(
        'codex',
        { strengths: ['default'], effort: 'medium' },
        { codex: { effort: 'low' } },
      ),
    ).toEqual({ strengths: ['default'], effort: 'low' });
  });

  it('treats an empty-array strengths override as a deliberate "show nothing"', () => {
    // User edited file to [] for this agent's strengths — respect it.
    expect(
      effectiveAgentPrefs(
        'codex',
        { strengths: ['default'], effort: 'medium' },
        { codex: { strengths: [] } },
      ),
    ).toEqual({ strengths: [], effort: 'medium' });
  });
});

describe('isEffortLevel', () => {
  it('accepts the full codex set: low|medium|high|xhigh|max', () => {
    expect(isEffortLevel('low')).toBe(true);
    expect(isEffortLevel('medium')).toBe(true);
    expect(isEffortLevel('high')).toBe(true);
    expect(isEffortLevel('xhigh')).toBe(true);
    expect(isEffortLevel('max')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isEffortLevel('extreme')).toBe(false);
    expect(isEffortLevel('minimal')).toBe(false);
    expect(isEffortLevel('')).toBe(false);
    expect(isEffortLevel(undefined)).toBe(false);
    expect(isEffortLevel(2)).toBe(false);
  });
});

describe('readAgentPrefsFile — extended effort levels', () => {
  it('round-trips xhigh and max through write+read', () => {
    writeAgentPrefsFile(crewHome, {
      codex: { effort: 'xhigh' },
      'claude-code': { effort: 'max' },
    });
    expect(readAgentPrefsFile(crewHome)).toEqual({
      codex: { effort: 'xhigh' },
      'claude-code': { effort: 'max' },
    });
  });
});

describe('model field', () => {
  it('round-trips a per-agent model through write+read', () => {
    writeAgentPrefsFile(crewHome, {
      'claude-code': { model: 'claude-opus-4-7', effort: 'medium' },
      codex: { model: 'gpt-5.5-codex' },
    });
    expect(readAgentPrefsFile(crewHome)).toEqual({
      'claude-code': { model: 'claude-opus-4-7', effort: 'medium' },
      codex: { model: 'gpt-5.5-codex' },
    });
  });

  it('drops a non-string model value but keeps other fields on the entry', () => {
    writeFileSync(
      resolveAgentPrefsPath(crewHome),
      JSON.stringify({ codex: { model: 42, effort: 'high' } }),
      'utf-8',
    );
    expect(readAgentPrefsFile(crewHome)).toEqual({ codex: { effort: 'high' } });
  });

  it('drops an empty/whitespace-only model value', () => {
    writeFileSync(
      resolveAgentPrefsPath(crewHome),
      JSON.stringify({ codex: { model: '   ', strengths: ['ok'] } }),
      'utf-8',
    );
    expect(readAgentPrefsFile(crewHome)).toEqual({ codex: { strengths: ['ok'] } });
  });

  it('trims whitespace around a valid model string', () => {
    writeFileSync(
      resolveAgentPrefsPath(crewHome),
      JSON.stringify({ codex: { model: '  gpt-5.5-codex  ' } }),
      'utf-8',
    );
    expect(readAgentPrefsFile(crewHome)).toEqual({ codex: { model: 'gpt-5.5-codex' } });
  });

  it('effectiveAgentPrefs lets the file model win over an adapter default of undefined', () => {
    expect(
      effectiveAgentPrefs(
        'codex',
        { strengths: ['default'], effort: 'medium' /* no model */ },
        { codex: { model: 'gpt-5.5-codex' } },
      ),
    ).toEqual({
      strengths: ['default'],
      effort: 'medium',
      model: 'gpt-5.5-codex',
    });
  });
});
