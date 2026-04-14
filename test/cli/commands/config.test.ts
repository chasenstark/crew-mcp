import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import {
  configResetCommand,
  configScopeCommand,
  configSetCommand,
  configShowCommand,
} from '../../../src/cli/commands/config.js';
import { loadConfigByScope, readActiveScopePreference } from '../../../src/workflow/config-repository.js';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    homedir: vi.fn(actual.homedir),
  };
});

describe('config command handlers', () => {
  const mockedHomedir = vi.mocked(homedir);
  let tmpRoot: string;
  let cwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `orchestrator-config-command-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

  it('prints show output', async () => {
    await configShowCommand({ cwd });
    expect(logSpy).toHaveBeenCalled();
    const joined = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(joined).toContain('Active Write Scope');
    expect(joined).toContain('Effective Config');
  });

  it('updates a value via set command', async () => {
    await configSetCommand('errorHandling.default.retry', '7', { cwd });
    const projectConfig = loadConfigByScope('project', cwd);
    expect(projectConfig?.errorHandling.default.retry).toBe(7);
  });

  it('supports next/prev cycling via set command', async () => {
    await configSetCommand('orchestrator.model', 'next', { cwd });
    const projectConfig = loadConfigByScope('project', cwd);
    expect(projectConfig?.orchestrator.model).toBe('claude-opus-4-6');
  });

  it('sets and shows write scope', async () => {
    await configScopeCommand('global', { cwd });
    expect(readActiveScopePreference(cwd)).toBe('global');
    await configScopeCommand(undefined, { cwd });
    const joined = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(joined).toContain('Active write scope: global');
  });

  it('resets target scope to defaults', async () => {
    await configSetCommand('errorHandling.default.retry', '9', { cwd, scope: 'global' });
    await configResetCommand({ cwd, scope: 'global' });
    const globalConfig = loadConfigByScope('global', cwd);
    expect(globalConfig?.errorHandling.default.retry).toBe(1);
  });

  it('throws for invalid scope option', async () => {
    await expect(configSetCommand('orchestrator.cli', 'codex', { cwd, scope: 'invalid' }))
      .rejects
      .toThrow(/Invalid scope/);
  });
});
