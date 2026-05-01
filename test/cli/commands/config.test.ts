import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import {
  configAddAgentCommand,
  configProfileCommand,
  configResetCommand,
  configRemoveAgentCommand,
  configScopeCommand,
  configSetCommand,
  configShowCommand,
  configWizardCommand,
} from '../../../src/cli/commands/config.js';
import { loadConfigByScope, readActiveScopePreference } from '../../../src/workflow/config-repository.js';
import { resolveCaptainModel } from '../../../src/workflow/config-codec.js';
import { ModelId } from '../../../src/workflow/models.js';

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
    tmpRoot = join(tmpdir(), `captain-config-command-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
    expect(joined).toContain('Active Profile');
    expect(joined).toContain('Effective Config');
  });

  it('updates a value via set command', async () => {
    await configSetCommand('errorHandling.default.retry', '7', { cwd });
    const projectConfig = loadConfigByScope('project', cwd);
    expect(projectConfig?.errorHandling.default.retry).toBe(7);
  });

  it('supports next/prev cycling via set command', async () => {
    await configSetCommand('captain.model', 'next', { cwd });
    const projectConfig = loadConfigByScope('project', cwd);
    expect(resolveCaptainModel(projectConfig!.captain)).toBe(ModelId.CLAUDE_OPUS);
  });

  it('sets active profile', async () => {
    await configProfileCommand('codex-first', { cwd });
    const joined = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(joined).toContain('Active profile set to codex-first');
  });

  it('writes config to selected profile', async () => {
    await configSetCommand('captain.cli', 'codex', { cwd, profile: 'codex-first' });
    const profileConfig = loadConfigByScope('project', cwd, { profile: 'codex-first' });
    expect(profileConfig?.captain.cli).toBe('codex');
  });

  it('sets role model overrides via set command', async () => {
    await configSetCommand('workflow.roleModels.reviewer', ModelId.GPT, { cwd });
    const projectConfig = loadConfigByScope('project', cwd);
    expect(projectConfig?.workflow.roleModels?.reviewer).toBe(ModelId.GPT);
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
    await expect(configSetCommand('captain.cli', 'codex', { cwd, scope: 'invalid' }))
      .rejects
      .toThrow(/Invalid scope/);
  });

  it('adds and removes an agent via command handlers', async () => {
    await configAddAgentCommand('local-gemma', {
      cwd,
      adapter: 'generic',
      command: 'ollama',
      args: 'run,gemma4:latest,{{prompt}}',
      capabilities: 'implement,review',
    });
    let projectConfig = loadConfigByScope('project', cwd);
    expect(projectConfig?.agents['local-gemma']).toEqual({
      adapter: 'generic',
      command: 'ollama',
      args: ['run', 'gemma4:latest', '{{prompt}}'],
      capabilities: ['implement', 'review'],
    });

    await configRemoveAgentCommand('local-gemma', { cwd });
    projectConfig = loadConfigByScope('project', cwd);
    expect(projectConfig?.agents['local-gemma']).toBeUndefined();
  });

  it('runs guided setup with user-facing questions and writes selected values', async () => {
    const prompts: string[] = [];
    const logs: string[] = [];

    await configWizardCommand({
      cwd,
      io: {
        supportsInteractiveSelection: () => false,
        askQuestion: async (question) => {
          prompts.push(question);
          if (question.includes('Which CLI should coordinate the crew?')) return 'codex';
          if (question.includes('Apply changes?')) return 'yes';
          return '';
        },
        log: (message = '') => logs.push(message),
      },
    });

    const projectConfig = loadConfigByScope('project', cwd);
    expect(projectConfig?.captain.cli).toBe('codex');
    expect(logs.join('\n')).toContain('Guided Config Setup');
    expect(prompts.some((prompt) => prompt.includes('How detailed should setup be?'))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes('Which CLI should coordinate the crew?'))).toBe(true);
    expect(prompts.some((prompt) => prompt.trimStart().startsWith('captain.cli'))).toBe(false);
    expect(prompts.some((prompt) => prompt.includes('workflow.roleModels.'))).toBe(false);
    expect(prompts.some((prompt) => prompt.includes('agents.'))).toBe(false);
    expect(logs.join('\n')).toContain('Quick setup skips workflow role-model and per-agent internals');
  });

  it('runs advanced setup and asks role/agent internals', async () => {
    const prompts: string[] = [];

    await configWizardCommand({
      cwd,
      io: {
        supportsInteractiveSelection: () => false,
        askQuestion: async (question) => {
          prompts.push(question);
          if (question.includes('How detailed should setup be?')) return 'advanced';
          if (question.includes('Apply changes?')) return 'no';
          return '';
        },
        log: () => {},
      },
    });

    expect(prompts.some((prompt) => prompt.includes('workflow role use?'))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes('agent use?'))).toBe(true);
  });
});
