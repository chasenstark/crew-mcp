import { describe, expect, it } from 'vitest';
import { getDefaultConfig } from '../../src/workflow/config-codec.js';
import { validateConfig } from '../../src/workflow/config-validation.js';

describe('config-validation', () => {
  it('accepts default config', () => {
    expect(validateConfig(getDefaultConfig())).toEqual([]);
  });

  it('accepts a fully-populated agentDefaults block', () => {
    const config = getDefaultConfig();
    config.workflow.agentDefaults = {
      iterate: {
        implementer: 'codex',
        reviewers: ['claude-code'],
        banList: ['agy'],
      },
      panel: { reviewers: ['codex'] },
    };
    expect(validateConfig(config)).toEqual([]);
  });

  it('rejects empty implementer ids', () => {
    const config = getDefaultConfig();
    config.workflow.agentDefaults = { iterate: { implementer: '  ' } };
    const diagnostics = validateConfig(config);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].path).toBe('workflow.agentDefaults.iterate.implementer');
    expect(diagnostics[0].message).toContain('non-empty string agent id');
  });

  it('rejects non-array reviewer lists and empty entries', () => {
    const config = getDefaultConfig();
    config.workflow.agentDefaults = {
      iterate: { reviewers: 'codex' as unknown as string[] },
      panel: { banList: ['', 'codex'] },
    };
    const paths = validateConfig(config).map((d) => d.path);
    expect(paths).toContain('workflow.agentDefaults.iterate.reviewers');
    expect(paths).toContain('workflow.agentDefaults.panel.banList[0]');
  });

  it('rejects reviewer/banList collisions per scope', () => {
    const config = getDefaultConfig();
    config.workflow.agentDefaults = {
      iterate: { reviewers: ['codex'], banList: ['codex'] },
      panel: { reviewers: ['claude-code'], banList: ['agy'] },
    };
    const diagnostics = validateConfig(config);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].path).toBe('workflow.agentDefaults.iterate.banList');
    expect(diagnostics[0].received).toBe('codex');
  });
});
