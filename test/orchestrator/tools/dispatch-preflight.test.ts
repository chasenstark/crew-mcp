import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));

const { execa } = await import('execa');
const mockExeca = vi.mocked(execa);
const { GenericAdapter } = await import('../../../src/adapters/generic.js');
const { OpenAiCompatibleAdapter } = await import(
  '../../../src/adapters/openai-compatible.js'
);

import type { AgentAdapter } from '../../../src/adapters/types.js';
import { preflightAgentDispatch } from '../../../src/orchestrator/tools/dispatch-preflight.js';
import type { QuotaSnapshot } from '../../../src/orchestrator/tools/list-agents.js';
import { HealthCheckCacheMissError } from '../../../src/utils/health-check-cache.js';

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function adapter(
  healthCheck: AgentAdapter['healthCheck'],
): AgentAdapter {
  return {
    name: 'codex',
    strengths: [],
    supportsJsonSchema: false,
    execute: async () => ({ output: 'ok', filesModified: [], status: 'success', metadata: {} }),
    healthCheck,
  };
}

function registry(agent: AgentAdapter) {
  return { get: (name: string) => name === agent.name ? agent : undefined };
}

function quota(overrides: Partial<QuotaSnapshot>): QuotaSnapshot {
  return {
    state: 'ok',
    confidence: 'high',
    source: 'provider',
    checkedAt: '2026-07-21T12:00:00.000Z',
    ...overrides,
  };
}

describe('preflightAgentDispatch', () => {
  it('refuses unavailable agents with and without healthcheck detail', async () => {
    const detailed = await preflightAgentDispatch({
      registry: registry(adapter(async () => ({
        available: false,
        authenticated: false,
        error: 'CLI login expired',
      }))),
      agentId: 'codex',
    });
    expect(detailed.refuse).toEqual({
      code: 'agent_unavailable',
      message: expect.stringMatching(/^agent_unavailable:.*CLI login expired/),
    });

    const noDetail = await preflightAgentDispatch({
      registry: registry(adapter(async () => ({ available: false, authenticated: false }))),
      agentId: 'codex',
    });
    expect(noDetail.refuse?.message).toContain('no healthcheck detail available');
  });

  it('refuses limited quota with and without a reset time', async () => {
    const healthy = adapter(async () => ({ available: true, authenticated: true }));
    const withReset = await preflightAgentDispatch({
      registry: registry(healthy),
      agentId: 'codex',
      quotaProbe: async () => quota({ state: 'limited', resetAt: '2026-07-22T00:00:00Z' }),
    });
    expect(withReset.refuse).toEqual({
      code: 'agent_quota_limited',
      message: expect.stringMatching(/^agent_quota_limited:.*resetAt=2026-07-22T00:00:00Z/),
    });

    const noReset = await preflightAgentDispatch({
      registry: registry(healthy),
      agentId: 'codex',
      quotaProbe: async () => quota({ state: 'limited' }),
    });
    expect(noReset.refuse?.message).toContain('no reset time reported');
  });

  it('warns instead of refusing uncertain limited quota', async () => {
    const healthy = adapter(async () => ({ available: true, authenticated: true }));
    const lowConfidence = await preflightAgentDispatch({
      registry: registry(healthy),
      agentId: 'codex',
      quotaProbe: async () => quota({ state: 'limited', confidence: 'low' }),
    });
    expect(lowConfidence.refuse).toBeUndefined();
    expect(lowConfidence.warnings).toEqual([
      expect.stringMatching(/limited, low confidence/),
    ]);

    const stale = await preflightAgentDispatch({
      registry: registry(healthy),
      agentId: 'codex',
      quotaProbe: async () => quota({
        state: 'limited',
        staleAfter: '2026-07-21T11:00:00.000Z',
      }),
      now: () => new Date('2026-07-21T13:00:00.000Z'),
    });
    expect(stale.refuse).toBeUndefined();
    expect(stale.warnings).toEqual([expect.stringMatching(/limited, stale/)]);
  });

  it('treats limited quota as stale at the exact staleAfter boundary', async () => {
    const healthy = adapter(async () => ({ available: true, authenticated: true }));
    const boundary = '2026-07-21T13:00:00.000Z';
    const result = await preflightAgentDispatch({
      registry: registry(healthy),
      agentId: 'codex',
      quotaProbe: async () => quota({ state: 'limited', staleAfter: boundary }),
      now: () => new Date(boundary),
    });

    expect(result.refuse).toBeUndefined();
    expect(result.warnings).toEqual([
      expect.stringMatching(/^agent_quota_warning:.*limited, stale/),
    ]);
  });

  it('warns for near-limit, stale, and low-confidence quota without refusing', async () => {
    const healthy = adapter(async () => ({ available: true, authenticated: true }));
    const nearLimit = await preflightAgentDispatch({
      registry: registry(healthy),
      agentId: 'codex',
      quotaProbe: async () => quota({ state: 'near_limit' }),
    });
    expect(nearLimit.refuse).toBeUndefined();
    expect(nearLimit.warnings).toEqual([expect.stringContaining('near limit')]);

    const uncertain = await preflightAgentDispatch({
      registry: registry(healthy),
      agentId: 'codex',
      quotaProbe: async () => quota({
        state: 'unknown',
        confidence: 'low',
        staleAfter: '2026-07-21T11:00:00.000Z',
      }),
      now: () => new Date('2026-07-21T13:00:00.000Z'),
    });
    expect(uncertain.refuse).toBeUndefined();
    expect(uncertain.warnings).toEqual([
      expect.stringMatching(/low confidence, stale/),
    ]);
  });

  it('takes no action for ok and local_unmetered quota', async () => {
    const healthy = adapter(async () => ({ available: true, authenticated: true }));
    for (const state of ['ok', 'local_unmetered'] as const) {
      const result = await preflightAgentDispatch({
        registry: registry(healthy),
        agentId: 'codex',
        quotaProbe: async () => quota({ state, confidence: 'low' }),
      });
      expect(result).toEqual({ warnings: [] });
    }
  });

  it('dispatch_anyway downgrades a refusal and probe failures fail open', async () => {
    const unavailable = adapter(async () => ({
      available: false,
      authenticated: false,
      error: 'offline',
    }));
    const overridden = await preflightAgentDispatch({
      registry: registry(unavailable),
      agentId: 'codex',
      dispatchAnyway: true,
    });
    expect(overridden.refuse).toBeUndefined();
    expect(overridden.warnings).toEqual([
      expect.stringMatching(/^agent_unavailable:.*dispatch_anyway:true/),
    ]);

    const failedOpen = await preflightAgentDispatch({
      registry: registry(adapter(async () => { throw new Error('health exploded'); })),
      agentId: 'codex',
      quotaProbe: async () => { throw new Error('quota exploded'); },
    });
    expect(failedOpen.refuse).toBeUndefined();
    expect(failedOpen.warnings).toEqual([
      expect.stringContaining('health exploded'),
      expect.stringContaining('quota exploded'),
    ]);
  });

  it('uses cached-only health and silently fails open on a cold cache', async () => {
    const healthCheck = vi.fn(async () => {
      throw new HealthCheckCacheMissError('codex');
    });
    const result = await preflightAgentDispatch({
      registry: registry(adapter(healthCheck)),
      agentId: 'codex',
    });

    expect(healthCheck).toHaveBeenCalledWith({ cachedOnly: true });
    expect(result).toEqual({ warnings: [] });
  });

  it('refuses warm-known-unavailable generic and OpenAI-compatible agents', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 } as never);
    const generic = new GenericAdapter({
      name: 'generic-test',
      command: 'missing-generic',
      argsTemplate: ['{{prompt}}'],
      strengths: [],
    });
    await generic.healthCheck();

    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 503 });
    vi.stubGlobal('fetch', fetchMock);
    const openAiCompatible = new OpenAiCompatibleAdapter({ name: 'openai-test' });
    await openAiCompatible.healthCheck();

    for (const agent of [generic, openAiCompatible]) {
      const result = await preflightAgentDispatch({
        registry: registry(agent),
        agentId: agent.name,
      });
      expect(result.refuse).toEqual({
        code: 'agent_unavailable',
        message: expect.stringMatching(/^agent_unavailable:/),
      });
    }
    expect(mockExeca).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
