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
    expect(response).toContain('/config set workflow.roleModels.<role> <value>');
    expect(response).toContain('/config add-agent <name> [adapter] [command]');
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

  it('supports next/prev cycling tokens in set command', () => {
    const response = handleConfigSlashCommand('/config set orchestrator.model next', { cwd, isRunning: false });
    expect(response).toContain('Configuration updated');
    const projectConfig = loadConfigByScope('project', cwd);
    expect(projectConfig?.orchestrator.model).toBe('claude-opus-4-6');
  });

  it('updates role model override with slash set command', () => {
    const response = handleConfigSlashCommand(
      '/config set workflow.roleModels.reviewer gpt-5.4',
      { cwd, isRunning: false },
    );
    expect(response).toContain('Configuration updated');
    const projectConfig = loadConfigByScope('project', cwd);
    expect(projectConfig?.workflow.roleModels?.reviewer).toBe('gpt-5.4');
  });

  it('sets active scope', () => {
    const response = handleConfigSlashCommand('/config scope global', { cwd, isRunning: false });
    expect(response).toContain('Active write scope set to global');
    expect(readActiveScopePreference(cwd)).toBe('global');
  });

  it('adds and removes agent via slash commands', () => {
    const addResponse = handleConfigSlashCommand(
      '/config add-agent local-gemma generic ollama',
      { cwd, isRunning: false },
    );
    expect(addResponse).toContain('Agent added');
    let projectConfig = loadConfigByScope('project', cwd);
    expect(projectConfig?.agents['local-gemma']?.adapter).toBe('generic');
    expect(projectConfig?.agents['local-gemma']?.command).toBe('ollama');

    handleConfigSlashCommand(
      '/config set agents.local-gemma.capabilities implement,review',
      { cwd, isRunning: false },
    );
    projectConfig = loadConfigByScope('project', cwd);
    expect(projectConfig?.agents['local-gemma']?.capabilities).toEqual(['implement', 'review']);

    const removeResponse = handleConfigSlashCommand('/config remove-agent local-gemma', {
      cwd,
      isRunning: false,
    });
    expect(removeResponse).toContain('Agent removed');
    projectConfig = loadConfigByScope('project', cwd);
    expect(projectConfig?.agents['local-gemma']).toBeUndefined();
  });
});
