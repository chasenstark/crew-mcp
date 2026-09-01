import { describe, expect, it } from 'vitest';

import type { PrWatchWaiterActionV1 } from '../../src/pr-watch/types.js';
import { derivePrWatchWaiterHealth } from '../../src/pr-watch/waiter-health.js';

const NOW = new Date('2026-08-28T18:30:00.000Z');

describe('PR-watch waiter health', () => {
  it('distinguishes pending and live running waiters', () => {
    expect(derivePrWatchWaiterHealth(waiter({
      state: 'pending',
      createdAt: '2026-08-28T18:29:30.000Z',
    }), NOW)).toMatchObject({
      state: 'pending',
      recoverable: false,
    });
    expect(derivePrWatchWaiterHealth(waiter({
      state: 'running',
      leaseOwnerId: 'owner-live',
      leaseHeartbeatAt: '2026-08-28T18:29:00.000Z',
      leaseExpiresAt: '2026-08-28T18:31:00.000Z',
    }), NOW)).toMatchObject({
      state: 'running',
      recoverable: false,
      leaseExpiresAt: '2026-08-28T18:31:00.000Z',
    });
  });

  it('makes a pending waiter replaceable once its claim grace expires', () => {
    // A skipped launch, or one that exited 4 on the sandbox writability
    // probe, never claims a lease; the watch must not stay stuck.
    expect(derivePrWatchWaiterHealth(waiter({
      state: 'pending',
      createdAt: '2026-08-28T18:27:00.000Z',
    }), NOW)).toMatchObject({
      state: 'stale',
      recoverable: true,
      rearmReason: 'stale_waiter',
      reason: 'never_claimed',
    });
    // Corrupt timestamps fail toward the conservative non-replaceable state.
    expect(derivePrWatchWaiterHealth(waiter({
      state: 'pending',
      createdAt: 'not-a-timestamp',
    }), NOW)).toMatchObject({ state: 'pending', recoverable: false });
  });

  it('treats the exact lease deadline as stale and recoverable', () => {
    expect(derivePrWatchWaiterHealth(waiter({
      state: 'running',
      leaseOwnerId: 'owner-stale',
      leaseHeartbeatAt: '2026-08-28T18:29:00.000Z',
      leaseExpiresAt: NOW.toISOString(),
    }), NOW)).toMatchObject({
      state: 'stale',
      recoverable: true,
      reason: 'lease_expired',
      rearmReason: 'stale_waiter',
    });
  });

  it('reports timed-out and other exited waiters as recoverable', () => {
    expect(derivePrWatchWaiterHealth(waiter({
      state: 'exited',
      exitReason: 'timeout',
      exitedAt: '2026-08-28T18:29:00.000Z',
    }), NOW)).toMatchObject({
      state: 'timed_out',
      recoverable: true,
      reason: 'timeout',
      rearmReason: 'timeout',
    });
    expect(derivePrWatchWaiterHealth(waiter({
      state: 'exited',
      exitReason: 'cancelled',
      exitedAt: '2026-08-28T18:29:00.000Z',
    }), NOW)).toMatchObject({
      state: 'stale',
      recoverable: true,
      reason: 'waiter_exited',
      rearmReason: 'stale_waiter',
    });
  });
});

function waiter(overrides: Partial<PrWatchWaiterActionV1>): PrWatchWaiterActionV1 {
  return {
    watcherActionId: 'waiter-action-1',
    generation: 1,
    observationMode: 'full',
    state: 'pending',
    createdAt: '2026-08-28T18:00:00.000Z',
    ...overrides,
  };
}
