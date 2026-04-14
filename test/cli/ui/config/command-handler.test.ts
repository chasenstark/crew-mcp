import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { handleConfigSlashCommand } from '../../../../src/cli/ui/config/command-handler.js';
import { loadConfigByScope, readActiveScopePreference } from '../../../../src/workflow/config-repository.js';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    homedir: vi.fn(actual.homedir),
  };
});

describe('handleConfigSlashCommand', () => {
  const mockedHomedir = vi.mocked(homedir);
  let tmpRoot: string;
  let cwd: string;

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `orchestrator-config-handler-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    cwd = join(tmpRoot, 'project');
    mkdirSync(cwd, { recursive: true });
    mockedHomedir.mockReturnValue(join(tmpRoot, 'home'));
  });

  afterEach(() => {
    mockedHomedir.mockRestore();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns help text', () => {
    const response = handleConfigSlashCommand('/config', { cwd, isRunning: false });
    expect(response).toContain('/config help');
    expect(response).toContain('/config set orchestrator.cli <value>');
  });

  it('allows show while running', () => {
    const response = handleConfigSlashCommand('/config show', { cwd, isRunning: true });
    expect(response).toContain('Effective Config');
  });

  it('blocks mutating commands while running', () => {
    const response = handleConfigSlashCommand('/config set orchestrator.cli codex', { cwd, isRunning: true });
    expect(response).toContain('Cannot mutate config while a workflow is running');
  });

  it('applies set command while idle', () => {
    const response = handleConfigSlashCommand('/config set orchestrator.cli codex', { cwd, isRunning: false });
    expect(response).toContain('Configuration updated');
    const projectConfig = loadConfigByScope('project', cwd);
    expect(projectConfig?.orchestrator.cli).toBe('codex');
  });

  it('sets active scope', () => {
    const response = handleConfigSlashCommand('/config scope global', { cwd, isRunning: false });
    expect(response).toContain('Active write scope set to global');
    expect(readActiveScopePreference(cwd)).toBe('global');
  });
});
