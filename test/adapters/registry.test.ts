import { describe, expect, it } from 'vitest';
import { createBuiltinRegistry, createRegistryFromConfig } from '../../src/adapters/registry.js';
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

  it('omits built-in adapters that are not in the user config', () => {
    const registry = createRegistryFromConfig({
      'claude-code': { adapter: 'claude-code' },
      codex: { adapter: 'codex' },
    });

    expect(registry.get('claude-code')).toBeDefined();
    expect(registry.get('codex')).toBeDefined();
    expect(registry.get('gemini-cli')).toBeUndefined();
    expect(registry.listAvailable().map((a) => a.name).sort()).toEqual([
      'claude-code',
      'codex',
    ]);
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

describe('createBuiltinRegistry', () => {
  it('pre-registers all built-in adapters for diagnostic use', () => {
    const registry = createBuiltinRegistry();
    expect(registry.get('claude-code')).toBeDefined();
    expect(registry.get('codex')).toBeDefined();
    expect(registry.get('gemini-cli')).toBeDefined();
  });
});

describe('capabilities passthrough (M3-2)', () => {
  it('accepts user-defined capability strings verbatim', () => {
    const registry = createRegistryFromConfig({
      custom: {
        adapter: 'generic',
        command: 'my-tool',
        capabilities: ['typescript', 'k8s-ops', 'devops'],
      },
    });
    const custom = registry.get('custom');
    expect(custom?.capabilities).toEqual(['typescript', 'k8s-ops', 'devops']);
  });

  it('normalizes capabilities: trim, lowercase, dedupe, preserve order', () => {
    const registry = createRegistryFromConfig({
      custom: {
        adapter: 'generic',
        command: 'my-tool',
        capabilities: ['  Review  ', 'REVIEW', 'TypeScript', 'typescript'],
      },
    });
    const caps = registry.get('custom')?.capabilities;
    expect(caps).toEqual(['review', 'typescript']);
  });

  it('defaults to ["analyze"] when no capabilities are supplied', () => {
    const registry = createRegistryFromConfig({
      custom: { adapter: 'generic', command: 'my-tool' },
    });
    expect(registry.get('custom')?.capabilities).toEqual(['analyze']);
  });

  it('defaults to ["analyze"] when every provided capability is empty/whitespace', () => {
    const registry = createRegistryFromConfig({
      custom: {
        adapter: 'generic',
        command: 'my-tool',
        capabilities: ['  ', ''],
      },
    });
    expect(registry.get('custom')?.capabilities).toEqual(['analyze']);
  });
});
