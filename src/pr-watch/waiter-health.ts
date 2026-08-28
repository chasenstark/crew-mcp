import type { PrWatchWaiterActionV1 } from './types.js';

export interface PrWatchWaiterHealth {
  readonly state: 'pending' | 'running' | 'stale' | 'timed_out';
  readonly recoverable: boolean;
  readonly rearmReason?: 'timeout' | 'stale_waiter';
  readonly reason?: 'lease_expired' | 'lease_missing' | 'timeout' | 'waiter_exited';
  readonly leaseExpiresAt?: string;
  readonly exitReason?: PrWatchWaiterActionV1['exitReason'];
  readonly message: string;
}

export function derivePrWatchWaiterHealth(
  waiter: PrWatchWaiterActionV1,
  now: Date = new Date(),
): PrWatchWaiterHealth {
  if (waiter.state === 'pending') {
    return {
      state: 'pending',
      recoverable: false,
      message: 'Waiter has not claimed its execution lease yet.',
    };
  }
  if (waiter.state === 'running') {
    if (waiter.leaseExpiresAt === undefined || isPrWatchWaiterLeaseExpired(waiter, now)) {
      return {
        state: 'stale',
        recoverable: true,
        rearmReason: 'stale_waiter',
        reason: waiter.leaseExpiresAt === undefined ? 'lease_missing' : 'lease_expired',
        ...(waiter.leaseExpiresAt !== undefined ? { leaseExpiresAt: waiter.leaseExpiresAt } : {}),
        message: waiter.leaseExpiresAt === undefined
          ? 'Waiter still reads as running, but its execution lease is missing and should be replaced.'
          : 'Waiter still reads as running, but its execution lease has expired and should be replaced.',
      };
    }
    return {
      state: 'running',
      recoverable: false,
      leaseExpiresAt: waiter.leaseExpiresAt,
      message: 'Waiter lease is active.',
    };
  }
  if (waiter.exitReason === 'timeout') {
    return {
      state: 'timed_out',
      recoverable: true,
      rearmReason: 'timeout',
      reason: 'timeout',
      exitReason: 'timeout',
      message: 'Waiter exited after its timeout window and can be replaced.',
    };
  }
  return {
    state: 'stale',
    recoverable: true,
    rearmReason: 'stale_waiter',
    reason: 'waiter_exited',
    ...(waiter.exitReason !== undefined ? { exitReason: waiter.exitReason } : {}),
    message: `Waiter exited with reason "${waiter.exitReason ?? 'unknown'}" and can be replaced.`,
  };
}

export function isPrWatchWaiterLeaseExpired(
  waiter: Pick<PrWatchWaiterActionV1, 'state' | 'leaseExpiresAt'>,
  now: Date = new Date(),
): boolean {
  return waiter.state === 'running'
    && waiter.leaseExpiresAt !== undefined
    && Date.parse(waiter.leaseExpiresAt) <= now.getTime();
}
