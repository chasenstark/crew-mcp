import type { AdapterRegistry } from '../adapters/registry.js';
import type { AgentPrefsMap } from '../agent-prefs/store.js';
import type { EphemeralSnapshotSource, WorktreeManager } from '../git/worktree.js';
import { crewTailUrl } from '../cli/commands/tail-url.js';
import { logger } from '../utils/logger.js';
import {
  linkCriteriaSetImplementerRun,
  resolveConfirmedCriteriaContract,
  type CriteriaContractResolution,
} from './criteria/store.js';
import { validatePeerMessagesPreflight } from './peer-messages/preflight.js';
import { type ProgressNotifier } from './progress.js';
import { installRunLifecycleListeners } from './run-lifecycle-listeners.js';
import { ownsWorktree, type RunMode } from './run-mode.js';
import type { RunStateStore, RunStateV1 } from './run-state.js';
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
  readonly onTerminalPersisted?: (state: RunStateV1) => void | Promise<void>;
}

export interface DispatchRunAgentInternalArgs {
  readonly input: RunAgentInput;
  readonly ctx: DispatchContext;
  readonly progress?: ProgressNotifier;
  readonly criteriaContract?: CriteriaContractResolution;
  readonly linkCriteriaImplementerRun?: boolean;
  /**
   * INTERNAL (run_panel): snapshot an `ephemeral_review` reviewer's
   * disposable worktree from this source worktree (implementer HEAD +
   * dirty state) instead of the host repo. Rejected at plan time for any
   * other run_mode. See RunAgentHandlerContext.ephemeralReviewSnapshot.
   */
  readonly ephemeralReviewSnapshot?: EphemeralSnapshotSource;
  readonly onStart?: (
    info: { agentName: string; runId: string; worktreePath: string },
  ) => void | Promise<void>;
  readonly onTerminalPersisted?: (state: RunStateV1) => void | Promise<void>;
}

export interface DispatchRunAgentInternalResult {
  readonly runId: string;
  readonly worktreePath: string;
  readonly runMode: RunMode;
  /** Legacy convenience: `runMode === 'read_only'`. Prefer `runMode`. */
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
  let criteriaContract: CriteriaContractResolution | undefined;
  try {
    criteriaContract = args.criteriaContract ?? (
      input.criteria_set_id !== undefined
        ? resolveConfirmedCriteriaContract({
            crewHome: ctx.crewHome,
            repoRoot: ctx.runStateStore.repoRoot,
            criteriaSetId: input.criteria_set_id,
          })
        : undefined
    );
  } catch (err) {
    throw new DispatchError(errorMessage(err));
  }

  let plan: Awaited<ReturnType<typeof planRunAgent>>;
  try {
    plan = await planRunAgent(input, {
      ...ctx,
      ...(args.onStart !== undefined ? { onStart: args.onStart } : {}),
      ...(args.ephemeralReviewSnapshot !== undefined
        ? { ephemeralReviewSnapshot: args.ephemeralReviewSnapshot }
        : {}),
    });
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
      ...(criteriaContract !== undefined
        ? {
            contractPrefix: criteriaContract.contractPrefix,
            criteriaSetId: criteriaContract.criteriaSetId,
            criteriaEpoch: criteriaContract.criteriaEpoch,
          }
        : {}),
      runMode: plan.runMode,
    });
    if (criteriaContract !== undefined && args.linkCriteriaImplementerRun !== false) {
      await linkCriteriaSetImplementerRun({
        crewHome: ctx.crewHome,
        criteriaSetId: criteriaContract.criteriaSetId,
        runId: plan.runId,
      });
    }
    warnings = [
      ...plan.dispatchWarnings,
      ...createResult.warnings,
      ...criteriaPeerMessageBypassWarnings(input.criteria_set_id, validatedInput, criteriaContract),
    ];
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
    onTerminalPersisted: composeTerminalPersistedHooks(
      ctx.onTerminalPersisted,
      args.onTerminalPersisted,
    ),
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
    runMode: plan.runMode,
    readOnly: plan.readOnly,
    tailUrl: crewTailUrl(eventsLogPath),
    tailCommandPath,
    toolCallId: plan.toolCallId,
    warnings,
  };
}

export function criteriaPeerMessageBypassWarnings(
  criteriaSetId: string | undefined,
  peerMessages: readonly { readonly from_label?: string }[],
  criteriaContract: CriteriaContractResolution | undefined,
): readonly string[] {
  if (criteriaSetId !== undefined || criteriaContract !== undefined) return [];
  if (!peerMessages.some((message) =>
    message.from_label !== undefined && /acceptance criteria/i.test(message.from_label))) {
    return [];
  }
  return [
    'criteria.peer_message_without_criteria_set_id: criteria passed as peer_message without criteria_set_id - store enforcement bypassed',
  ];
}

async function cleanupAllocatedWorktree(
  ctx: DispatchContext,
  plan: RunAgentDispatchPlan,
  reason: string,
): Promise<void> {
  if (!ownsWorktree(plan.runMode)) return;
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

function composeTerminalPersistedHooks(
  first: ((state: RunStateV1) => void | Promise<void>) | undefined,
  second: ((state: RunStateV1) => void | Promise<void>) | undefined,
): ((state: RunStateV1) => Promise<void>) | undefined {
  if (first === undefined && second === undefined) return undefined;
  return async (state) => {
    let failure: unknown;
    for (const hook of [first, second]) {
      if (hook === undefined) continue;
      try {
        await hook(state);
      } catch (err) {
        failure ??= err;
      }
    }
    if (failure !== undefined) throw failure;
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
