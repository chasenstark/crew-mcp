import { describe, expect, it } from 'vitest';
import { AdapterRegistry, createBuiltinRegistry, createRegistryFromConfig } from '../../src/adapters/registry.js';
import { ModelId } from '../../src/workflow/models.js';
import type { AgentAdapter } from '../../src/adapters/types.js';

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
        strengths: ['code-review', 'fast-iteration'],
      },
    });

    expect(registry.get('claude-code')).toBeDefined();
    expect(registry.get('codex')).toBeDefined();
    expect(registry.get('gemini-cli')).toBeDefined();
    const custom = registry.get('custom');
    expect(custom).toBeDefined();
    expect(custom?.name).toBe('custom');
    expect(custom?.strengths).toContain('code-review');
    expect(custom?.strengths).toContain('fast-iteration');
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

describe('strengths passthrough', () => {
  it('accepts user-defined strength strings verbatim', () => {
    const registry = createRegistryFromConfig({
      custom: {
        adapter: 'generic',
        command: 'my-tool',
        strengths: ['typescript', 'k8s-ops', 'devops'],
      },
    });
    const custom = registry.get('custom');
    expect(custom?.strengths).toEqual(['typescript', 'k8s-ops', 'devops']);
  });

  it('normalizes strengths: trim, lowercase, dedupe, preserve order', () => {
    const registry = createRegistryFromConfig({
      custom: {
        adapter: 'generic',
        command: 'my-tool',
        strengths: ['  Code-Review  ', 'CODE-REVIEW', 'TypeScript', 'typescript'],
      },
    });
    const strengths = registry.get('custom')?.strengths;
    expect(strengths).toEqual(['code-review', 'typescript']);
  });

  it('defaults to [] (empty) when no strengths are supplied', () => {
    // No silent fallback to any sentinel — empty is honest. The agent
    // simply has no soft routing hints; the captain picks based on
    // name and the user's words alone.
    const registry = createRegistryFromConfig({
      custom: { adapter: 'generic', command: 'my-tool' },
    });
    expect(registry.get('custom')?.strengths).toEqual([]);
  });

  it('returns [] when every provided strength is empty/whitespace', () => {
    const registry = createRegistryFromConfig({
      custom: {
        adapter: 'generic',
        command: 'my-tool',
        strengths: ['  ', ''],
      },
    });
    expect(registry.get('custom')?.strengths).toEqual([]);
  });
});

describe('AdapterRegistry alias resolution', () => {
  function makeStub(name: string, aliases?: readonly string[]): AgentAdapter {
    return {
      name,
      aliases,
      strengths: [],
      supportsJsonSchema: false,
      execute: async () => ({ status: 'completed' as const, output: '' }) as never,
      healthCheck: async () => ({ available: true, authenticated: true }),
    };
  }

  it('resolves get/getOrThrow by canonical name AND alias', () => {
    const registry = new AdapterRegistry();
    registry.register(makeStub('claude-code', ['claude']));
    expect(registry.get('claude-code')?.name).toBe('claude-code');
    expect(registry.get('claude')?.name).toBe('claude-code');
    expect(registry.getOrThrow('claude').name).toBe('claude-code');
  });

  it('listAvailable returns each adapter once (not once per alias)', () => {
    const registry = new AdapterRegistry();
    registry.register(makeStub('claude-code', ['claude', 'cc']));
    registry.register(makeStub('codex'));
    expect(registry.listAvailable().map((a) => a.name)).toEqual(['claude-code', 'codex']);
  });

  it('throws when an alias collides with another adapter name', () => {
    const registry = new AdapterRegistry();
    registry.register(makeStub('codex'));
    expect(() => registry.register(makeStub('claude-code', ['codex']))).toThrow(/collides/);
  });

  it('throws when two adapters declare the same alias', () => {
    const registry = new AdapterRegistry();
    registry.register(makeStub('a', ['shared']));
    expect(() => registry.register(makeStub('b', ['shared']))).toThrow(/collides/);
  });

  it('throws when registering the same canonical name twice', () => {
    const registry = new AdapterRegistry();
    registry.register(makeStub('codex'));
    expect(() => registry.register(makeStub('codex'))).toThrow(/collides/);
  });

  it('built-in registry resolves "claude" to ClaudeCodeAdapter', () => {
    const registry = createBuiltinRegistry();
    expect(registry.get('claude')?.name).toBe('claude-code');
    expect(registry.get('claude-code')?.name).toBe('claude-code');
    expect(registry.get('claude')).toBe(registry.get('claude-code'));
  });

  it('getOrThrow error message lists both names and aliases', () => {
    const registry = new AdapterRegistry();
    registry.register(makeStub('claude-code', ['claude']));
    expect(() => registry.getOrThrow('nope')).toThrow(/claude-code.*claude/);
  });
});
