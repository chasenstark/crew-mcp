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
});
