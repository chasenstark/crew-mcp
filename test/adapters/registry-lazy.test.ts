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
});
