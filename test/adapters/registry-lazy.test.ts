import { afterEach, describe, expect, it, vi } from 'vitest';

type AdapterName = 'claude-code' | 'codex' | 'gemini-cli';

function mockAdapterModule(
  exportName: string,
  name: AdapterName,
  onConstruct: () => void,
): Record<string, unknown> {
  return {
    [exportName]: class {
      readonly name = name;
      readonly strengths = [];
      readonly supportsJsonSchema = true;

      constructor() {
        onConstruct();
      }

      async execute() {
        return {
          output: '',
          filesModified: [],
          status: 'success' as const,
          metadata: {},
        };
      }

      async healthCheck() {
        return { available: true, authenticated: true };
      }
    },
  };
}

describe('AdapterRegistry lazy loading', () => {
  afterEach(() => {
    vi.doUnmock('../../src/adapters/claude-code.js');
    vi.doUnmock('../../src/adapters/codex.js');
    vi.doUnmock('../../src/adapters/gemini-cli.js');
    vi.resetModules();
  });

  it('keeps streamsIncrementally identical for lazy proxies and loaded instances', async () => {
    vi.resetModules();
    const { createBuiltinRegistry } = await import('../../src/adapters/registry.js');
    const registry = createBuiltinRegistry();
    const proxyValues = new Map(
      registry.listAvailable().map((adapter) => [adapter.name, adapter.streamsIncrementally]),
    );

    const loaded = await registry.loadAll();
    const loadedValues = new Map(
      loaded.map((adapter) => [adapter.name, adapter.streamsIncrementally]),
    );

    expect(proxyValues.get('claude-code')).toBe(true);
    expect(proxyValues.get('codex')).toBe(true);
    expect(proxyValues.get('gemini-cli')).toBeUndefined();
    expect(loadedValues).toEqual(proxyValues);
  });

  it('does not construct built-in adapter classes until they are loaded', async () => {
    vi.resetModules();
    const constructed = {
      'claude-code': 0,
      codex: 0,
      'gemini-cli': 0,
    };
    vi.doMock('../../src/adapters/claude-code.js', () =>
      mockAdapterModule('ClaudeCodeAdapter', 'claude-code', () => {
        constructed['claude-code'] += 1;
      }),
    );
    vi.doMock('../../src/adapters/codex.js', () =>
      mockAdapterModule('CodexAdapter', 'codex', () => {
        constructed.codex += 1;
      }),
    );
    vi.doMock('../../src/adapters/gemini-cli.js', () =>
      mockAdapterModule('GeminiCliAdapter', 'gemini-cli', () => {
        constructed['gemini-cli'] += 1;
      }),
    );

    const { createBuiltinRegistry } = await import('../../src/adapters/registry.js');
    const registry = createBuiltinRegistry();
    expect(constructed).toEqual({
      'claude-code': 0,
      codex: 0,
      'gemini-cli': 0,
    });

    expect(registry.get('codex')?.name).toBe('codex');
    await registry.load('codex');
    expect(constructed).toEqual({
      'claude-code': 0,
      codex: 1,
      'gemini-cli': 0,
    });

    await registry.load('codex');
    expect(constructed.codex).toBe(1);

    await registry.load('claude');
    expect(constructed['claude-code']).toBe(1);

    await registry.loadAll();
    expect(constructed).toEqual({
      'claude-code': 1,
      codex: 1,
      'gemini-cli': 1,
    });
  });

  it('retries a lazy adapter load after a failed import', async () => {
    vi.resetModules();
    const { AdapterRegistry } = await import('../../src/adapters/registry.js');
    const registry = new AdapterRegistry();
    let attempts = 0;
    const adapter = {
      name: 'retrying',
      strengths: [],
      supportsJsonSchema: true,
      enforcesReadOnly: true,
      execute: async () => ({
        output: 'ok',
        filesModified: [],
        status: 'success' as const,
        metadata: {},
      }),
      healthCheck: async () => ({ available: true, authenticated: true }),
    };

    registry.registerLazy({
      name: 'retrying',
      strengths: [],
      supportsJsonSchema: true,
      enforcesReadOnly: true,
    }, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient import failure');
      return adapter;
    });

    await expect(registry.load('retrying')).rejects.toThrow('transient import failure');
    await expect(registry.load('retrying')).resolves.toBe(adapter);
    expect(attempts).toBe(2);
  });
});
