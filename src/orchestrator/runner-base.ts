import { EventEmitter } from 'eventemitter3';
import type { PipelineEvents } from './pipeline.js';
import { StateStore } from '../state/store.js';

export abstract class RunnerBase extends EventEmitter<PipelineEvents> {
  protected activeAbortController: AbortController | null = null;
  private userInputResolver: ((input: string) => void) | null = null;
  private userInputRejecter: ((error: Error) => void) | null = null;

  constructor(private readonly stateStore: StateStore) {
    super();
  }

  requestUserInput(question: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.userInputResolver = resolve;
      this.userInputRejecter = reject;
      this.emit('ask_user', question);
    });
  }

  provideUserInput(input: string): void {
    if (this.userInputResolver) {
      const resolve = this.userInputResolver;
      this.userInputResolver = null;
      this.userInputRejecter = null;
      resolve(input);
    }
  }

  private rejectPendingUserInput(reason: string): void {
    if (this.userInputRejecter) {
      const reject = this.userInputRejecter;
      this.userInputResolver = null;
      this.userInputRejecter = null;
      reject(new Error(reason));
    }
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
    this.rejectPendingUserInput(reason);
  }
}
