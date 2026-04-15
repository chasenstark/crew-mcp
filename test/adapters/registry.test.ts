import { describe, expect, it } from 'vitest';
import { createRegistryFromConfig } from '../../src/adapters/registry.js';
import { ModelId } from '../../src/workflow/models.js';

describe('createRegistryFromConfig', () => {
  it('registers built-ins and configured generic adapters', () => {
    const registry = createRegistryFromConfig({
      'claude-code': { adapter: 'claude-code' },
      codex: { adapter: 'codex' },
      'gemini-cli': { adapter: 'gemini-cli' },
      custom: {
        adapter: 'generic',
        command: 'my-tool',
        args: ['--prompt', '{{prompt}}'],
        capabilities: ['analyze', 'review'],
      },
    });

    expect(registry.get('claude-code')).toBeDefined();
    expect(registry.get('codex')).toBeDefined();
    expect(registry.get('gemini-cli')).toBeDefined();
    const custom = registry.get('custom');
    expect(custom).toBeDefined();
    expect(custom?.name).toBe('custom');
    expect(custom?.capabilities).toContain('analyze');
    expect(custom?.capabilities).toContain('review');
  });

  it('registers openai-compatible adapters under arbitrary keys', () => {
    const registry = createRegistryFromConfig({
      local: {
        adapter: 'openai-compatible',
        apiBase: 'http://127.0.0.1:11434/v1',
        model: ModelId.QWEN,
      },
    });

    const local = registry.get('local');
    expect(local).toBeDefined();
    expect(local?.name).toBe('local');
  });

  it('throws when a generic adapter is missing command', () => {
    expect(() =>
      createRegistryFromConfig({
        broken: { adapter: 'generic' },
      }),
    ).toThrow(/no command is configured/i);
  });

  it('throws when built-in adapter is configured under a different key', () => {
    expect(() =>
      createRegistryFromConfig({
        'codex-reviewer': { adapter: 'codex' },
      }),
    ).toThrow(/must be configured under key "codex"/i);
  });
});
