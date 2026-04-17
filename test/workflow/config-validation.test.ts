import { describe, expect, it } from 'vitest';
import { getDefaultConfig } from '../../src/workflow/config-codec.js';
import { ModelId } from '../../src/workflow/models.js';
import { validateConfig } from '../../src/workflow/config-validation.js';

describe('config-validation', () => {
  it('accepts default config', () => {
    const diagnostics = validateConfig(getDefaultConfig());
    expect(diagnostics).toEqual([]);
  });

  it('rejects unsupported adapter values', () => {
    const config = getDefaultConfig();
    config.agents.codex.adapter = 'unknown-adapter';

    const diagnostics = validateConfig(config);
    expect(diagnostics.some((d) => d.path === 'agents.codex.adapter')).toBe(true);
  });

  it('requires command for generic adapter', () => {
    const config = getDefaultConfig();
    config.agents.codex.adapter = 'generic';
    delete config.agents.codex.command;

    const diagnostics = validateConfig(config);
    expect(diagnostics.some((d) => d.path === 'agents.codex.command')).toBe(true);
  });

  it('rejects invalid capabilities', () => {
    const config = getDefaultConfig();
    config.agents.codex.capabilities = ['review', 'made-up-capability'];

    const diagnostics = validateConfig(config);
    expect(diagnostics.some((d) => d.path === 'agents.codex.capabilities')).toBe(true);
  });

  it('rejects built-in adapters under non-built-in keys', () => {
    const config = getDefaultConfig();
    config.agents['custom-codex'] = { adapter: 'codex' };

    const diagnostics = validateConfig(config);
    expect(diagnostics.some((d) => d.path === 'agents.custom-codex.adapter')).toBe(true);
  });

  it('accepts openai-compatible adapters without a command field', () => {
    const config = getDefaultConfig();
    config.agents.local = {
      adapter: 'openai-compatible',
      model: ModelId.QWEN,
      apiBase: 'http://127.0.0.1:11434/v1',
    };

    const diagnostics = validateConfig(config);
    expect(diagnostics.some((d) => d.path === 'agents.local.command')).toBe(false);
  });

  it('accepts role model keys that exist in workflow roles/actions', () => {
    const config = getDefaultConfig();
    config.workflow.roleModels = {
      reviewer: ModelId.GPT,
      fix_review_issues: ModelId.CLAUDE_OPUS,
    };

    const diagnostics = validateConfig(config);
    expect(diagnostics.some((d) => d.path.startsWith('workflow.roleModels'))).toBe(false);
  });

  it('rejects unknown role model keys', () => {
    const config = getDefaultConfig();
    config.workflow.roleModels = { unknown: ModelId.GPT };

    const diagnostics = validateConfig(config);
    expect(diagnostics.some((d) => d.path === 'workflow.roleModels.unknown')).toBe(true);
  });

  it('rejects empty role model values', () => {
    const config = getDefaultConfig();
    config.workflow.roleModels = { reviewer: '   ' };

    const diagnostics = validateConfig(config);
    expect(diagnostics.some((d) => d.path === 'workflow.roleModels.reviewer')).toBe(true);
  });

  it('rejects captain models that are incompatible with the configured captain adapter', () => {
    const config = getDefaultConfig();
    config.captain.model = ModelId.GPT_CODEX;

    const diagnostics = validateConfig(config);
    expect(diagnostics.some((d) => d.path === 'captain.model')).toBe(true);
  });

  it('rejects agent models that are incompatible with the agent adapter', () => {
    const config = getDefaultConfig();
    config.agents['claude-code'].model = ModelId.GPT_CODEX;

    const diagnostics = validateConfig(config);
    expect(diagnostics.some((d) => d.path === 'agents.claude-code.model')).toBe(true);
  });

  it('rejects captain-owned role models that are incompatible with the captain adapter', () => {
    const config = getDefaultConfig();
    config.workflow.roleModels = { judge: ModelId.GPT_CODEX };

    const diagnostics = validateConfig(config);
    expect(diagnostics.some((d) => d.path === 'workflow.roleModels.judge')).toBe(true);
  });

  it('rejects incompatible judge role models even without an explicit judge step', () => {
    const config = getDefaultConfig();
    config.workflow.steps = config.workflow.steps.filter((step) => step.role !== 'judge');
    config.workflow.roleModels = { judge: ModelId.GPT_CODEX };

    const diagnostics = validateConfig(config);
    expect(diagnostics.some((d) => d.path === 'workflow.roleModels.judge')).toBe(true);
  });

  it('allows arbitrary model names for openai-compatible adapters', () => {
    const config = getDefaultConfig();
    config.agents.local = {
      adapter: 'openai-compatible',
      model: 'llama3.2',
      apiBase: 'http://127.0.0.1:11434/v1',
    };

    const diagnostics = validateConfig(config);
    expect(diagnostics.some((d) => d.path === 'agents.local.model')).toBe(false);
  });

  it('rejects unsupported workflow execution mode', () => {
    const config = getDefaultConfig();
    config.workflow.execution = { mode: 'linear' };
    config.workflow.execution.mode = 'invalid' as 'linear';

    const diagnostics = validateConfig(config);
    expect(diagnostics.some((d) => d.path === 'workflow.execution.mode')).toBe(true);
  });
});
