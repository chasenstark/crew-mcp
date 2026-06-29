import { describe, expect, it, vi } from 'vitest';

import type { AdapterRegistry } from '../../../src/adapters/registry.js';
import type { AgentAdapter } from '../../../src/adapters/types.js';
import type { RunStateV1 } from '../../../src/orchestrator/run-state.js';
import { QuotaCache, probeQuota, quotaSnapshotFromTerminalState } from '../../../src/orchestrator/quota-cache.js';
import {
  listAgentsToolHandler,
  type ListAgentsOutput,
} from '../../../src/orchestrator/tools/list-agents.js';

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

function makeState(overrides: Partial<RunStateV1> = {}): RunStateV1 {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    agentId: 'codex',
    status: 'error',
    startedAt: '2026-06-28T00:00:00.000Z',
    worktreePath: '/tmp/worktree',
    prompts: [],
    filesChanged: [],
    ...overrides,
  };
}

describe('listAgentsToolHandler quota cache wiring', () => {
  it('surfaces terminal quota observations and omits quota for agents without observations', async () => {
    const cache = new QuotaCache();
    const snapshot = quotaSnapshotFromTerminalState(makeState({
      agentId: 'codex',
      failure: {
        kind: 'quota_exhausted',
        confidence: 'high',
        retryAfterSeconds: 300,
      },
    }), { now: '2026-06-28T00:30:00.000Z' });
    expect(snapshot).toBeDefined();
    cache.record('codex', snapshot!);

    const out = await listAgentsToolHandler({}, {
      registry: makeRegistry([
        makeAdapter({ name: 'codex' }),
        makeAdapter({ name: 'claude-code' }),
      ]),
      readAgentPrefs: () => ({}),
      quotaProbe: async (agentName) => cache.get(agentName, {
        now: '2026-06-28T00:45:00.000Z',
      }),
    });
    const structured = out.structuredContent as unknown as ListAgentsOutput;
    const byName = Object.fromEntries(structured.agents.map((agent) => [agent.name, agent]));

    expect(byName.codex.quota).toEqual(snapshot);
    expect(byName['claude-code'].quota).toBeUndefined();
    expect('quota' in byName['claude-code']).toBe(false);
  });

  it('clears the cache before probing on refresh', async () => {
    const cache = new QuotaCache();
    cache.record('codex', {
      state: 'limited',
      confidence: 'high',
      source: 'local-ledger',
      checkedAt: '2026-06-28T00:30:00.000Z',
    });
    const clear = vi.fn(() => cache.clear());

    const out = await listAgentsToolHandler({ refresh: true }, {
      registry: makeRegistry([makeAdapter({ name: 'codex' })]),
      readAgentPrefs: () => ({}),
      quotaProbe: async (agentName) => cache.get(agentName),
      clearQuotaCache: clear,
    });
    const structured = out.structuredContent as unknown as ListAgentsOutput;

    expect(clear).toHaveBeenCalledTimes(1);
    expect(structured.agents[0].quota).toBeUndefined();
    expect('quota' in structured.agents[0]).toBe(false);
  });

  it('surfaces synthesized local_unmetered quota for unmetered agents without observations', async () => {
    const cache = new QuotaCache();

    const out = await listAgentsToolHandler({}, {
      registry: makeRegistry([
        makeAdapter({ name: 'local', unmetered: true }),
      ]),
      readAgentPrefs: () => ({}),
      quotaProbe: async (agentName) => probeQuota(cache, agentName, {
        unmetered: true,
        now: '2026-06-28T00:30:00.000Z',
      }),
    });
    const structured = out.structuredContent as unknown as ListAgentsOutput;

    expect(structured.agents[0].quota).toEqual({
      state: 'local_unmetered',
      confidence: 'high',
      source: 'health-only',
      checkedAt: '2026-06-28T00:30:00.000Z',
    });
  });

  it('swallows refresh clear failures and still returns list_agents output', async () => {
    const out = await listAgentsToolHandler({ refresh: true }, {
      registry: makeRegistry([makeAdapter({ name: 'codex' })]),
      readAgentPrefs: () => ({}),
      quotaProbe: async () => undefined,
      clearQuotaCache: () => {
        throw new Error('clear failed');
      },
    });
    const structured = out.structuredContent as unknown as ListAgentsOutput;

    expect(structured.agents).toHaveLength(1);
    expect(structured.agents[0].name).toBe('codex');
  });
});
