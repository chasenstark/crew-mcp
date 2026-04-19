import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stateResetCommand } from '../../../src/cli/commands/state-reset.js';

function seedCrewDir(root: string): string {
  const crewDir = join(root, '.crew');
  mkdirSync(crewDir, { recursive: true });
  writeFileSync(join(crewDir, 'state.json'), '{"schemaVersion":4}', 'utf-8');
  writeFileSync(join(crewDir, 'workflow.yaml'), 'workflow:\n  name: default\n', 'utf-8');
  writeFileSync(join(crewDir, 'conversation.json'), '[]', 'utf-8');
  writeFileSync(join(crewDir, 'conversation.legacy.json'), '[]', 'utf-8');

  mkdirSync(join(crewDir, 'runs', 'run-a'), { recursive: true });
  writeFileSync(join(crewDir, 'runs', 'run-a', 'state.json'), '{}', 'utf-8');

  mkdirSync(join(crewDir, 'passes'), { recursive: true });
  writeFileSync(join(crewDir, 'passes', 'pass-001.json'), '{}', 'utf-8');

  mkdirSync(join(crewDir, 'summaries'), { recursive: true });
  writeFileSync(join(crewDir, 'summaries', 'pass-001.json'), '{}', 'utf-8');

  mkdirSync(join(crewDir, 'captain'), { recursive: true });
  writeFileSync(join(crewDir, 'captain', 'session.json'), '{}', 'utf-8');

  mkdirSync(join(crewDir, 'logs'), { recursive: true });
  writeFileSync(join(crewDir, 'logs', 'run.log'), 'entry', 'utf-8');

  mkdirSync(join(crewDir, 'profiles'), { recursive: true });
  writeFileSync(join(crewDir, 'profiles', 'default.yaml'), 'default', 'utf-8');

  // M3-9: `.crew/config.lock.json` caches the catalog-hash for Gemini
  // settings regen. It MUST NOT be wiped by `crew state reset` — users
  // who routinely reset would otherwise force a settings.json rewrite
  // on every next captain invocation.
  writeFileSync(
    join(crewDir, 'config.lock.json'),
    JSON.stringify({ schemaVersion: 1, catalogHash: 'deadbeef', updatedAt: '2026-04-19T00:00:00Z' }),
    'utf-8',
  );

  return crewDir;
}

describe('stateResetCommand', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'crew-state-reset-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('removes runtime state and preserves config/logs/profiles when confirmed', async () => {
    const crewDir = seedCrewDir(tmpRoot);
    const prompt = vi.fn(async () => true);

    const result = await stateResetCommand({ cwd: tmpRoot }, prompt);

    expect(result.confirmed).toBe(true);
    expect(result.removed).toEqual(
      expect.arrayContaining([
        'state.json',
        'runs',
        'passes',
        'summaries',
        'conversation.json',
        'conversation.legacy.json',
        'captain',
      ]),
    );
    expect(prompt).toHaveBeenCalledTimes(1);

    expect(existsSync(join(crewDir, 'state.json'))).toBe(false);
    expect(existsSync(join(crewDir, 'runs'))).toBe(false);
    expect(existsSync(join(crewDir, 'passes'))).toBe(false);
    expect(existsSync(join(crewDir, 'summaries'))).toBe(false);
    expect(existsSync(join(crewDir, 'conversation.json'))).toBe(false);
    expect(existsSync(join(crewDir, 'conversation.legacy.json'))).toBe(false);
    expect(existsSync(join(crewDir, 'captain'))).toBe(false);

    expect(existsSync(join(crewDir, 'workflow.yaml'))).toBe(true);
    expect(existsSync(join(crewDir, 'logs'))).toBe(true);
    expect(existsSync(join(crewDir, 'profiles'))).toBe(true);
    // M3-9 exit gate: config.lock.json survives the reset.
    expect(existsSync(join(crewDir, 'config.lock.json'))).toBe(true);
    expect(result.removed).not.toContain('config.lock.json');
  });

  it('bypasses confirmation when --yes is supplied', async () => {
    const crewDir = seedCrewDir(tmpRoot);
    const prompt = vi.fn(async () => false);

    const result = await stateResetCommand({ cwd: tmpRoot, yes: true }, prompt);

    expect(prompt).not.toHaveBeenCalled();
    expect(result.confirmed).toBe(true);
    expect(existsSync(join(crewDir, 'state.json'))).toBe(false);
    expect(existsSync(join(crewDir, 'workflow.yaml'))).toBe(true);
  });

  it('leaves state intact when the user declines the prompt', async () => {
    const crewDir = seedCrewDir(tmpRoot);
    const prompt = vi.fn(async () => false);

    const result = await stateResetCommand({ cwd: tmpRoot }, prompt);

    expect(result.confirmed).toBe(false);
    expect(result.removed).toEqual([]);
    expect(existsSync(join(crewDir, 'state.json'))).toBe(true);
    expect(existsSync(join(crewDir, 'runs'))).toBe(true);
    expect(existsSync(join(crewDir, 'workflow.yaml'))).toBe(true);
  });

  it('is a no-op when .crew/ does not exist', async () => {
    const prompt = vi.fn(async () => true);
    const result = await stateResetCommand({ cwd: tmpRoot }, prompt);

    expect(prompt).not.toHaveBeenCalled();
    expect(result.removed).toEqual([]);
    expect(result.confirmed).toBe(true);
  });

  it('is a no-op when only preserved entries exist', async () => {
    const crewDir = join(tmpRoot, '.crew');
    mkdirSync(crewDir, { recursive: true });
    writeFileSync(join(crewDir, 'workflow.yaml'), 'workflow:\n', 'utf-8');

    const prompt = vi.fn(async () => true);
    const result = await stateResetCommand({ cwd: tmpRoot }, prompt);

    expect(prompt).not.toHaveBeenCalled();
    expect(result.removed).toEqual([]);
    expect(existsSync(join(crewDir, 'workflow.yaml'))).toBe(true);
  });
});
