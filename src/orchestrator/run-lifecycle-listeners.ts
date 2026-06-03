import type { TaskResult } from '../adapters/types.js';
import { logger } from '../utils/logger.js';
import { formatProgressLines, type ProgressNotifier } from './progress.js';
import type { RunStateStore } from './run-state.js';
import type { ToolDispatcher } from './tool-dispatcher.js';

export type DispatchTerminal =
  | { kind: 'complete'; result: TaskResult }
  | { kind: 'failed'; error: string }
  | { kind: 'cancelled'; reason: string };

const pendingTerminalPersists = new Set<Promise<void>>();

export async function drainPendingTerminalPersists(
  options: {
    readonly maxWaitMs?: number;
  } = {},
): Promise<boolean> {
  if (options.maxWaitMs === undefined) {
    while (pendingTerminalPersists.size > 0) {
      await Promise.allSettled(Array.from(pendingTerminalPersists));
    }
    return true;
  }

  const maxWaitMs = Math.max(0, options.maxWaitMs);
  const deadline = Date.now() + maxWaitMs;

  while (pendingTerminalPersists.size > 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    const snapshot = Array.from(pendingTerminalPersists);
    const result = await waitForPersistsOrTimeout(snapshot, remaining);
    if (result === 'timeout') return pendingTerminalPersists.size === 0;
  }

  return true;
}

export function pendingTerminalPersistCount(): number {
  return pendingTerminalPersists.size;
}

export function installRunLifecycleListeners(args: {
  dispatcher: ToolDispatcher;
  runStateStore: RunStateStore;
  runId: string;
  /**
   * Adapter id, threaded through purely so progress-notification messages can
   * be prefixed `[<agent>]`. Hosts that render notifications/progress inline
   * get a labeled stream so multi-agent dispatches do not blur together.
   */
  agentName: string;
  toolCallId: string;
  progress?: ProgressNotifier;
}): Promise<DispatchTerminal> {
  return new Promise<DispatchTerminal>((resolve) => {
    const subs: Array<{ dispose(): void }> = [];
    let settled = false;

    const disposeAll = (): void => {
      for (const s of subs) s.dispose();
    };

    const onTerminal = (terminal: DispatchTerminal): void => {
      if (settled) return;
      settled = true;
      disposeAll();
      resolve(terminal);
      trackTerminalPersist(args, terminal);
    };

    subs.push(
      args.dispatcher.onEvent('run:complete', (info) => {
        if (info.toolCallId !== args.toolCallId) return;
        onTerminal({ kind: 'complete', result: info.result as TaskResult });
      }),
      args.dispatcher.onEvent('run:failed', (info) => {
        if (info.toolCallId !== args.toolCallId) return;
        onTerminal({ kind: 'failed', error: info.error });
      }),
      args.dispatcher.onEvent('run:cancelled', (info) => {
        if (info.toolCallId !== args.toolCallId) return;
        onTerminal({ kind: 'cancelled', reason: info.reason });
      }),
      args.dispatcher.onEvent('run:stream', (info) => {
        if (settled || info.toolCallId !== args.toolCallId) return;
        const progressLines = formatProgressLines(args.agentName, info.chunk);
        try {
          for (const line of progressLines) {
            args.runStateStore.appendEvent(args.runId, line);
          }
        } catch {
          // Log writes are best-effort; never let a write failure break dispatch.
        }
        if (args.progress) {
          for (const line of progressLines) {
            args.progress.send(line);
          }
        }
      }),
    );
  });
}

function trackTerminalPersist(
  args: {
    runStateStore: RunStateStore;
    runId: string;
  },
  terminal: DispatchTerminal,
): void {
  const persist = persistTerminal(args, terminal)
    .catch((err) => {
      logger.warn(
        `Failed to write run state for ${args.runId}: ${errorMessage(err)}`,
      );
    })
    .finally(() => {
      pendingTerminalPersists.delete(persist);
    });
  pendingTerminalPersists.add(persist);
}

async function waitForPersistsOrTimeout(
  persists: Array<Promise<void>>,
  timeoutMs: number,
): Promise<'settled' | 'timeout'> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timeout = setTimeout(() => resolve('timeout'), timeoutMs);
      timeout.unref?.();
    });
    const settled = Promise.allSettled(persists).then(() => 'settled' as const);
    return await Promise.race([settled, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function persistTerminal(
  args: {
    runStateStore: RunStateStore;
    runId: string;
  },
  terminal: DispatchTerminal,
): Promise<void> {
  if (terminal.kind === 'complete') {
    await args.runStateStore.markTerminal(args.runId, {
      status: terminal.result.status,
      summary: terminal.result.output,
      filesChanged: terminal.result.filesModified,
      warnings: terminal.result.warnings,
    });
  } else if (terminal.kind === 'failed') {
    await args.runStateStore.markTerminal(args.runId, {
      status: 'error',
      summary: terminal.error,
      filesChanged: [],
      lastError: terminal.error,
    });
  } else {
    await args.runStateStore.markTerminal(args.runId, {
      status: 'cancelled',
      summary: terminal.reason,
      filesChanged: [],
    });
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
