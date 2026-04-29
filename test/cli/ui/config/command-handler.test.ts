import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { handleConfigSlashCommand } from '../../../../src/cli/ui/config/command-handler.js';
import { loadConfigByScope, readActiveScopePreference } from '../../../../src/workflow/config-repository.js';
import { resolveCaptainModel } from '../../../../src/workflow/config-codec.js';
import { ModelId } from '../../../../src/workflow/models.js';

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
    tmpRoot = join(tmpdir(), `captain-config-handler-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    cwd = join(tmpRoot, 'project');
    mkdirSync(cwd, { recursive: true });
    mockedHomedir.mockReturnValue(join(tmpRoot, 'home'));
  });

  afterEach(() => {
    mockedHomedir.mockRestore();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns help text', () => {
    const response = handleConfigSlashCommand('/config', { cwd, sessionBusy: false });
    expect(response).toContain('/config help');
    expect(response).toContain('/config setup');
    expect(response).toContain('/config set captain.cli codex');
    expect(response).toContain('/config set workflow.roleModels.reviewer gpt-5.4');
    expect(response).toContain('/config profile <name>');
    expect(response).toContain('/config add-agent <name> [adapter] [command]');
  });

  it('points setup to the guided terminal command', () => {
    const response = handleConfigSlashCommand('/config setup', { cwd, sessionBusy: false });
    expect(response).toContain('Guided config setup');
    expect(response).toContain('crew config setup');
  });

  it('gets and sets active profile', () => {
    const getInitial = handleConfigSlashCommand('/config profile', { cwd, sessionBusy: false });
    expect(getInitial).toContain('Active profile: default');

    const setResponse = handleConfigSlashCommand('/config profile codex-first', { cwd, sessionBusy: false });
    expect(setResponse).toContain('Active profile set to codex-first');

    const getAfter = handleConfigSlashCommand('/config profile', { cwd, sessionBusy: false });
    expect(getAfter).toContain('Active profile: codex-first');
  });

  it('allows show while session is busy', () => {
    const response = handleConfigSlashCommand('/config show', { cwd, sessionBusy: true });
    expect(response).toContain('Effective Config');
  });

  it('blocks mutating commands while session is busy', () => {
    const response = handleConfigSlashCommand('/config set captain.cli codex', { cwd, sessionBusy: true });
    expect(response).toContain('Cannot mutate config while subagent tool calls are in flight');
  });

  it('applies set command while idle', () => {
    const response = handleConfigSlashCommand('/config set captain.cli codex', { cwd, sessionBusy: false });
    expect(response).toContain('Configuration updated');
    const projectConfig = loadConfigByScope('project', cwd);
    expect(projectConfig?.captain.cli).toBe('codex');
  });

  it('supports next/prev cycling tokens in set command', () => {
    const response = handleConfigSlashCommand('/config set captain.model next', { cwd, sessionBusy: false });
    expect(response).toContain('Configuration updated');
    const projectConfig = loadConfigByScope('project', cwd);
    expect(resolveCaptainModel(projectConfig!.captain)).toBe(ModelId.CLAUDE_OPUS);
  });

  it('updates role model override with slash set command', () => {
    const response = handleConfigSlashCommand(
      `/config set workflow.roleModels.reviewer ${ModelId.GPT}`,
      { cwd, sessionBusy: false },
    );
    expect(response).toContain('Configuration updated');
    const projectConfig = loadConfigByScope('project', cwd);
    expect(projectConfig?.workflow.roleModels?.reviewer).toBe(ModelId.GPT);
  });

  it('sets active scope', () => {
    const response = handleConfigSlashCommand('/config scope global', { cwd, sessionBusy: false });
    expect(response).toContain('Active write scope set to global');
    expect(readActiveScopePreference(cwd)).toBe('global');
  });

  it('adds and removes agent via slash commands', () => {
    const addResponse = handleConfigSlashCommand(
      '/config add-agent local-gemma generic ollama',
      { cwd, sessionBusy: false },
    );
    expect(addResponse).toContain('Agent added');
    let projectConfig = loadConfigByScope('project', cwd);
    expect(projectConfig?.agents['local-gemma']?.adapter).toBe('generic');
    expect(projectConfig?.agents['local-gemma']?.command).toBe('ollama');

    handleConfigSlashCommand(
      '/config set agents.local-gemma.capabilities implement,review',
      { cwd, sessionBusy: false },
    );
    projectConfig = loadConfigByScope('project', cwd);
    expect(projectConfig?.agents['local-gemma']?.capabilities).toEqual(['implement', 'review']);

    const removeResponse = handleConfigSlashCommand('/config remove-agent local-gemma', {
      cwd,
      sessionBusy: false,
    });
    expect(removeResponse).toContain('Agent removed');
    projectConfig = loadConfigByScope('project', cwd);
    expect(projectConfig?.agents['local-gemma']).toBeUndefined();
  });
});
