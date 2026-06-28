import type { TaskFailure } from '../adapters/types.js';
import { logBestEffortFailure } from '../utils/best-effort.js';
import type { RunStateV1 } from './run-state.js';
import type { QuotaSnapshot, QuotaState } from './tools/index.js';

export class QuotaCache {
  private readonly snapshots = new Map<string, QuotaSnapshot>();

  record(agentId: string, snapshot: QuotaSnapshot): void {
    this.snapshots.set(agentId, snapshot);
  }

  get(agentId: string): QuotaSnapshot | undefined {
    return this.snapshots.get(agentId);
  }

  clear(): void {
    this.snapshots.clear();
  }
}

interface QuotaSnapshotFromTerminalStateOptions {
  readonly now?: string;
  readonly agentId?: string;
}

interface RecordQuotaObservationOptions {
  readonly resolveCanonicalAgentId?: (agentId: string) => string;
  readonly now?: string;
}

export function quotaSnapshotFromTerminalState(
  state: RunStateV1,
  opts: QuotaSnapshotFromTerminalStateOptions = {},
): QuotaSnapshot | undefined {
  if (state.status === 'cancelled') return undefined;

  const checkedAt = opts.now ?? new Date().toISOString();
  const agentId = opts.agentId ?? state.agentId;
  const source = sourceForAgent(agentId);
  const failure = state.failure;

  if (failure === undefined) {
    if (state.status !== 'success') return undefined;
    return {
      state: 'ok',
      confidence: 'low',
      source,
      checkedAt,
    };
  }

  const quotaState = quotaStateForFailure(failure.kind);
  if (quotaState === undefined) return undefined;

  return {
    state: quotaState,
    confidence: failure.confidence,
    source,
    checkedAt,
    ...(failure.resetAt !== undefined ? { resetAt: failure.resetAt } : {}),
    ...(failure.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: failure.retryAfterSeconds }
      : {}),
    ...(failure.rawSignal !== undefined ? { message: failure.rawSignal } : {}),
  };
}

export function recordQuotaObservation(
  cache: Pick<QuotaCache, 'record'>,
  state: RunStateV1,
  opts: RecordQuotaObservationOptions = {},
): void {
  const agentId = resolveQuotaAgentId(state.agentId, opts.resolveCanonicalAgentId);
  try {
    const snapshot = quotaSnapshotFromTerminalState(state, {
      agentId,
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
    if (snapshot !== undefined) {
      cache.record(agentId, snapshot);
    }
  } catch (err) {
    logBestEffortFailure('quota-cache.record', err);
  }
}

function resolveQuotaAgentId(
  agentId: string,
  resolveCanonicalAgentId?: (agentId: string) => string,
): string {
  if (!resolveCanonicalAgentId) return agentId;
  try {
    return resolveCanonicalAgentId(agentId);
  } catch (err) {
    logBestEffortFailure('quota-cache.resolve', err);
    return agentId;
  }
}

function quotaStateForFailure(kind: TaskFailure['kind']): QuotaState | undefined {
  switch (kind) {
    case 'quota_exhausted':
      return 'limited';
    case 'rate_limited':
      return 'near_limit';
    case 'auth':
    case 'transient':
    case 'process':
    case 'unknown':
      return undefined;
  }
}

function sourceForAgent(agentId: string): QuotaSnapshot['source'] {
  return agentId === 'claude-code' ? 'stream-cache' : 'local-ledger';
}
