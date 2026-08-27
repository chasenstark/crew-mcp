import { recoverExpiredPrWatchSurfaceClaim } from './reducer.js';
import type { PrWatchStore } from './store.js';
import type { PrWatchRemedySurfaceV1, PrWatchStateV1 } from './types.js';

interface SurfaceLeaseEntry {
  readonly key: string;
  readonly watchId: string;
  readonly surfaceId: string;
  readonly requestId: string;
  readonly attempt: number;
  readonly dueAt: number;
}

export interface PrWatchSurfaceLeaseClock {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  readonly clearTimeout: (timer: NodeJS.Timeout) => void;
}

const SYSTEM_CLOCK: PrWatchSurfaceLeaseClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

/** Recovers un-audited JIT surface claims while serve remains long-lived. */
export class PrWatchSurfaceLeaseController {
  private readonly entries = new Map<string, SurfaceLeaseEntry>();
  private timer?: NodeJS.Timeout;
  private sweeping = false;

  constructor(
    private readonly store: PrWatchStore,
    private readonly clock: PrWatchSurfaceLeaseClock = SYSTEM_CLOCK,
  ) {}

  async start(): Promise<void> {
    for (const watchId of this.store.listWatchIds()) {
      try {
        this.register(this.store.read(watchId).state);
      } catch {
        // Status surfaces own corruption reporting.
      }
    }
    await this.sweep();
  }

  stop(): void {
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.entries.clear();
  }

  register(state: PrWatchStateV1): void {
    for (const [key, entry] of this.entries) {
      if (entry.watchId === state.watchId) this.entries.delete(key);
    }
    for (const surface of [...state.blockerSurfaces, ...state.expirySurfaces]) {
      const entry = leaseEntry(state.watchId, surface);
      if (entry) this.entries.set(entry.key, entry);
    }
    this.schedule();
  }

  async preflightSweep(): Promise<void> {
    await this.sweep();
  }

  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const now = this.clock.now();
      const due = [...this.entries.values()]
        .filter((entry) => entry.dueAt <= now)
        .sort((left, right) => left.dueAt - right.dueAt);
      for (const entry of due) {
        if (!this.entries.delete(entry.key)) continue;
        try {
          const result = await this.store.mutate(entry.watchId, (state) =>
            recoverExpiredPrWatchSurfaceClaim(state, {
              surfaceId: entry.surfaceId,
              requestId: entry.requestId,
              attempt: entry.attempt,
              now: new Date(now),
            }));
          this.register(result.state);
        } catch {
          // A competing delivery/closure won the exact CAS. Re-read only to
          // retain any other live claims; never synthesize a replacement.
          try {
            this.register(this.store.read(entry.watchId).state);
          } catch {
            // Corrupt/missing watches are omitted from lease recovery.
          }
        }
      }
    } finally {
      this.sweeping = false;
      this.schedule();
    }
  }

  private schedule(): void {
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    const next = [...this.entries.values()].sort((left, right) => left.dueAt - right.dueAt)[0];
    if (!next) return;
    this.timer = this.clock.setTimeout(
      () => void this.sweep(),
      Math.max(0, next.dueAt - this.clock.now()),
    );
    this.timer.unref?.();
  }
}

function leaseEntry(watchId: string, surface: PrWatchRemedySurfaceV1): SurfaceLeaseEntry | undefined {
  if (
    surface.state !== 'claimed'
    || surface.claimedByRequestId === undefined
    || surface.claimLeaseExpiresAt === undefined
  ) return undefined;
  return {
    key: `${watchId}:${surface.surfaceId}:${surface.claimedByRequestId}:${surface.latestClaimAttempt}`,
    watchId,
    surfaceId: surface.surfaceId,
    requestId: surface.claimedByRequestId,
    attempt: surface.latestClaimAttempt,
    dueAt: Date.parse(surface.claimLeaseExpiresAt),
  };
}
