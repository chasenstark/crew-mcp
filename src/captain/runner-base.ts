import { EventEmitter } from 'eventemitter3';
import type { PipelineEvents } from './pipeline.js';
import { StateStore } from '../state/store.js';

/**
 * RunnerBase is the shared lifecycle for Pipeline (linear, deprecated) and
 * JudgmentRunner (M1.5-era). Post-M1.5 it owns:
 *
 *  - activeAbortController — cooperative cancellation signal for the
 *    current run; subclasses wire subagent dispatchers through this.
 *  - cancel() / markInterrupted() — surface + persistence integration.
 *
 * The slot-based requestUserInput / provideUserInput pair lived here
 * pre-M1.5. As of M1.5-11 ask_user is a dispatcher-backed tool; the
 * shim is deleted.
 */
export abstract class RunnerBase extends EventEmitter<PipelineEvents> {
  protected activeAbortController: AbortController | null = null;

  constructor(private readonly stateStore: StateStore) {
    super();
  }

  markInterrupted(reason = 'Interrupted by user'): void {
    const snapshot = this.stateStore.loadState();
    if (!snapshot) return;
    if (snapshot.status !== 'running' && snapshot.status !== 'interrupted') return;

    this.stateStore.saveState({
      ...snapshot,
      status: 'interrupted',
      interruptedAt: new Date().toISOString(),
      lastError: reason,
    });
  }

  cancel(reason = 'Cancelled by user'): void {
    this.markInterrupted(reason);
    if (this.activeAbortController && !this.activeAbortController.signal.aborted) {
      this.activeAbortController.abort(reason);
    }
  }
}
