// SessionLoop is the event-driven driver that replaces the tool-loop-inside-
// adapter shape of executeNativeToolLoop. It consumes events from a
// CaptainSession, serializes captain turns (at most one in flight), and
// schedules dispatched tool calls via a shared ToolDispatcher. Subagent runs
// scheduled on the dispatcher proceed concurrently with captain turns —
// they don't queue behind the serializer.
//
// Lifecycle per event:
//   1. Event arrives on session.events() (user_message, tool_completed,
//      tool_failed, tool_cancelled).
//   2. The loop wakes up; if a captain turn is already running, it flags
//      pendingTurn and returns — the running turn will re-check on exit.
//   3. If no turn is running, the loop starts one. The captain sees the
//      full session.toToolLoopMessages() plus providerSessionRef for resume.
//   4. Captain emits assistantText + toolCalls. Assistant text lands as a
//      SessionMessage. Each toolCall is either resolved synchronously by
//      the scheduler (for local actions like finalize_report) or started
//      on the dispatcher (for long-running actions like run_agent). In the
//      dispatched case, the captain turn ENDS with a pending placeholder;
//      the real tool_result arrives later as a tool_completed event.
//   5. On turn exit, loop re-checks pendingTurn and loops if needed.
//
// M1.5-6a: this file is scaffold. Tests exercise it against a fake captain +
// fake dispatcher. JudgmentRunner.executeSessionLoop is present but not
// called yet — M1.5-6b flips the switch.

import type { CaptainSession } from './session.js';
import type { ToolDispatcher, DispatchTask } from './tool-dispatcher.js';
import type { ToolLoopMessage } from '../adapters/types.js';
import { logger } from '../utils/logger.js';

export interface SessionLoopToolCall {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface SessionLoopTurnResult {
  assistantText?: string;
  toolCalls?: SessionLoopToolCall[];
  newProviderSessionRef?: string;
  /**
   * Set true when the adapter reports that the stored providerSessionRef was
   * rejected. M1.5-12 will use this to trigger full-replay.
   */
  providerSessionRejected?: boolean;
  /**
   * Set true when the captain reports it has finalized and the loop should
   * stop (e.g., finalize_report succeeded). Terminates the loop cleanly.
   */
  done?: boolean;
  /**
   * Final report text (when done === true). The loop surfaces this via the
   * onDone callback so the runner can return it to its caller.
   */
  finalReport?: string;
}

export interface SessionLoopTurn {
  execute(args: {
    messages: ToolLoopMessage[];
    providerSessionRef?: string;
    signal: AbortSignal;
  }): Promise<SessionLoopTurnResult>;
}

export interface ScheduledToolCall {
  /** kind === 'synchronous' resolves the tool_result inline before the turn ends. */
  kind: 'synchronous';
  result: unknown;
  status: 'success' | 'error';
}

export interface DispatchedToolCall {
  /** kind === 'dispatched' schedules on the ToolDispatcher; tool_result arrives later. */
  kind: 'dispatched';
  task: DispatchTask;
}

export type ToolCallScheduleResult = ScheduledToolCall | DispatchedToolCall;

export interface ToolCallScheduler {
  schedule(call: SessionLoopToolCall, ctx: { signal: AbortSignal }): Promise<ToolCallScheduleResult>;
}

export interface SessionLoopOptions {
  session: CaptainSession;
  dispatcher: ToolDispatcher;
  captain: SessionLoopTurn;
  scheduler: ToolCallScheduler;
  /**
   * Max turns the loop will run before surfacing an error. Guardrail to stop
   * pathological cycles; defaults to a high value for production use.
   */
  maxTurns?: number;
  /**
   * Hook for tests or runners to observe turn lifecycle. Called after each
   * turn settles. `done === true` means the loop is exiting cleanly.
   */
  onTurn?: (info: { turnNumber: number; result: SessionLoopTurnResult }) => void;
}

export class SessionLoop {
  private readonly session: CaptainSession;
  private readonly dispatcher: ToolDispatcher;
  private readonly captain: SessionLoopTurn;
  private readonly scheduler: ToolCallScheduler;
  private readonly maxTurns: number;
  private readonly onTurn?: SessionLoopOptions['onTurn'];
  private turnInFlight = false;
  private pendingTurn = false;
  private turnNumber = 0;
  private done = false;
  private finalReport: string | undefined;
  private cancelled = false;
  private disposeListeners: Array<{ dispose: () => void }> = [];
  private currentTurnAbort: AbortController | undefined;
  private turnError: Error | undefined;
  private exitResolver: () => void = () => undefined;
  private exitPromise: Promise<void>;

  constructor(options: SessionLoopOptions) {
    this.session = options.session;
    this.dispatcher = options.dispatcher;
    this.captain = options.captain;
    this.scheduler = options.scheduler;
    this.maxTurns = options.maxTurns ?? 200;
    this.onTurn = options.onTurn;
    this.exitPromise = new Promise<void>((resolve) => {
      this.exitResolver = resolve;
    });
  }

  async run(options?: { externalSignal?: AbortSignal }): Promise<{ finalReport?: string }> {
    this.wireDispatcherEvents();
    const externalAbortHandler = () => this.cancel('external-signal');
    options?.externalSignal?.addEventListener('abort', externalAbortHandler);

    const subscription = this.session.subscribe(() => {
      if (this.done || this.cancelled || this.turnError) return;
      void this.scheduleNextTurn();
    });

    // Kick off an initial turn if the captain has pending work — either a
    // user_message the caller just appended, or a tool_result persisted from
    // a prior run that hasn't been responded to.
    if (this.session.hasPendingCaptainWork()) {
      void this.scheduleNextTurn();
    }

    try {
      await this.exitPromise;
    } finally {
      subscription.dispose();
      options?.externalSignal?.removeEventListener('abort', externalAbortHandler);
      this.teardown();
    }

    if (this.turnError) throw this.turnError;
    return { finalReport: this.finalReport };
  }

  cancel(reason = 'session-loop cancelled'): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.dispatcher.cancelAll(reason);
    this.currentTurnAbort?.abort(reason);
    this.exitResolver();
  }

  private wireDispatcherEvents(): void {
    this.disposeListeners.push(
      this.dispatcher.onEvent('run:complete', (info) => {
        this.session.appendToolResult({
          toolCallId: info.toolCallId,
          output: info.result,
          status: 'success',
        });
      }),
      this.dispatcher.onEvent('run:failed', (info) => {
        this.session.appendToolResult({
          toolCallId: info.toolCallId,
          output: info.error,
          status: 'error',
        });
      }),
      this.dispatcher.onEvent('run:cancelled', (info) => {
        this.session.appendToolResult({
          toolCallId: info.toolCallId,
          output: info.reason,
          status: 'cancelled',
        });
      }),
    );
  }

  private teardown(): void {
    for (const l of this.disposeListeners) l.dispose();
    this.disposeListeners = [];
  }

  private async scheduleNextTurn(): Promise<void> {
    if (this.cancelled || this.done || this.turnError) return;
    if (this.turnInFlight) {
      this.pendingTurn = true;
      return;
    }
    this.turnInFlight = true;
    try {
      while (!this.cancelled && !this.done && !this.turnError) {
        this.pendingTurn = false;
        await this.runOneTurn();
        if (!this.pendingTurn) break;
      }
    } finally {
      this.turnInFlight = false;
      if (this.done || this.cancelled || this.turnError) {
        this.exitResolver();
      }
    }
  }

  private async runOneTurn(): Promise<void> {
    if (this.turnNumber >= this.maxTurns) {
      throw new Error(`Session loop exceeded max turns (${this.maxTurns}).`);
    }
    this.turnNumber++;
    this.currentTurnAbort = new AbortController();
    const messages = this.session.toToolLoopMessages();

    let result: SessionLoopTurnResult;
    try {
      result = await this.captain.execute({
        messages,
        providerSessionRef: this.session.providerSessionRef,
        signal: this.currentTurnAbort.signal,
      });
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.warn('[session-loop] captain turn threw', { error: error.message });
      this.turnError = error;
      return;
    } finally {
      this.currentTurnAbort = undefined;
    }

    if (result.assistantText) {
      this.session.appendAssistantMessage(result.assistantText);
    }

    if (result.newProviderSessionRef !== undefined) {
      this.session.providerSessionRef = result.newProviderSessionRef;
    }

    if (result.toolCalls && result.toolCalls.length > 0) {
      await this.applyToolCalls(result.toolCalls);
    }

    if (result.done) {
      this.done = true;
      if (result.finalReport) this.finalReport = result.finalReport;
    }

    this.session.persist();
    this.onTurn?.({ turnNumber: this.turnNumber, result });
  }

  private async applyToolCalls(calls: SessionLoopToolCall[]): Promise<void> {
    for (const call of calls) {
      this.session.appendToolCall({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: call.input,
      });
    }

    // Schedule each. Synchronous results become tool_result events inline;
    // dispatched ones start on the dispatcher and resolve asynchronously.
    for (const call of calls) {
      const signal = this.currentTurnAbort?.signal ?? new AbortController().signal;
      let scheduled: ToolCallScheduleResult;
      try {
        scheduled = await this.scheduler.schedule(call, { signal });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.session.appendToolResult({
          toolCallId: call.toolCallId,
          output: message,
          status: 'error',
        });
        continue;
      }
      if (scheduled.kind === 'synchronous') {
        this.session.appendToolResult({
          toolCallId: call.toolCallId,
          output: scheduled.result,
          status: scheduled.status,
        });
        continue;
      }
      this.dispatcher.start(scheduled.task);
    }
  }
}
