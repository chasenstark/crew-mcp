import type { AdapterRegistry } from '../adapters/registry.js';
import type { TaskResult } from '../adapters/types.js';
import type { AgentPrefsMap } from '../agent-prefs/store.js';
import type { WorktreeManager } from '../git/worktree.js';
import { crewTailUrl } from '../cli/commands/tail-url.js';
import { logger } from '../utils/logger.js';
import { validatePeerMessagesPreflight } from './peer-messages/preflight.js';
import { formatProgressLines, type ProgressNotifier } from './progress.js';
import type { RunStateStore } from './run-state.js';
import type { ToolDispatcher } from './tool-dispatcher.js';
import {
  planRunAgent,
  type RegistryForRunAgent,
  type RunAgentInput,
  type RunAgentDispatchPlan,
} from './tools/run-agent.js';

export interface DispatchContext {
  readonly registry: AdapterRegistry | RegistryForRunAgent;
  readonly worktreeManager: WorktreeManager;
  readonly runStateStore: RunStateStore;
  readonly agentPrefs: AgentPrefsMap;
  readonly dispatcher: ToolDispatcher;
  readonly crewHome: string;
  readonly repoRoot: string;
  readonly projectRoot: string;
}

export interface DispatchRunAgentInternalArgs {
  readonly input: RunAgentInput;
  readonly ctx: DispatchContext;
  readonly progress?: ProgressNotifier;
}

export interface DispatchRunAgentInternalResult {
  readonly runId: string;
  readonly worktreePath: string;
  readonly readOnly: boolean;
  readonly tailUrl: string;
  readonly tailCommandPath: string;
  readonly toolCallId: string;
  readonly warnings: readonly string[];
}

export class DispatchError extends Error {
  readonly warnings: readonly string[];

  constructor(message: string, options?: { warnings?: readonly string[] }) {
    super(message);
    this.name = 'DispatchError';
    this.warnings = options?.warnings ?? [];
  }
}

export async function dispatchRunAgentInternal(
  args: DispatchRunAgentInternalArgs,
): Promise<DispatchRunAgentInternalResult> {
  const { input, ctx } = args;

  let validatedInput: readonly NonNullable<RunAgentInput['peer_messages']>[number][];
  try {
    validatedInput = validatePeerMessagesPreflight(input.peer_messages, ctx.runStateStore.caps);
  } catch (err) {
    throw new DispatchError(errorMessage(err));
  }

  let plan: Awaited<ReturnType<typeof planRunAgent>>;
  try {
    plan = await planRunAgent(input, ctx);
  } catch (err) {
    throw new DispatchError(errorMessage(err));
  }
  if (plan.kind === 'error') {
    throw new DispatchError(plan.message);
  }

  let createResult: Awaited<ReturnType<RunStateStore['create']>>;
  let warnings: readonly string[] = [];
  try {
    createResult = await ctx.runStateStore.create({
      runId: plan.runId,
      agentId: input.agent_id,
      worktreePath: plan.worktreePath,
      initialPrompt: input.prompt,
      initialPeerMessagesInput: validatedInput.length > 0 ? validatedInput : undefined,
      readOnly: plan.readOnly,
    });
    warnings = createResult.warnings;
  } catch (err) {
    await cleanupAllocatedWorktree(ctx, plan, 'rejection');
    throw new DispatchError(errorMessage(err));
  }

  void installRunLifecycleListeners({
    dispatcher: ctx.dispatcher,
    runStateStore: ctx.runStateStore,
    runId: plan.runId,
    agentName: input.agent_id,
    toolCallId: plan.toolCallId,
    progress: args.progress,
  });

  try {
    const task = plan.buildTask(createResult.composedPrompt);
    ctx.dispatcher.start(task);
  } catch (err) {
    const message = errorMessage(err);
    try {
      ctx.runStateStore.markTerminal(plan.runId, {
        status: 'error',
        summary: message,
        filesChanged: [],
      });
    } catch (markErr) {
      logger.warn(
        `run_agent terminal rollback failed for ${plan.runId}: ${errorMessage(markErr)}`,
      );
    }
    await cleanupAllocatedWorktree(ctx, plan, 'start failure');
    throw new DispatchError(message, { warnings });
  }

  const eventsLogPath = ctx.runStateStore.eventsLogPath(plan.runId);
  const tailCommandPath = ctx.runStateStore.tailCommandPath(plan.runId);
  return {
    runId: plan.runId,
    worktreePath: plan.worktreePath,
    readOnly: plan.readOnly,
    tailUrl: crewTailUrl(eventsLogPath),
    tailCommandPath,
    toolCallId: plan.toolCallId,
    warnings,
  };
}

type DispatchTerminal =
  | { kind: 'complete'; result: TaskResult }
  | { kind: 'failed'; error: string }
  | { kind: 'cancelled'; reason: string };

function installRunLifecycleListeners(args: {
  dispatcher: ToolDispatcher;
  runStateStore: RunStateStore;
  runId: string;
  agentName: string;
  toolCallId: string;
  progress?: ProgressNotifier;
}): Promise<DispatchTerminal> {
  return new Promise<DispatchTerminal>((resolve) => {
    const subs: Array<{ dispose(): void }> = [];
    const onTerminal = (terminal: DispatchTerminal): void => {
      try {
        if (terminal.kind === 'complete') {
          args.runStateStore.markTerminal(args.runId, {
            status: terminal.result.status,
            summary: terminal.result.output,
            filesChanged: terminal.result.filesModified,
            warnings: terminal.result.warnings,
          });
        } else if (terminal.kind === 'failed') {
          args.runStateStore.markTerminal(args.runId, {
            status: 'error',
            summary: terminal.error,
            filesChanged: [],
            lastError: terminal.error,
          });
        } else {
          args.runStateStore.markTerminal(args.runId, {
            status: 'cancelled',
            summary: terminal.reason,
            filesChanged: [],
          });
        }
      } catch (err) {
        logger.warn(
          `Failed to write run state for ${args.runId}: ${errorMessage(err)}`,
        );
      }
      for (const s of subs) s.dispose();
      resolve(terminal);
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
        if (info.toolCallId !== args.toolCallId) return;
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

async function cleanupAllocatedWorktree(
  ctx: DispatchContext,
  plan: RunAgentDispatchPlan,
  reason: string,
): Promise<void> {
  if (plan.readOnly) return;
  try {
    await ctx.worktreeManager.cleanupByRunId(plan.runId);
  } catch (err) {
    logger.warn(
      `run_agent cleanup after ${reason} failed: ${errorMessage(err)}`,
    );
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
