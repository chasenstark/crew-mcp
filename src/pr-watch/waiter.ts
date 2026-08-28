import { randomUUID } from 'node:crypto';

import {
  runClaimedCodexPrWatchWake,
  type ClaimedCodexWakeResult,
} from '../codex/wake-delivery.js';
import { appendPrWatchProcessTrace } from './process-trace.js';
import {
  claimPrWatchWaiter,
  claimPrWatchSurface,
  deliverPrWatchSurface,
  exitPrWatchWaiter,
  heartbeatPrWatchWaiter,
} from './reducer.js';
import type { PrWatchController } from './controller.js';
import type { PrWatchStore } from './store.js';
import type { PrWatchStateV1, PrWatchStatus } from './types.js';

const DEFAULT_POLL_INTERVAL_MS = 120_000;
const DEFAULT_LEASE_MS = 180_000;

export interface PrWatchWakeRequest {
  readonly state: Exclude<PrWatchStateV1, { readonly status: 'active' }>;
  readonly startCodexTurn?: () => Promise<unknown>;
  readonly threadId?: string;
  readonly transport: 'claude_completion' | 'codex_app_server' | 'codex_queue';
}

export interface PrWatchWakeDeliveryResult {
  readonly started: boolean;
}

export interface WaitForPrWatchOptions {
  readonly store: PrWatchStore;
  readonly controller: PrWatchController;
  readonly watchId: string;
  readonly generation: number;
  readonly watcherActionId: string;
  readonly ownerId?: string;
  readonly pollIntervalMs?: number;
  readonly leaseMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly wake?: (request: PrWatchWakeRequest) => Promise<PrWatchWakeDeliveryResult | void>;
  readonly transport?: PrWatchWakeRequest['transport'];
}

export interface WaitForPrWatchResult {
  readonly state: PrWatchStateV1;
  readonly outcome: PrWatchStatus | 'timeout';
}

export async function waitForPrWatch(
  options: WaitForPrWatchOptions,
): Promise<WaitForPrWatchResult> {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? abortableSleep;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs
    ?? Math.min(60_000, Math.floor(leaseMs / 3));
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new Error('pr_watch.invalid_poll_interval');
  }
  if (leaseMs <= pollIntervalMs || leaseMs < 60_000) {
    throw new Error('pr_watch.invalid_waiter_lease');
  }
  if (
    !Number.isSafeInteger(heartbeatIntervalMs)
    || heartbeatIntervalMs < 1
    || heartbeatIntervalMs >= leaseMs
  ) {
    throw new Error('pr_watch.invalid_waiter_heartbeat_interval');
  }
  const ownerId = options.ownerId ?? randomUUID();
  const startedAt = now();
  await options.store.repairCache(options.watchId);
  await options.store.mutate(options.watchId, (state) => claimPrWatchWaiter(state, {
    watcherActionId: options.watcherActionId,
    generation: options.generation,
    leaseOwnerId: ownerId,
    leaseMs,
    now: startedAt,
  }));
  appendPrWatchProcessTrace(options.store.crewHome, {
    event: 'start',
    ts: startedAt.toISOString(),
    watchId: options.watchId,
    generation: options.generation,
    watcherActionId: options.watcherActionId,
    ownerId,
    pid: process.pid,
  });

  try {
    for (;;) {
      if (options.signal?.aborted) {
        const state = await exitIfOwned(options, ownerId, 'cancelled', now());
        return finish(options, state, state.status);
      }
      const observed = options.store.read(options.watchId).state;
      if (observed.status !== 'active') {
        await deliverWake(options, observed);
        return finish(options, observed, observed.status);
      }
      if (options.timeoutMs !== undefined && now().getTime() - startedAt.getTime() >= options.timeoutMs) {
        const state = await exitIfOwned(options, ownerId, 'timeout', now());
        return finish(options, state, 'timeout');
      }
      await options.store.mutate(options.watchId, (state) => heartbeatPrWatchWaiter(state, {
        watcherActionId: options.watcherActionId,
        generation: options.generation,
        leaseOwnerId: ownerId,
        leaseMs,
        now: now(),
      }));
      const polled = await pollWithLeaseHeartbeats({
        options,
        ownerId,
        leaseMs,
        heartbeatIntervalMs,
        now,
      });
      if (polled.state.status !== 'active') {
        await deliverWake(options, polled.state);
        return finish(options, polled.state, polled.state.status);
      }
      await sleep(pollIntervalMs, options.signal);
    }
  } catch (error) {
    appendPrWatchProcessTrace(options.store.crewHome, {
      event: 'exit',
      ts: now().toISOString(),
      watchId: options.watchId,
      generation: options.generation,
      status: error instanceof Error && error.message.includes('lease_lost') ? 'lease_lost' : 'error',
    });
    throw error;
  }
}

async function pollWithLeaseHeartbeats(args: {
  readonly options: WaitForPrWatchOptions;
  readonly ownerId: string;
  readonly leaseMs: number;
  readonly heartbeatIntervalMs: number;
  readonly now: () => Date;
}): Promise<Awaited<ReturnType<PrWatchController['pollOnce']>>> {
  const stopHeartbeat = new AbortController();
  const abortPoll = new AbortController();
  const heartbeatSignal = combineSignals([args.options.signal, stopHeartbeat.signal]);
  const pollSignal = combineSignals([args.options.signal, abortPoll.signal]);
  let stopping = false;
  let rejectHeartbeatFailure!: (error: unknown) => void;
  const heartbeatFailure = new Promise<never>((_resolve, reject) => {
    rejectHeartbeatFailure = reject;
  });
  const heartbeat = (async () => {
    try {
      for (;;) {
        await abortableSleep(args.heartbeatIntervalMs, heartbeatSignal);
        await args.options.store.mutate(args.options.watchId, (state) => heartbeatPrWatchWaiter(state, {
          watcherActionId: args.options.watcherActionId,
          generation: args.options.generation,
          leaseOwnerId: args.ownerId,
          leaseMs: args.leaseMs,
          now: args.now(),
        }));
      }
    } catch (error) {
      if (stopping) return;
      const failure = args.options.signal?.aborted
        ? new Error('pr_watch.waiter_cancelled')
        : error;
      // Settle our side of the race before aborting the provider. Some
      // controller implementations may ignore AbortSignal, while compliant
      // ones can reject synchronously from their abort listener.
      rejectHeartbeatFailure(failure);
      abortPoll.abort(failure);
    }
  })();

  try {
    return await Promise.race([
      args.options.controller.pollOnce(args.options.watchId, { signal: pollSignal }),
      heartbeatFailure,
    ]);
  } finally {
    stopping = true;
    stopHeartbeat.abort();
    await heartbeat;
  }
}

function combineSignals(signals: readonly (AbortSignal | undefined)[]): AbortSignal | undefined {
  const defined = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (defined.length === 0) return undefined;
  if (defined.length === 1) return defined[0];
  return AbortSignal.any(defined);
}

async function deliverWake(
  options: WaitForPrWatchOptions,
  state: Exclude<PrWatchStateV1, { readonly status: 'active' }>,
): Promise<void> {
  const transport = options.transport ?? 'claude_completion';
  const surfaceId = state.status === 'blocked'
    ? state.currentBlockerSurfaceId
    : state.status === 'expired'
      ? state.currentExpirySurfaceId
      : undefined;
  const requestId = surfaceId ? randomUUID() : undefined;
  let attempt: number | undefined;
  if (surfaceId && requestId) {
    try {
      const claimed = await options.store.mutate(state.watchId, (current) => claimPrWatchSurface(
        current,
        { surfaceId, requestId, leaseMs: 60_000, now: new Date() },
      ));
      const surface = [...claimed.state.blockerSurfaces, ...claimed.state.expirySurfaces]
        .find((candidate) => candidate.surfaceId === surfaceId);
      attempt = surface?.latestClaimAttempt;
    } catch {
      return;
    }
  }
  const wake = await options.wake?.({ state, transport });
  appendPrWatchProcessTrace(options.store.crewHome, {
    event: 'wake',
    ts: new Date().toISOString(),
    watchId: state.watchId,
    generation: state.generation,
    status: state.status,
    transport,
  });
  if (surfaceId !== undefined && wake !== undefined && wake.started !== false) {
    try {
      await options.store.mutate(state.watchId, (current) => deliverPrWatchSurface(current, {
        surfaceId,
        ...(requestId ? { requestId } : {}),
        ...(attempt !== undefined ? { attempt } : {}),
        via: 'waiter_wake',
        now: new Date(),
      }));
    } catch {
      // JIT delivery or closure may have won. The wake itself is still valid.
    }
  }
}

export async function deliverClaimedCodexPrWatchWake(
  options: {
    readonly store: PrWatchStore;
    readonly state: Exclude<PrWatchStateV1, { readonly status: 'active' }>;
    readonly threadId: string;
    readonly startTurn: () => Promise<unknown>;
  },
): Promise<ClaimedCodexWakeResult<unknown>> {
  return runClaimedCodexPrWatchWake({
    store: options.store,
    threadId: options.threadId,
    watchId: options.state.watchId,
    generation: options.state.generation,
    startTurn: options.startTurn,
  });
}

async function exitIfOwned(
  options: WaitForPrWatchOptions,
  ownerId: string,
  reason: 'timeout' | 'cancelled',
  now: Date,
): Promise<PrWatchStateV1> {
  try {
    return (await options.store.mutate(options.watchId, (state) => exitPrWatchWaiter(state, {
      watcherActionId: options.watcherActionId,
      generation: options.generation,
      leaseOwnerId: ownerId,
      reason,
      now,
    }))).state;
  } catch (error) {
    if (error instanceof Error && error.message.includes('waiter_lease_lost')) {
      return options.store.read(options.watchId).state;
    }
    throw error;
  }
}

function finish(
  options: WaitForPrWatchOptions,
  state: PrWatchStateV1,
  outcome: PrWatchStatus | 'timeout',
): WaitForPrWatchResult {
  appendPrWatchProcessTrace(options.store.crewHome, {
    event: 'exit',
    ts: new Date().toISOString(),
    watchId: options.watchId,
    generation: options.generation,
    status: outcome,
  });
  return { state, outcome };
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('pr_watch.waiter_cancelled'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      operation();
    };
    const onAbort = (): void => {
      clearTimeout(timer);
      finish(() => reject(new Error('pr_watch.waiter_cancelled')));
    };
    const timer = setTimeout(() => finish(resolve), ms);
    // This referenced timer owns the standalone waiter's process lifetime.
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
