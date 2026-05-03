import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import {
  formatProfileListOutput,
  formatProfileShowOutput,
  profileCopyCommand,
  profileCreateCommand,
  profileDeleteCommand,
  profileSetupCommand,
  profileUseCommand,
} from '../../../src/cli/commands/profile.js';
import {
  loadConfigByScope,
  readActiveProfilePreference,
} from '../../../src/workflow/config-repository.js';
import { resolveCaptainModel } from '../../../src/workflow/config-codec.js';
import { ModelId } from '../../../src/workflow/models.js';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    homedir: vi.fn(actual.homedir),
  };
});

describe('profile command handlers', () => {
  const mockedHomedir = vi.mocked(homedir);
  let tmpRoot: string;
  let cwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `captain-profile-command-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    cwd = join(tmpRoot, 'project');
    mkdirSync(cwd, { recursive: true });
    mockedHomedir.mockReturnValue(join(tmpRoot, 'home'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    mockedHomedir.mockRestore();
    logSpy.mockRestore();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('creates, lists, shows, uses, copies, and deletes profiles', async () => {
    await profileCreateCommand('codex-first', {
      cwd,
      from: 'default',
      select: true,
    });
    expect(readActiveProfilePreference(cwd)).toBe('codex-first');

    let listOutput = formatProfileListOutput(cwd);
    expect(listOutput).toContain('* codex-first');
    expect(listOutput).toContain('captain: claude-code');

    const showOutput = formatProfileShowOutput(cwd, 'codex-first');
    expect(showOutput).toContain('Crew Profile: codex-first');

    await profileCopyCommand('codex-first', 'codex-copy', { cwd });
    expect(loadConfigByScope('project', cwd, { profile: 'codex-copy' })).toBeDefined();

    await profileUseCommand('codex-copy', { cwd });
    expect(readActiveProfilePreference(cwd)).toBe('codex-copy');

    await profileDeleteCommand('codex-copy', { cwd, yes: true });
    expect(readActiveProfilePreference(cwd)).toBe('default');
    listOutput = formatProfileListOutput(cwd);
    expect(listOutput).not.toContain('codex-copy');
  });

  it('runs guided setup for a named profile', async () => {
    await profileSetupCommand('codex-first', {
      cwd,
      from: 'default',
      scope: 'project',
      select: true,
      wizardIo: {
        supportsInteractiveSelection: () => false,
        askQuestion: async (question) => {
          if (question.includes('Which CLI should coordinate the crew?')) return 'codex';
          if (question.includes('Which model should the captain use?')) return ModelId.GPT_CODEX;
          if (question.includes('Apply changes?')) return 'yes';
          return '';
        },
        log: () => {},
        clearScreen: () => {},
      },
    });

    const profileConfig = loadConfigByScope('project', cwd, { profile: 'codex-first' });
    expect(profileConfig?.captain.cli).toBe('codex');
    expect(resolveCaptainModel(profileConfig!.captain)).toBe(ModelId.GPT_CODEX);
    expect(readActiveProfilePreference(cwd)).toBe('codex-first');
  });

  it('rejects using a missing profile', async () => {
    await expect(profileUseCommand('missing', { cwd })).rejects.toThrow(/does not exist/);
  });
});
