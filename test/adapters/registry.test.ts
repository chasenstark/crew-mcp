import { describe, expect, it } from 'vitest';
import {
  AdapterRegistry,
  createBuiltinRegistry,
  createRegistryFromConfig,
  mergeCustomAgents,
} from '../../src/adapters/registry.js';
import { BUILTIN_AGENT_ROUTING } from '../../src/adapters/strengths.js';
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
        useWhen: 'Use for shell-backed code review.',
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
    expect(custom?.useWhen).toBe('Use for shell-backed code review.');
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

  it('keeps unmetered metadata consistent before and after lazy load', async () => {
    const registry = createRegistryFromConfig({
      generic: {
        adapter: 'generic',
        command: 'echo',
      },
      local: {
        adapter: 'openai-compatible',
        apiBase: 'http://127.0.0.1:11434/v1',
        model: ModelId.QWEN,
      },
      cloud: {
        adapter: 'openai-compatible',
        apiBase: 'https://api.openai.com/v1',
        model: 'gpt-4.1',
      },
    });

    expect(registry.get('generic')?.unmetered).toBe(true);
    expect((await registry.load('generic'))?.unmetered).toBe(true);

    expect(registry.get('local')?.unmetered).toBe(true);
    expect((await registry.load('local'))?.unmetered).toBe(true);

    expect(registry.get('cloud')?.unmetered).toBe(false);
    expect((await registry.load('cloud'))?.unmetered).toBe(false);
  });

  it('keeps env-resolved openai-compatible unmetered metadata stable after lazy load', async () => {
    const originalBaseUrl = process.env.CREW_OPENAI_BASE_URL;
    process.env.CREW_OPENAI_BASE_URL = 'http://127.0.0.1:11434/v1';

    try {
      const registry = createRegistryFromConfig({
        local: {
          adapter: 'openai-compatible',
          model: ModelId.QWEN,
        },
      });

      const proxyUnmetered = registry.get('local')?.unmetered;
      process.env.CREW_OPENAI_BASE_URL = 'https://api.openai.com/v1';

      expect(proxyUnmetered).toBe(true);
      expect((await registry.load('local'))?.unmetered).toBe(proxyUnmetered);
    } finally {
      if (originalBaseUrl === undefined) {
        delete process.env.CREW_OPENAI_BASE_URL;
      } else {
        process.env.CREW_OPENAI_BASE_URL = originalBaseUrl;
      }
    }
  });

  it('leaves built-in cloud adapters falsy for unmetered', () => {
    const registry = createBuiltinRegistry();

    expect(registry.get('claude-code')?.unmetered).toBeFalsy();
    expect(registry.get('codex')?.unmetered).toBeFalsy();
    expect(registry.get('gemini-cli')?.unmetered).toBeFalsy();
  });

  it('threads custom useWhen through lazy metadata and loaded concrete adapters', async () => {
    const registry = createRegistryFromConfig({
      custom: {
        adapter: 'generic',
        command: 'node',
        strengths: ['scriptable'],
        useWhen: 'Use for local scripted transforms.',
      } as never,
    });

    expect(registry.get('custom')?.useWhen).toBe('Use for local scripted transforms.');
    const [loaded] = await registry.loadAll();
    expect(loaded.useWhen).toBe('Use for local scripted transforms.');
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
    expect(registry.get('claude-code')?.strengths).toEqual(
      BUILTIN_AGENT_ROUTING['claude-code'].strengths,
    );
    expect(registry.get('claude-code')?.useWhen).toBe(
      BUILTIN_AGENT_ROUTING['claude-code'].useWhen,
    );
    expect(registry.get('codex')?.strengths).toEqual(BUILTIN_AGENT_ROUTING.codex.strengths);
    expect(registry.get('codex')?.useWhen).toBe(BUILTIN_AGENT_ROUTING.codex.useWhen);
    expect(registry.get('gemini-cli')?.strengths).toEqual(
      BUILTIN_AGENT_ROUTING['gemini-cli'].strengths,
    );
    expect(registry.get('gemini-cli')?.useWhen).toBe(
      BUILTIN_AGENT_ROUTING['gemini-cli'].useWhen,
    );
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
