import { describe, expect, it, vi } from 'vitest';
import { listAgents } from '../../../src/orchestrator/tools/list-agents.js';
import { BUILTIN_AGENT_ROUTING } from '../../../src/adapters/strengths.js';
import type { AdapterRegistry } from '../../../src/adapters/registry.js';
import type { AgentAdapter } from '../../../src/adapters/types.js';
import type { QuotaSnapshot } from '../../../src/orchestrator/tools/list-agents.js';

function makeAdapter(overrides: Partial<AgentAdapter> & { name: string }): AgentAdapter {
  return {
    supportsJsonSchema: false,
    strengths: overrides.strengths ?? [],
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
      makeAdapter({
        name: 'codex',
        strengths: [...BUILTIN_AGENT_ROUTING.codex.strengths],
        useWhen: BUILTIN_AGENT_ROUTING.codex.useWhen,
      }),
      makeAdapter({ name: 'claude-code', strengths: ['code-review'] }),
    ]);
    const out = await listAgents({ registry });
    expect(out.agents).toHaveLength(2);
    const byName = Object.fromEntries(out.agents.map((a) => [a.name, a]));
    expect(byName.codex.strengths).toEqual(BUILTIN_AGENT_ROUTING.codex.strengths);
    expect(byName.codex.useWhen).toBe(BUILTIN_AGENT_ROUTING.codex.useWhen);
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
    expect('quota' in out.agents[0]).toBe(false);
  });

  it('includes quota when the probe returns one', async () => {
    const registry = makeRegistry([makeAdapter({ name: 'codex' })]);
    const snapshot: QuotaSnapshot = {
      state: 'near_limit',
      confidence: 'medium',
      source: 'stream-cache',
      checkedAt: '2026-06-26T00:00:00Z',
      usedPercent: 80,
      resetAt: '2026-05-01',
    };
    const probe = vi.fn(async () => snapshot);
    const out = await listAgents({ registry, quotaProbe: probe });
    expect(out.agents[0].quota).toBe(snapshot);
  });

  it('passes through full quota snapshots unchanged', async () => {
    const registry = makeRegistry([makeAdapter({ name: 'codex' })]);
    const snapshot: QuotaSnapshot = {
      state: 'limited',
      confidence: 'high',
      source: 'provider',
      checkedAt: '2026-06-26T00:00:00Z',
      staleAfter: '2026-06-26T00:01:00Z',
      usedPercent: 100,
      remainingTokens: 0,
      remainingRequests: 0,
      resetAt: '2026-06-26T01:00:00Z',
      retryAfterSeconds: 3600,
      message: 'Quota exhausted until reset.',
    };
    const probe = vi.fn(async () => snapshot);
    const out = await listAgents({ registry, quotaProbe: probe });
    expect(out.agents[0].quota).toBe(snapshot);
  });

  it('swallows quota probe errors and omits quota on that agent', async () => {
    const registry = makeRegistry([makeAdapter({ name: 'codex' })]);
    const probe = vi.fn(async () => {
      throw new Error('quota probe failed');
    });
    const out = await listAgents({ registry, quotaProbe: probe });
    expect(out.agents[0].quota).toBeUndefined();
    expect('quota' in out.agents[0]).toBe(false);
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
      makeAdapter({ name: 'claude-code', aliases: ['claude'], strengths: ['code-review'] }),
      makeAdapter({ name: 'codex', strengths: ['fast-iteration'] }),
    ]);
    const out = await listAgents({ registry });
    const claude = out.agents.find((a) => a.name === 'claude-code');
    const codex = out.agents.find((a) => a.name === 'codex');
    expect(claude?.aliases).toEqual(['claude']);
    // No aliases declared → field omitted entirely (not [] or undefined-explicit).
    expect('aliases' in (codex ?? {})).toBe(false);
  });

  it('merges agent-prefs file overrides on top of adapter defaults', async () => {
    const registry = makeRegistry([
      makeAdapter({ name: 'codex', strengths: ['fast-iteration'], defaultEffort: 'medium' }),
      makeAdapter({ name: 'claude-code', strengths: ['code-review'] }),
    ]);
    const out = await listAgents({
      registry,
      agentPrefs: {
        codex: { strengths: ['user-override'], effort: 'high' },
        // claude-code untouched → adapter defaults pass through.
      },
    });
    const byName = Object.fromEntries(out.agents.map((a) => [a.name, a]));
    expect(byName.codex.strengths).toEqual(['user-override']);
    expect(byName.codex.effort).toBe('high');
    expect(byName['claude-code'].strengths).toEqual(['code-review']);
    // claude-code adapter has no defaultEffort and no override → effort omitted.
    expect('effort' in byName['claude-code']).toBe(false);
  });

  it('omits effort when adapter has no defaultEffort and no override exists', async () => {
    const registry = makeRegistry([
      makeAdapter({ name: 'gemini-cli', strengths: ['long-context'] }),
    ]);
    const out = await listAgents({ registry });
    expect('effort' in out.agents[0]).toBe(false);
  });

  it('surfaces a per-machine model override from agents.json', async () => {
    const registry = makeRegistry([
      makeAdapter({ name: 'claude-code', strengths: [] }),
    ]);
    const out = await listAgents({
      registry,
      agentPrefs: { 'claude-code': { model: 'claude-opus-4-7' } },
    });
    expect(out.agents[0].model).toBe('claude-opus-4-7');
  });

  it('lets agents.json useWhen override adapter guidance', async () => {
    const registry = makeRegistry([
      makeAdapter({
        name: 'codex',
        strengths: ['fast-iteration'],
        useWhen: 'Default routing guidance.',
      }),
    ]);
    const out = await listAgents({
      registry,
      agentPrefs: {
        codex: { useWhen: 'Use this Codex for quick implementation.' },
      },
    });
    expect(out.agents[0].useWhen).toBe('Use this Codex for quick implementation.');
  });

  it('surfaces useWhen for a lazy-loaded custom agent', async () => {
    const { AdapterRegistry, mergeCustomAgents } = await import('../../../src/adapters/registry.js');
    const registry = new AdapterRegistry();
    mergeCustomAgents(registry, {
      shell: {
        adapter: 'generic',
        command: 'node',
        strengths: ['scriptable'],
        useWhen: 'Use for local scripted checks.',
      },
    });

    const out = await listAgents({ registry });
    expect(out.agents[0]).toMatchObject({
      name: 'shell',
      strengths: ['scriptable'],
      useWhen: 'Use for local scripted checks.',
    });
  });

  it('omits model when no per-machine override exists', async () => {
    // Adapters intentionally don't ship a default model — the CLI's
    // own config wins. So absence is the correct signal here, not [].
    const registry = makeRegistry([
      makeAdapter({ name: 'codex', strengths: [] }),
    ]);
    const out = await listAgents({ registry });
    expect('model' in out.agents[0]).toBe(false);
  });
});
