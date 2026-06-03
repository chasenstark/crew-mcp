import type { AdapterRegistry } from '../adapters/registry.js';
import type { AgentPrefsMap } from '../agent-prefs/store.js';
import type { WorktreeManager } from '../git/worktree.js';
import { crewTailUrl } from '../cli/commands/tail-url.js';
import { logger } from '../utils/logger.js';
import { validatePeerMessagesPreflight } from './peer-messages/preflight.js';
import { type ProgressNotifier } from './progress.js';
import { installRunLifecycleListeners } from './run-lifecycle-listeners.js';
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
    warnings = [...plan.dispatchWarnings, ...createResult.warnings];
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
      await ctx.runStateStore.markTerminal(plan.runId, {
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

async function cleanupAllocatedWorktree(
  ctx: DispatchContext,
  plan: RunAgentDispatchPlan,
  reason: string,
): Promise<void> {
  if (plan.readOnly) return;
  try {
    const cleanup = await ctx.worktreeManager.cleanupByRunId(plan.runId);
    if (!cleanup.success) {
      logger.warn(
        `run_agent cleanup after ${reason} failed: ${cleanup.errors.join('; ')}`,
      );
    }
  } catch (err) {
    logger.warn(
      `run_agent cleanup after ${reason} failed: ${errorMessage(err)}`,
    );
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
