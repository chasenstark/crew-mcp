import { tryExpirePrWatch } from './reducer.js';
import type { PrWatchStore } from './store.js';
import type { PrWatchStateV1 } from './types.js';

interface DeadlineEntry {
  readonly key: string;
  readonly watchId: string;
  readonly dueAt: number;
}

export interface PrWatchControllerClock {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  readonly clearTimeout: (timer: NodeJS.Timeout) => void;
}

const SYSTEM_CLOCK: PrWatchControllerClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

/** Controller-owned expiry for both waiter-backed and waiter-less watches. */
export class PrWatchDeadlineController {
  private readonly heap = new DeadlineHeap();
  private readonly keys = new Map<string, string>();
  private timer?: NodeJS.Timeout;
  private sweeping = false;

  constructor(
    private readonly store: PrWatchStore,
    private readonly clock: PrWatchControllerClock = SYSTEM_CLOCK,
  ) {}

  async start(): Promise<void> {
    for (const watchId of this.store.listWatchIds()) {
      try {
        this.register(this.store.read(watchId).state);
      } catch {
        // Corrupt state is surfaced by status/list and must not be rewritten by
        // a deadline sweep.
      }
    }
    await this.sweep();
  }

  stop(): void {
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.heap.clear();
    this.keys.clear();
  }

  register(state: PrWatchStateV1): void {
    const key = deadlineKey(state);
    if (this.keys.get(state.watchId) === key) return;
    this.keys.set(state.watchId, key);
    if (state.watchExpiresAt !== undefined && isNonterminal(state)) {
      this.heap.push({ key, watchId: state.watchId, dueAt: Date.parse(state.watchExpiresAt) });
    }
    this.schedule();
  }

  unregister(watchId: string): void {
    this.keys.delete(watchId);
    this.schedule();
  }

  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const now = this.clock.now();
      while (true) {
        const entry = this.peekLive();
        if (!entry || entry.dueAt > now) break;
        this.heap.pop();
        if (this.keys.get(entry.watchId) !== entry.key) continue;
        try {
          const result = await this.store.mutate(entry.watchId, (state) => {
            if (deadlineKey(state) !== entry.key) {
              throw new Error('pr_watch.deadline_stale');
            }
            return tryExpirePrWatch(state, { now: new Date(now) });
          });
          this.register(result.state);
        } catch {
          if (this.keys.get(entry.watchId) === entry.key) {
            this.keys.delete(entry.watchId);
          }
          try {
            this.register(this.store.read(entry.watchId).state);
          } catch {
            // Corrupt or concurrently removed state is surfaced by status/list.
          }
          // A transient failure or stale-entry race may have requeued an
          // immediately due deadline. Yield to the timer instead of spinning
          // inside the same sweep.
          break;
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
    const next = this.peekLive();
    if (!next) return;
    const delay = Math.max(0, next.dueAt - this.clock.now());
    this.timer = this.clock.setTimeout(() => void this.sweep(), delay);
    this.timer.unref?.();
  }

  private peekLive(): DeadlineEntry | undefined {
    while (true) {
      const entry = this.heap.peek();
      if (!entry || this.keys.get(entry.watchId) === entry.key) return entry;
      this.heap.pop();
    }
  }
}

function deadlineKey(state: PrWatchStateV1): string {
  return `${state.generation}:${state.status}:${state.watchExpiresAt ?? 'disabled'}`;
}

function isNonterminal(state: PrWatchStateV1): boolean {
  return !['terminal', 'cancelled', 'expired'].includes(state.status);
}

class DeadlineHeap {
  private values: DeadlineEntry[] = [];

  clear(): void {
    this.values = [];
  }

  peek(): DeadlineEntry | undefined {
    return this.values[0];
  }

  push(value: DeadlineEntry): void {
    this.values.push(value);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.values[parent].dueAt <= value.dueAt) break;
      this.values[index] = this.values[parent];
      index = parent;
    }
    this.values[index] = value;
  }

  pop(): DeadlineEntry | undefined {
    const first = this.values[0];
    const last = this.values.pop();
    if (!first || !last || this.values.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.values.length) break;
      const child = right < this.values.length && this.values[right].dueAt < this.values[left].dueAt
        ? right
        : left;
      if (this.values[child].dueAt >= last.dueAt) break;
      this.values[index] = this.values[child];
      index = child;
    }
    this.values[index] = last;
    return first;
  }
}
