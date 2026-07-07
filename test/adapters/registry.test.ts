import { describe, expect, it } from 'vitest';
import {
  AdapterRegistry,
  createBuiltinRegistry,
  mergeCustomAgents,
} from '../../src/adapters/registry.js';
import { BUILTIN_AGENT_ROUTING } from '../../src/adapters/strengths.js';
import type { AgentAdapter } from '../../src/adapters/types.js';

describe('createBuiltinRegistry', () => {
  it('leaves built-in cloud adapters falsy for unmetered', () => {
    const registry = createBuiltinRegistry();

    expect(registry.get('claude-code')?.unmetered).toBeFalsy();
    expect(registry.get('codex')?.unmetered).toBeFalsy();
  });

  it('pre-registers all built-in adapters for diagnostic use', () => {
    const registry = createBuiltinRegistry();
    expect(registry.get('claude-code')).toBeDefined();
    expect(registry.get('codex')).toBeDefined();
    expect(registry.get('claude-code')?.strengths).toEqual(
      BUILTIN_AGENT_ROUTING['claude-code'].strengths,
    );
    expect(registry.get('claude-code')?.useWhen).toBe(
      BUILTIN_AGENT_ROUTING['claude-code'].useWhen,
    );
    expect(registry.get('codex')?.strengths).toEqual(BUILTIN_AGENT_ROUTING.codex.strengths);
    expect(registry.get('codex')?.useWhen).toBe(BUILTIN_AGENT_ROUTING.codex.useWhen);
  });
});

describe('mergeCustomAgents', () => {
  it('registers an openai-compatible custom agent on top of built-ins', () => {
    const registry = createBuiltinRegistry();
    const result = mergeCustomAgents(registry, {
      gemma4: {
        adapter: 'openai-compatible',
        apiBase: 'http://127.0.0.1:11434/v1',
        model: 'gemma4:latest',
        apiKey: 'ollama',
        strengths: ['local', 'private', 'fast-iteration'],
        useWhen: 'Use for private local inference.',
      },
    });

    expect(result.warnings).toEqual([]);
    const gemma4 = registry.get('gemma4');
    expect(gemma4).toBeDefined();
    expect(gemma4?.name).toBe('gemma4');
    expect(gemma4?.useWhen).toBe('Use for private local inference.');
    expect(registry.listAvailable().map((adapter) => adapter.name)).toContain('gemma4');
  });

  it('rejects custom adapters that collide with a built-in name', () => {
    const registry = createBuiltinRegistry();

    expect(() =>
      mergeCustomAgents(registry, {
        'claude-code': {
          adapter: 'openai-compatible',
          apiBase: 'http://127.0.0.1:11434/v1',
          model: 'gemma4:latest',
        },
      }),
    ).toThrow(/claude-code/);

    expect(registry.get('claude-code')?.name).toBe('claude-code');
  });

  it('warns and skips malformed custom entries while processing other entries', () => {
    const registry = createBuiltinRegistry();
    const result = mergeCustomAgents(registry, {
      bad: { adapter: 'openai-compatible' },
      good: {
        adapter: 'openai-compatible',
        apiBase: 'http://127.0.0.1:11434/v1',
        model: 'gemma4:latest',
      },
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/bad.*apiBase/);
    expect(registry.get('bad')).toBeUndefined();
    expect(registry.get('good')).toBeDefined();
  });

  it('classifies openai-compatible custom agents conservatively for cloud bases', async () => {
    const registry = createBuiltinRegistry();
    const result = mergeCustomAgents(registry, {
      cloud: {
        adapter: 'openai-compatible',
        apiBase: 'https://api.openai.com/v1',
        model: 'gpt-4.1',
      },
    });

    expect(result.warnings).toEqual([]);
    expect(registry.get('cloud')?.unmetered).toBe(false);
    expect((await registry.load('cloud'))?.unmetered).toBe(false);
  });

  it('registers generic custom agents using the shared generic adapter factory', () => {
    const registry = createBuiltinRegistry();
    const result = mergeCustomAgents(registry, {
      shell: {
        adapter: 'generic',
        command: 'echo',
        args: ['{{prompt}}'],
        strengths: ['scriptable'],
      },
    });

    expect(result.warnings).toEqual([]);
    const shell = registry.get('shell');
    expect(shell).toBeDefined();
    expect(shell?.name).toBe('shell');
    expect(shell?.strengths).toEqual(['scriptable']);
    expect(registry.listAvailable().map((adapter) => adapter.name)).toContain('shell');
  });

  it('warns and skips a generic custom agent missing command', () => {
    const registry = createBuiltinRegistry();
    const result = mergeCustomAgents(registry, {
      broken: { adapter: 'generic' },
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/broken.*command/);
    expect(registry.get('broken')).toBeUndefined();
  });

  it('keeps unmetered metadata consistent before and after lazy load', async () => {
    const registry = createBuiltinRegistry();
    const result = mergeCustomAgents(registry, {
      shell: {
        adapter: 'generic',
        command: 'echo',
      },
      local: {
        adapter: 'openai-compatible',
        apiBase: 'http://127.0.0.1:11434/v1',
        model: 'qwen3:32b',
      },
    });

    expect(result.warnings).toEqual([]);
    expect(registry.get('shell')?.unmetered).toBe(true);
    expect((await registry.load('shell'))?.unmetered).toBe(true);

    expect(registry.get('local')?.unmetered).toBe(true);
    expect((await registry.load('local'))?.unmetered).toBe(true);
  });

  it('threads custom useWhen through lazy metadata and loaded concrete adapters', async () => {
    const registry = createBuiltinRegistry();
    mergeCustomAgents(registry, {
      custom: {
        adapter: 'generic',
        command: 'node',
        strengths: ['scriptable'],
        useWhen: 'Use for local scripted transforms.',
      },
    });

    expect(registry.get('custom')?.useWhen).toBe('Use for local scripted transforms.');
    const loaded = await registry.load('custom');
    expect(loaded?.useWhen).toBe('Use for local scripted transforms.');
  });
});

describe('strengths passthrough', () => {
  function registryWithCustom(config: Record<string, unknown>): AdapterRegistry {
    const registry = createBuiltinRegistry();
    const result = mergeCustomAgents(
      registry,
      { custom: config } as Parameters<typeof mergeCustomAgents>[1],
    );
    expect(result.warnings).toEqual([]);
    return registry;
  }

  it('accepts user-defined strength strings verbatim', () => {
    const registry = registryWithCustom({
      adapter: 'generic',
      command: 'my-tool',
      strengths: ['typescript', 'k8s-ops', 'devops'],
    });
    expect(registry.get('custom')?.strengths).toEqual(['typescript', 'k8s-ops', 'devops']);
  });

  it('normalizes strengths: trim, lowercase, dedupe, preserve order', () => {
    const registry = registryWithCustom({
      adapter: 'generic',
      command: 'my-tool',
      strengths: ['  Code-Review  ', 'CODE-REVIEW', 'TypeScript', 'typescript'],
    });
    expect(registry.get('custom')?.strengths).toEqual(['code-review', 'typescript']);
  });

  it('defaults to [] (empty) when no strengths are supplied', () => {
    // No silent fallback to any sentinel — empty is honest. The agent
    // simply has no soft routing hints; the captain picks based on
    // name and the user's words alone.
    const registry = registryWithCustom({ adapter: 'generic', command: 'my-tool' });
    expect(registry.get('custom')?.strengths).toEqual([]);
  });

  it('returns [] when every provided strength is empty/whitespace', () => {
    const registry = registryWithCustom({
      adapter: 'generic',
      command: 'my-tool',
      strengths: ['  ', ''],
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
