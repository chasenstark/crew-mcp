import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { sha256Canonical } from '../../src/pr-watch/canonical.js';
import {
  PrWatchDeadlineController,
  type PrWatchControllerClock,
} from '../../src/pr-watch/deadline-controller.js';
import { makePrWatchId, makePrWatchTransactionId } from '../../src/pr-watch/id.js';
import {
  claimPrWatchSurface,
  createInitialPrWatchState,
  recordObservedEvents,
  transitionToActionable,
  transitionToBlocked,
} from '../../src/pr-watch/reducer.js';
import { PrWatchStore } from '../../src/pr-watch/store.js';
import {
  PrWatchSurfaceLeaseController,
  type PrWatchSurfaceLeaseClock,
} from '../../src/pr-watch/surface-lease-controller.js';
import type { PrWatchBlockerCauseV1, PrWatchEventRecordV1, PrWatchStartInitializationV1 } from '../../src/pr-watch/types.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('PrWatchDeadlineController', () => {
  it.each(['actionable', 'blocked'] as const)('expires waiter-less %s state exactly once', async (variant) => {
    const store = new PrWatchStore(tempRoot());
    const watchId = makePrWatchId();
    const deadline = new Date('2026-08-27T12:00:00.000Z');
    await store.create(createInitialPrWatchState({
      watchId,
      initialization: initialization(deadline),
      now: new Date(deadline.getTime() - 10_000),
    }), makePrWatchTransactionId());
    if (variant === 'actionable') {
      await store.mutate(watchId, (state) => recordObservedEvents(
        state,
        [event('event-1')],
        new Date(deadline.getTime() - 9000),
      ));
      await store.mutate(watchId, (state) => transitionToActionable(state, {
        eventIds: ['event-1'],
        inclusiveLedgerSequenceWatermark: 2,
        now: new Date(deadline.getTime() - 8000),
      }));
    } else {
      await store.mutate(watchId, (state) => transitionToBlocked(state, {
        blocker: blocker(),
        now: new Date(deadline.getTime() - 8000),
      }));
    }
    const clock = fakeClock(deadline.getTime());
    const controller = new PrWatchDeadlineController(store, clock);
    await controller.start();
    const first = store.read(watchId);
    expect(first.state.status).toBe('expired');
    if (first.state.status !== 'expired') throw new Error('expected expired');
    expect(first.state.suspendedState.status).toBe(variant);
    expect(first.state.expirySurfaces).toHaveLength(1);
    const sequence = first.checkpoint.ledgerSequence;
    await controller.sweep();
    expect(store.read(watchId).checkpoint.ledgerSequence).toBe(sequence);
    controller.stop();
  });

  it('tracks a watch created and transitioned after controller startup', async () => {
    const store = new PrWatchStore(tempRoot());
    const deadline = new Date('2026-08-27T12:00:10.000Z');
    const clock = mutableClock(deadline.getTime() - 10_000);
    const controller = new PrWatchDeadlineController(store, clock);
    const unsubscribe = store.onCommit((state) => controller.register(state));
    await controller.start();

    const watchId = makePrWatchId();
    await store.create(createInitialPrWatchState({
      watchId,
      initialization: initialization(deadline),
      now: new Date(deadline.getTime() - 9000),
    }), makePrWatchTransactionId());
    await store.mutate(watchId, (state) => transitionToBlocked(state, {
      blocker: blocker(),
      now: new Date(deadline.getTime() - 8000),
    }));

    clock.advanceTo(deadline.getTime());
    await controller.sweep();
    expect(store.read(watchId).state.status).toBe('expired');
    unsubscribe();
    controller.stop();
  });

  it('preserves a newer registration when a popped deadline entry loses a race', async () => {
    const store = new PrWatchStore(tempRoot());
    const deadline = new Date('2026-08-27T12:00:10.000Z');
    const clock = mutableClock(deadline.getTime() - 10_000);
    const watchId = makePrWatchId();
    await store.create(createInitialPrWatchState({
      watchId,
      initialization: initialization(deadline),
      now: new Date(deadline.getTime() - 9000),
    }), makePrWatchTransactionId());
    const controller = new PrWatchDeadlineController(store, clock);
    const unsubscribe = store.onCommit((state) => controller.register(state));
    await controller.start();
    clock.advanceTo(deadline.getTime());

    let staleSweep!: Promise<void>;
    await store.withWatchLock(watchId, async () => {
      staleSweep = controller.sweep();
      store.mutateLocked(watchId, (state) => transitionToBlocked(state, {
        blocker: blocker(),
        now: new Date(deadline.getTime() - 1),
      }));
    });
    await staleSweep;
    expect(store.read(watchId).state.status).toBe('blocked');

    await controller.sweep();
    expect(store.read(watchId).state.status).toBe('expired');
    unsubscribe();
    controller.stop();
  });
});

describe('PrWatchSurfaceLeaseController', () => {
  it('recovers an expired claim without restart and preserves its failed attempt', async () => {
    const store = new PrWatchStore(tempRoot());
    const watchId = makePrWatchId();
    const t0 = new Date('2026-08-27T12:00:00.000Z');
    await store.create(createInitialPrWatchState({
      watchId,
      initialization: initialization(),
      now: t0,
    }), makePrWatchTransactionId());
    let surfaceId = '';
    await store.mutate(watchId, (state) => {
      const result = transitionToBlocked(state, { blocker: blocker(), now: t0 });
      if (result.state.status !== 'blocked') throw new Error('expected blocked');
      surfaceId = result.state.currentBlockerSurfaceId;
      return result;
    });
    await store.mutate(watchId, (state) => claimPrWatchSurface(state, {
      surfaceId,
      requestId: 'request-1',
      leaseMs: 1000,
      now: t0,
    }));
    const controller = new PrWatchSurfaceLeaseController(
      store,
      fakeClock(t0.getTime() + 1001),
    );
    await controller.start();
    const state = store.read(watchId).state;
    const surface = state.blockerSurfaces.find((entry) => entry.surfaceId === surfaceId);
    expect(surface?.state).toBe('pending');
    expect(surface?.latestClaimAttempt).toBe(1);
    expect(surface?.attempts[0].outcome).toBe('lease_expired');
    controller.stop();
  });

  it('tracks and recovers a claim committed after controller startup', async () => {
    const store = new PrWatchStore(tempRoot());
    const t0 = new Date('2026-08-27T12:00:00.000Z');
    const clock = mutableClock(t0.getTime());
    const controller = new PrWatchSurfaceLeaseController(store, clock);
    const unsubscribe = store.onCommit((state) => controller.register(state));
    await controller.start();

    const watchId = makePrWatchId();
    await store.create(createInitialPrWatchState({
      watchId,
      initialization: initialization(),
      now: t0,
    }), makePrWatchTransactionId());
    let surfaceId = '';
    await store.mutate(watchId, (state) => {
      const result = transitionToBlocked(state, { blocker: blocker(), now: t0 });
      if (result.state.status !== 'blocked') throw new Error('expected blocked');
      surfaceId = result.state.currentBlockerSurfaceId;
      return result;
    });
    await store.mutate(watchId, (state) => claimPrWatchSurface(state, {
      surfaceId,
      requestId: 'late-request',
      leaseMs: 1000,
      now: t0,
    }));

    clock.advanceTo(t0.getTime() + 1001);
    await controller.preflightSweep();
    const surface = store.read(watchId).state.blockerSurfaces
      .find((entry) => entry.surfaceId === surfaceId);
    expect(surface?.state).toBe('pending');
    expect(surface?.attempts[0].outcome).toBe('lease_expired');
    unsubscribe();
    controller.stop();
  });
});

function fakeClock(now: number): PrWatchControllerClock & PrWatchSurfaceLeaseClock {
  return {
    now: () => now,
    setTimeout: () => ({ unref: () => undefined }) as unknown as NodeJS.Timeout,
    clearTimeout: () => undefined,
  };
}

function mutableClock(initialNow: number): (
  PrWatchControllerClock
  & PrWatchSurfaceLeaseClock
  & { readonly advanceTo: (now: number) => void }
) {
  let now = initialNow;
  return {
    now: () => now,
    advanceTo: (next) => { now = next; },
    setTimeout: () => ({ unref: () => undefined }) as unknown as NodeJS.Timeout,
    clearTimeout: () => undefined,
  };
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'crew-pr-watch-controller-'));
  roots.push(root);
  return root;
}

function initialization(deadline?: Date): PrWatchStartInitializationV1 {
  return {
    repository: 'example/repo',
    anchorPrNumber: 42,
    repoRoot: '/tmp/example',
    effectiveConfig: {
      maxPrs: 50,
      maxActionableWakes: 20,
      maxActionRounds: 5,
      maxWatchAgeDays: deadline ? 14 : -1,
      policyHash: sha256Canonical({ mode: 'github_rules' }),
    },
    expectedHeads: { '42': 'abc123' },
    ...(deadline ? { watchExpiresAt: deadline.toISOString() } : {}),
  };
}

function blocker(): PrWatchBlockerCauseV1 {
  return {
    causeId: 'cause-auth',
    version: 1,
    kind: 'provider_auth',
    class: 'revalidate',
    message: 'authenticate gh',
    evidence: {},
    allowedConsumingReasons: ['blocked_resolved'],
  };
}

function event(id: string): PrWatchEventRecordV1 {
  return {
    id,
    identity: {
      prNumber: 42,
      headSha: 'abc123',
      kind: 'check_failure',
      providerSourceId: id,
      attempt: 1,
    },
    firstObservedAt: '2026-08-27T11:59:00.000Z',
    lastObservedAt: '2026-08-27T11:59:00.000Z',
    fixAttemptCount: 0,
  };
}
