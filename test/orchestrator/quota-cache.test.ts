import { describe, expect, it } from 'vitest';

import type { RunStateV1, RunStatus } from '../../src/orchestrator/run-state.js';
import {
  QuotaCache,
  QUOTA_SNAPSHOT_MAX_AGE_MS,
  quotaSnapshotFromTerminalState,
  recordQuotaObservation,
} from '../../src/orchestrator/quota-cache.js';
import type { QuotaSnapshot } from '../../src/orchestrator/tools/index.js';

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

describe('QuotaCache', () => {
  it('records, reads, clears, and lets the last observation win', () => {
    const cache = new QuotaCache();
    const first: QuotaSnapshot = {
      state: 'near_limit',
      confidence: 'low',
      source: 'local-ledger',
      checkedAt: '2026-06-28T00:00:00.000Z',
    };
    const second: QuotaSnapshot = {
      state: 'limited',
      confidence: 'high',
      source: 'local-ledger',
      checkedAt: '2026-06-28T00:01:00.000Z',
    };

    expect(cache.get('codex')).toBeUndefined();
    cache.record('codex', first);
    expect(cache.get('codex')).toBe(first);
    cache.record('codex', second);
    expect(cache.get('codex')).toBe(second);
    cache.clear();
    expect(cache.get('codex')).toBeUndefined();
  });

  it('returns non-expired snapshots before staleAfter and expires at the boundary', () => {
    const cache = new QuotaCache();
    const snapshot: QuotaSnapshot = {
      state: 'limited',
      confidence: 'high',
      source: 'local-ledger',
      checkedAt: '2026-06-28T00:00:00.000Z',
      staleAfter: '2026-06-28T01:00:00.000Z',
    };

    cache.record('codex', snapshot);
    expect(cache.get('codex', { now: '2026-06-28T00:59:59.999Z' })).toBe(snapshot);
    expect(cache.get('codex', { now: '2026-06-28T01:00:00.000Z' })).toBeUndefined();
  });

  it('expires after staleAfter and removes the entry from the map', () => {
    const cache = new QuotaCache();
    const snapshot: QuotaSnapshot = {
      state: 'near_limit',
      confidence: 'low',
      source: 'local-ledger',
      checkedAt: '2026-06-28T00:00:00.000Z',
      staleAfter: '2026-06-28T01:00:00.000Z',
    };

    cache.record('codex', snapshot);
    expect(cache.get('codex', { now: '2026-06-28T01:00:00.001Z' })).toBeUndefined();
    expect(cache.get('codex', { now: '2026-06-28T00:30:00.000Z' })).toBeUndefined();
  });

  it('honors a future resetAt instead of expiring at the generic max age', () => {
    const cache = new QuotaCache();
    const checkedAtMs = Date.parse('2026-06-28T00:00:00.000Z');
    const snapshot = quotaSnapshotFromTerminalState(makeState({
      agentId: 'claude-code',
      failure: {
        kind: 'quota_exhausted',
        confidence: 'high',
        resetAt: new Date(checkedAtMs + 5 * QUOTA_SNAPSHOT_MAX_AGE_MS).toISOString(),
      },
    }), { now: new Date(checkedAtMs).toISOString() });

    expect(snapshot).toMatchObject({
      state: 'limited',
      staleAfter: '2026-06-28T05:00:00.000Z',
      resetAt: '2026-06-28T05:00:00.000Z',
    });
    cache.record('claude-code', snapshot!);

    expect(cache.get('claude-code', {
      now: new Date(checkedAtMs + 2 * QUOTA_SNAPSHOT_MAX_AGE_MS).toISOString(),
    })).toBe(snapshot);
    expect(cache.get('claude-code', { now: '2026-06-28T05:00:01.000Z' })).toBeUndefined();
  });

  it('expires resetAt-less limited snapshots after the generic max age', () => {
    const cache = new QuotaCache();
    const checkedAt = '2026-06-28T00:00:00.000Z';
    const snapshot = quotaSnapshotFromTerminalState(makeState({
      failure: {
        kind: 'quota_exhausted',
        confidence: 'high',
      },
    }), { now: checkedAt });

    expect(snapshot).toMatchObject({
      state: 'limited',
      staleAfter: '2026-06-28T01:00:00.000Z',
    });
    cache.record('codex', snapshot!);

    expect(cache.get('codex', { now: '2026-06-28T01:00:00.001Z' })).toBeUndefined();
  });
});

describe('quotaSnapshotFromTerminalState', () => {
  it('maps quota_exhausted failures to limited snapshots', () => {
    const snapshot = quotaSnapshotFromTerminalState(makeState({
      agentId: 'claude-code',
      failure: {
        kind: 'quota_exhausted',
        confidence: 'high',
        resetAt: '2026-06-28T01:00:00.000Z',
        retryAfterSeconds: 3600,
        rawSignal: 'quota exhausted until reset',
      },
    }), { now: '2026-06-28T00:30:00.000Z' });

    expect(snapshot).toEqual({
      state: 'limited',
      confidence: 'high',
      source: 'stream-cache',
      checkedAt: '2026-06-28T00:30:00.000Z',
      resetAt: '2026-06-28T01:00:00.000Z',
      staleAfter: '2026-06-28T01:00:00.000Z',
      retryAfterSeconds: 3600,
      message: 'quota exhausted until reset',
    });
  });

  it('maps rate_limited failures to near_limit snapshots', () => {
    const snapshot = quotaSnapshotFromTerminalState(makeState({
      agentId: 'codex',
      failure: {
        kind: 'rate_limited',
        confidence: 'low',
        resetAt: '2026-06-28T02:00:00.000Z',
        retryAfterSeconds: 120,
      },
    }), { now: '2026-06-28T00:30:00.000Z' });

    expect(snapshot).toEqual({
      state: 'near_limit',
      confidence: 'low',
      source: 'local-ledger',
      checkedAt: '2026-06-28T00:30:00.000Z',
      resetAt: '2026-06-28T02:00:00.000Z',
      staleAfter: '2026-06-28T02:00:00.000Z',
      retryAfterSeconds: 120,
    });
  });

  it('sets staleAfter from checkedAt plus max age when failures have no resetAt', () => {
    const snapshot = quotaSnapshotFromTerminalState(makeState({
      agentId: 'codex',
      failure: {
        kind: 'quota_exhausted',
        confidence: 'high',
      },
    }), { now: '2026-06-28T00:30:00.000Z' });

    expect(snapshot).toMatchObject({
      state: 'limited',
      checkedAt: '2026-06-28T00:30:00.000Z',
      staleAfter: '2026-06-28T01:30:00.000Z',
    });
  });

  it('maps clean success terminals to low-confidence ok snapshots', () => {
    const snapshot = quotaSnapshotFromTerminalState(makeState({
      agentId: 'claude-code',
      status: 'success',
      failure: undefined,
    }), { now: '2026-06-28T00:30:00.000Z' });

    expect(snapshot).toEqual({
      state: 'ok',
      confidence: 'low',
      source: 'stream-cache',
      checkedAt: '2026-06-28T00:30:00.000Z',
      staleAfter: '2026-06-28T01:30:00.000Z',
    });
  });

  it.each([
    ['auth', 'error'],
    ['transient', 'error'],
    ['process', 'error'],
    ['unknown', 'error'],
  ] as const)('does not map %s failures', (kind) => {
    expect(quotaSnapshotFromTerminalState(makeState({
      failure: { kind, confidence: 'high' },
    }), { now: '2026-06-28T00:30:00.000Z' })).toBeUndefined();
  });

  it.each([
    ['cancelled', undefined],
    ['error', undefined],
    ['partial', undefined],
  ] as const)('does not map %s terminals without a quota observation', (status, failure) => {
    expect(quotaSnapshotFromTerminalState(makeState({
      status: status as RunStatus,
      failure,
    }), { now: '2026-06-28T00:30:00.000Z' })).toBeUndefined();
  });

  it('does not map cancelled terminals even if a failure is present', () => {
    expect(quotaSnapshotFromTerminalState(makeState({
      status: 'cancelled',
      failure: {
        kind: 'quota_exhausted',
        confidence: 'high',
      },
    }), { now: '2026-06-28T00:30:00.000Z' })).toBeUndefined();
  });
});

describe('recordQuotaObservation', () => {
  it('records mapped snapshots and swallows cache write failures', () => {
    const cache = new QuotaCache();
    recordQuotaObservation(cache, makeState({
      agentId: 'codex',
      failure: {
        kind: 'rate_limited',
        confidence: 'high',
      },
    }));
    expect(cache.get('codex')?.state).toBe('near_limit');

    const throwingCache = {
      record: () => {
        throw new Error('cache unavailable');
      },
    };
    expect(() => recordQuotaObservation(throwingCache, makeState({
      failure: {
        kind: 'quota_exhausted',
        confidence: 'high',
      },
    }))).not.toThrow();
  });

  it('records under the canonical agent id and derives source from it', () => {
    const cache = new QuotaCache();
    recordQuotaObservation(cache, makeState({
      agentId: 'claude',
      failure: {
        kind: 'quota_exhausted',
        confidence: 'high',
      },
    }), {
      now: '2026-06-28T00:30:00.000Z',
      resolveCanonicalAgentId: (agentId) => (agentId === 'claude' ? 'claude-code' : agentId),
    });

    expect(cache.get('claude')).toBeUndefined();
    expect(cache.get('claude-code', { now: '2026-06-28T00:45:00.000Z' })).toMatchObject({
      state: 'limited',
      confidence: 'high',
      source: 'stream-cache',
      checkedAt: '2026-06-28T00:30:00.000Z',
    });
  });

  it('falls back to the raw agent id when canonical resolution fails', () => {
    const cache = new QuotaCache();
    recordQuotaObservation(cache, makeState({
      agentId: 'claude',
      failure: {
        kind: 'quota_exhausted',
        confidence: 'high',
      },
    }), {
      now: '2026-06-28T00:30:00.000Z',
      resolveCanonicalAgentId: () => {
        throw new Error('registry unavailable');
      },
    });

    expect(cache.get('claude-code')).toBeUndefined();
    expect(cache.get('claude', { now: '2026-06-28T00:45:00.000Z' })).toMatchObject({
      state: 'limited',
      confidence: 'high',
      source: 'local-ledger',
      checkedAt: '2026-06-28T00:30:00.000Z',
    });
  });
});
