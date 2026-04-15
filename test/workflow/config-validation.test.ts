import { describe, expect, it } from 'vitest';
import { getDefaultConfig } from '../../src/workflow/config-codec.js';
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
      model: 'qwen3:32b',
      apiBase: 'http://127.0.0.1:11434/v1',
    };

    const diagnostics = validateConfig(config);
    expect(diagnostics.some((d) => d.path === 'agents.local.command')).toBe(false);
  });

  it('accepts role model keys that exist in workflow roles/actions', () => {
    const config = getDefaultConfig();
    config.workflow.roleModels = {
      reviewer: 'gpt-5.4',
      fix_review_issues: 'claude-opus-4-6',
    };

    const diagnostics = validateConfig(config);
    expect(diagnostics.some((d) => d.path.startsWith('workflow.roleModels'))).toBe(false);
  });

  it('rejects unknown role model keys', () => {
    const config = getDefaultConfig();
    config.workflow.roleModels = { unknown: 'gpt-5.4' };

    const diagnostics = validateConfig(config);
    expect(diagnostics.some((d) => d.path === 'workflow.roleModels.unknown')).toBe(true);
  });

  it('rejects empty role model values', () => {
    const config = getDefaultConfig();
    config.workflow.roleModels = { reviewer: '   ' };

    const diagnostics = validateConfig(config);
    expect(diagnostics.some((d) => d.path === 'workflow.roleModels.reviewer')).toBe(true);
  });

  it('rejects unsupported workflow execution mode', () => {
    const config = getDefaultConfig();
    config.workflow.execution = { mode: 'linear' };
    config.workflow.execution.mode = 'invalid' as 'linear';

    const diagnostics = validateConfig(config);
    expect(diagnostics.some((d) => d.path === 'workflow.execution.mode')).toBe(true);
  });
});
