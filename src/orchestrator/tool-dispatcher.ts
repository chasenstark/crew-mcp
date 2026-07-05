// ToolDispatcher runs captain-invoked tools concurrently, each with its own
// AbortController. This is the mechanism that lets a captain turn complete
// (returning a pending placeholder tool_result) while the underlying agent
// work runs in the background. When the work finishes, the dispatcher emits
// a terminal event that the session loop uses to schedule the next turn.
//
// Lifecycle per tool-call:
//   start(id, task) -> run:start
//     task receives { signal } via DispatchTask.run(signal)
//     while running: task.run may invoke context.onStream() -> run:stream
//   run:complete | run:failed | run:cancelled (exactly one terminal)
//     on terminal, the AbortController entry is deleted from the map
//
// Streaming events (run:stream) are NEVER persisted by the dispatcher itself.
// They're UI-only — consumers can buffer them and render progress, but the
// session durability contract is "terminal event + tool_result only."

import { EventEmitter } from 'eventemitter3';

export interface DispatchTaskContext {
  signal: AbortSignal;
  onStream?: (chunk: string) => void;
}

export interface DispatchTask {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input?: Record<string, unknown>;
  readonly runId?: string;
  readonly streamsIncrementally?: boolean;
  run(ctx: DispatchTaskContext): Promise<unknown>;
}

export interface DispatcherEvents {
  'run:start': (info: { toolCallId: string; toolName: string; runId?: string }) => void;
  'run:stream': (info: { toolCallId: string; chunk: string; runId?: string }) => void;
  'run:complete': (info: { toolCallId: string; toolName: string; result: unknown; runId?: string }) => void;
  'run:failed': (info: {
    toolCallId: string;
    toolName: string;
    error: string;
    result?: unknown;
    runId?: string;
  }) => void;
  'run:cancelled': (info: { toolCallId: string; toolName: string; reason: string; runId?: string }) => void;
}

export interface Disposable {
  dispose(): void;
}

export interface ToolDispatcherOptions {
  /** Compatibility alias for `streamingIdleTimeoutMs`. */
  readonly stallTimeoutMs?: number;
  /** Idle-stall timeout for incrementally streaming adapters. `0` disables. */
  readonly streamingIdleTimeoutMs?: number;
  /** Absolute wall-clock cap for buffering adapters. `0` disables. */
  readonly bufferedAbsoluteTimeoutMs?: number;
}

type InFlight = {
  controller: AbortController;
  toolName: string;
  runId?: string;
};

/** Watchdog sampling cadence is the timeout quartered, clamped to [1s, 10s]. */
function watchdogIntervalMs(stallTimeoutMs: number): number {
  return Math.min(10_000, Math.max(1_000, Math.floor(stallTimeoutMs / 4)));
}

const DEFAULT_STREAMING_IDLE_TIMEOUT_MS = 12 * 60 * 1000;
const DEFAULT_BUFFERED_ABSOLUTE_TIMEOUT_MS = 60 * 60 * 1000;

export class ToolDispatcher {
  private readonly emitter = new EventEmitter<DispatcherEvents>();
  private readonly inFlight = new Map<string, InFlight>();
  private readonly streamingIdleTimeoutMs: number;
  private readonly bufferedAbsoluteTimeoutMs: number;

  constructor(options: ToolDispatcherOptions = {}) {
    const rawStreaming = options.streamingIdleTimeoutMs
      ?? options.stallTimeoutMs
      ?? DEFAULT_STREAMING_IDLE_TIMEOUT_MS;
    this.streamingIdleTimeoutMs = normalizeTimeout(rawStreaming);
    this.bufferedAbsoluteTimeoutMs = normalizeTimeout(
      options.bufferedAbsoluteTimeoutMs ?? DEFAULT_BUFFERED_ABSOLUTE_TIMEOUT_MS,
    );
  }

  start(task: DispatchTask): void {
    if (this.inFlight.has(task.toolCallId)) {
      throw new Error(`ToolDispatcher already has an in-flight task for ${task.toolCallId}`);
    }
    const controller = new AbortController();
    this.inFlight.set(task.toolCallId, {
      controller,
      toolName: task.toolName,
      runId: task.runId,
    });
    this.emitter.emit('run:start', {
      toolCallId: task.toolCallId,
      toolName: task.toolName,
      runId: task.runId,
    });

    // Streaming adapters get idle-stall protection. Buffering adapters emit
    // nothing until completion, so they get an absolute cap instead.
    let lastActivity = Date.now();
    let watchdog: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout> | undefined;
    const clearWatchdog = () => {
      if (watchdog === undefined) return;
      if (task.streamsIncrementally === true) {
        clearInterval(watchdog);
      } else {
        clearTimeout(watchdog);
      }
      watchdog = undefined;
    };
    if (task.streamsIncrementally === true && this.streamingIdleTimeoutMs > 0) {
      watchdog = setInterval(() => {
        if (controller.signal.aborted) {
          clearWatchdog();
          return;
        }
        if (Date.now() - lastActivity >= this.streamingIdleTimeoutMs) {
          clearWatchdog();
          controller.abort(new StallTimeoutError(this.streamingIdleTimeoutMs));
        }
      }, watchdogIntervalMs(this.streamingIdleTimeoutMs));
      watchdog.unref?.();
    } else if (task.streamsIncrementally !== true && this.bufferedAbsoluteTimeoutMs > 0) {
      watchdog = setTimeout(() => {
        if (controller.signal.aborted) return;
        clearWatchdog();
        controller.abort(new BufferedAbsoluteTimeoutError(this.bufferedAbsoluteTimeoutMs));
      }, this.bufferedAbsoluteTimeoutMs);
      watchdog.unref?.();
    }

    const streamEmitter = (chunk: string) => {
      lastActivity = Date.now();
      this.emitter.emit('run:stream', {
        toolCallId: task.toolCallId,
        chunk,
        runId: task.runId,
      });
    };

    task
      .run({ signal: controller.signal, onStream: streamEmitter })
      .then(
        (result) => {
          clearWatchdog();
          this.handleCompleted(task, result);
        },
        (err) => {
          clearWatchdog();
          this.handleFailedOrCancelled(task, err);
        },
      )
      .catch((err) => {
        clearWatchdog();
        this.handleFailedOrCancelled(task, err);
      });
  }

  cancel(toolCallId: string, reason = 'cancelled'): boolean {
    const entry = this.inFlight.get(toolCallId);
    if (!entry) return false;
    if (!entry.controller.signal.aborted) {
      entry.controller.abort(new DispatcherCancelError(reason));
    }
    return true;
  }

  cancelAll(reason = 'cancelled'): number {
    let count = 0;
    for (const toolCallId of Array.from(this.inFlight.keys())) {
      if (this.cancel(toolCallId, reason)) count++;
    }
    return count;
  }

  inFlightCount(): number {
    return this.inFlight.size;
  }

  hasInFlight(toolCallId: string): boolean {
    return this.inFlight.has(toolCallId);
  }

  listInFlight(): Array<{ toolCallId: string; toolName: string; runId?: string }> {
    return Array.from(this.inFlight.entries()).map(([toolCallId, info]) => ({
      toolCallId,
      toolName: info.toolName,
      runId: info.runId,
    }));
  }

  onEvent<K extends keyof DispatcherEvents>(
    kind: K,
    listener: DispatcherEvents[K],
  ): Disposable {
    this.emitter.on(kind, listener as (...args: unknown[]) => void);
    return {
      dispose: () => {
        this.emitter.off(kind, listener as (...args: unknown[]) => void);
      },
    };
  }

  private handleCompleted(task: DispatchTask, result: unknown): void {
    const entry = this.inFlight.get(task.toolCallId);
    this.inFlight.delete(task.toolCallId);
    // If the task finished during a cancellation race, honor the cancellation
    // event instead of overwriting it with a completed one.
    if (entry?.controller.signal.aborted) {
      this.emitter.emit('run:cancelled', {
        toolCallId: task.toolCallId,
        toolName: task.toolName,
        reason: readAbortReason(entry.controller.signal.reason),
        runId: task.runId,
      });
      return;
    }
    if (isErrorTaskResult(result)) {
      this.emitter.emit('run:failed', {
        toolCallId: task.toolCallId,
        toolName: task.toolName,
        error: readTaskResultError(result),
        result,
        runId: task.runId,
      });
      return;
    }
    this.emitter.emit('run:complete', {
      toolCallId: task.toolCallId,
      toolName: task.toolName,
      result,
      runId: task.runId,
    });
  }

  private handleFailedOrCancelled(task: DispatchTask, err: unknown): void {
    const entry = this.inFlight.get(task.toolCallId);
    this.inFlight.delete(task.toolCallId);
    const aborted = entry?.controller.signal.aborted ?? false;
    if (aborted) {
      this.emitter.emit('run:cancelled', {
        toolCallId: task.toolCallId,
        toolName: task.toolName,
        reason: readAbortReason(entry?.controller.signal.reason ?? err),
        runId: task.runId,
      });
      return;
    }
    this.emitter.emit('run:failed', {
      toolCallId: task.toolCallId,
      toolName: task.toolName,
      error: err instanceof Error ? err.message : String(err),
      runId: task.runId,
    });
  }
}

class DispatcherCancelError extends Error {
  readonly name = 'DispatcherCancelError';
  constructor(reason: string) {
    super(reason);
  }
}

export class StallTimeoutError extends Error {
  readonly name = 'StallTimeoutError';
  constructor(stallTimeoutMs: number) {
    super(`stall watchdog: no output for ${formatDuration(stallTimeoutMs)} - cancelled`);
  }
}

export class BufferedAbsoluteTimeoutError extends Error {
  readonly name = 'BufferedAbsoluteTimeoutError';
  constructor(timeoutMs: number) {
    super(`absolute cap: buffering adapter ran for ${formatDuration(timeoutMs)} - cancelled`);
  }
}

function normalizeTimeout(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0 && seconds > 0) return `${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

function readAbortReason(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string') return reason;
  return 'cancelled';
}

function isErrorTaskResult(result: unknown): result is { status: 'error'; output?: unknown } {
  return Boolean(
    result &&
      typeof result === 'object' &&
      'status' in result &&
      (result as { status?: unknown }).status === 'error',
  );
}

function readTaskResultError(result: { output?: unknown }): string {
  if (typeof result.output === 'string' && result.output.trim().length > 0) {
    return result.output;
  }
  return 'Task returned status=error';
}
