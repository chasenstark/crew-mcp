import { describe, expect, it, vi } from 'vitest';
import { listAgents } from '../../../src/orchestrator/tools/list-agents.js';
import type { AdapterRegistry } from '../../../src/adapters/registry.js';
import type { AgentAdapter } from '../../../src/adapters/types.js';

function makeAdapter(overrides: Partial<AgentAdapter> & { name: string }): AgentAdapter {
  return {
    supportsJsonSchema: false,
    capabilities: overrides.capabilities ?? ['analyze'],
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

function makeRegistry(adapters: AgentAdapter[]): AdapterRegistry {
  const map = new Map(adapters.map((a) => [a.name, a]));
  return {
    register: () => undefined,
    get: (name: string) => map.get(name),
    getOrThrow: (name: string) => {
      const a = map.get(name);
      if (!a) throw new Error(`missing: ${name}`);
      return a;
    },
    healthCheckAll: async () => ({}),
    listAvailable: () => Array.from(map.values()),
  } as unknown as AdapterRegistry;
}

describe('listAgents', () => {
  it('surfaces every registered adapter with health info', async () => {
    const registry = makeRegistry([
      makeAdapter({ name: 'codex', capabilities: ['implement', 'review'] }),
      makeAdapter({ name: 'claude-code', capabilities: ['review'] }),
    ]);
    const out = await listAgents({ registry });
    expect(out.agents).toHaveLength(2);
    const byName = Object.fromEntries(out.agents.map((a) => [a.name, a]));
    expect(byName.codex.capabilities).toEqual(['implement', 'review']);
    expect(byName.codex.available).toBe(true);
    expect(byName.codex.authenticated).toBe(true);
  });

  it('surfaces a failing healthCheck as available:false + error, without throwing', async () => {
    const registry = makeRegistry([
      makeAdapter({
        name: 'broken',
        healthCheck: async () => {
          throw new Error('CLI binary not found');
        },
      }),
    ]);
    const out = await listAgents({ registry });
    expect(out.agents[0].available).toBe(false);
    expect(out.agents[0].error).toMatch(/CLI binary not found/);
  });

  it('omits quota when no probe is given', async () => {
    const registry = makeRegistry([makeAdapter({ name: 'codex' })]);
    const out = await listAgents({ registry });
    expect(out.agents[0].quota).toBeUndefined();
  });

  it('includes quota when the probe returns one', async () => {
    const registry = makeRegistry([makeAdapter({ name: 'codex' })]);
    const probe = vi.fn(async () => ({ remainingTokens: 42, resetAt: '2026-05-01' }));
    const out = await listAgents({ registry, quotaProbe: probe });
    expect(out.agents[0].quota).toEqual({ remainingTokens: 42, resetAt: '2026-05-01' });
  });

  it('swallows quota probe errors and omits quota on that agent', async () => {
    const registry = makeRegistry([makeAdapter({ name: 'codex' })]);
    const probe = vi.fn(async () => {
      throw new Error('quota probe failed');
    });
    const out = await listAgents({ registry, quotaProbe: probe });
    expect(out.agents[0].quota).toBeUndefined();
  });

  it('runs health probes concurrently (slow adapter does not block fast one)', async () => {
    const deferred: Array<{ resolve: () => void; promise: Promise<unknown> }> = [];
    function makeGate() {
      let resolve!: () => void;
      const promise = new Promise<unknown>((r) => {
        resolve = () => r(undefined);
      });
      const gate = { promise, resolve };
      deferred.push(gate);
      return gate;
    }
    const slowGate = makeGate();
    const registry = makeRegistry([
      makeAdapter({
        name: 'slow',
        healthCheck: async () => {
          await slowGate.promise;
          return { available: true, authenticated: true };
        },
      }),
      makeAdapter({ name: 'fast' }),
    ]);
    const promise = listAgents({ registry });
    // fast adapter resolves immediately; the slow one is still pending.
    // Trigger the gate and await the combined result.
    slowGate.resolve();
    const out = await promise;
    expect(out.agents.map((a) => a.name).sort()).toEqual(['fast', 'slow']);
  });

  it('surfaces aliases when an adapter declares them', async () => {
    const registry = makeRegistry([
      makeAdapter({ name: 'claude-code', aliases: ['claude'], capabilities: ['review'] }),
      makeAdapter({ name: 'codex', capabilities: ['implement'] }),
    ]);
    const out = await listAgents({ registry });
    const claude = out.agents.find((a) => a.name === 'claude-code');
    const codex = out.agents.find((a) => a.name === 'codex');
    expect(claude?.aliases).toEqual(['claude']);
    // No aliases declared → field omitted entirely (not [] or undefined-explicit).
    expect('aliases' in (codex ?? {})).toBe(false);
  });
});
