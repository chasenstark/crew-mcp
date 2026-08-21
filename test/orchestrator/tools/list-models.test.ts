import { describe, expect, it, vi } from 'vitest';

import { AdapterRegistry } from '../../../src/adapters/registry.js';
import type { AgentAdapter } from '../../../src/adapters/types.js';
import {
  listModelsToolHandler,
  type ListModelsOutput,
} from '../../../src/orchestrator/tools/list-models.js';

function adapter(overrides: Partial<AgentAdapter> = {}): AgentAdapter {
  return {
    name: 'catalog-agent',
    aliases: ['catalog-alias'],
    strengths: [],
    supportsJsonSchema: false,
    modelSelectionSupport: 'catalog',
    execute: async () => ({
      output: '',
      filesModified: [],
      status: 'success',
      metadata: {},
    }),
    healthCheck: async () => ({ available: true, authenticated: true }),
    ...overrides,
  };
}

function deps(registry: AdapterRegistry) {
  return { registry } as Parameters<typeof listModelsToolHandler>[1];
}

describe('list_models', () => {
  it('loads aliases and returns the provider catalog in snake case', async () => {
    const listModels = vi.fn(async () => ({
      support: 'catalog' as const,
      source: 'provider-api' as const,
      authoritative: true,
      models: [{
        model: 'provider/model-1',
        displayName: 'Model One',
        providerId: 'model-1',
        aliases: ['one'],
        isDefault: true,
      }],
      checkedAt: '2026-08-20T00:00:00.000Z',
    }));
    const registry = new AdapterRegistry();
    registry.register(adapter({ listModels }));

    const result = await listModelsToolHandler(
      { agent_id: 'catalog-alias', refresh: true },
      deps(registry),
    );
    const output = result.structuredContent as unknown as ListModelsOutput;
    expect(output).toEqual({
      agent_id: 'catalog-agent',
      support: 'catalog',
      catalog_source: 'provider-api',
      authoritative: true,
      models: [{
        model: 'provider/model-1',
        display_name: 'Model One',
        provider_id: 'model-1',
        aliases: ['one'],
        is_default: true,
      }],
      checked_at: '2026-08-20T00:00:00.000Z',
    });
    expect(listModels).toHaveBeenCalledWith({ refresh: true });
  });

  it('returns unsupported as a capability result', async () => {
    const registry = new AdapterRegistry();
    registry.register(adapter({
      name: 'generic-x',
      aliases: [],
      modelSelectionSupport: 'unsupported',
    }));

    const result = await listModelsToolHandler({ agent_id: 'generic-x' }, deps(registry));
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      agent_id: 'generic-x',
      support: 'unsupported',
      authoritative: true,
      models: [],
      warnings: [expect.stringContaining('does not support')],
    });
  });

  it('returns a tool error for an unknown agent and lists aliases', async () => {
    const registry = new AdapterRegistry();
    registry.register(adapter());

    const result = await listModelsToolHandler({ agent_id: 'missing' }, deps(registry));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('catalog-agent');
    expect(result.content[0].text).toContain('catalog-alias');
  });
});
