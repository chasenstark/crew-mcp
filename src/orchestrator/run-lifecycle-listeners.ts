import type { TaskResult } from '../adapters/types.js';
import { logger } from '../utils/logger.js';
import { formatProgressLines, type ProgressNotifier } from './progress.js';
import type { RunStateStore } from './run-state.js';
import type { ToolDispatcher } from './tool-dispatcher.js';

export type DispatchTerminal =
  | { kind: 'complete'; result: TaskResult }
  | { kind: 'failed'; error: string }
  | { kind: 'cancelled'; reason: string };

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
      void persistTerminal(args, terminal).catch((err) => {
        logger.warn(
          `Failed to write run state for ${args.runId}: ${errorMessage(err)}`,
        );
      });
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
