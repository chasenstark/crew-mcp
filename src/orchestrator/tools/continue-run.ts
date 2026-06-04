/**
 * continue_run — resume an existing run with new instructions.
 *
 * The worktree stays alive; the same agent (per the run's recorded
 * agent_id) is re-invoked with a fresh prompt against the same working
 * directory. Use this when you want to ask the implementer to fix the
 * issues a reviewer found, or when the user provides a follow-up
 * instruction without wanting to start over.
 *
 * Returns the same async-first envelope shape as run_agent
 * (run_id, worktree_path, status: "running"). Terminal results are
 * surfaced out-of-band via crew-wait watchers (Claude Code), or
 * later get_run_status / list_runs reads.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { DispatchError } from '../dispatch-run-agent-internal.js';
import { validatePeerMessagesPreflight } from '../peer-messages/preflight.js';
import type { PeerMessageInput } from '../peer-messages/schema.js';
import { peerMessageInputSchema } from '../peer-messages/schema.js';
import { logger } from '../../utils/logger.js';
import {
  buildAdapterDispatchTask,
  captureRunBranchPointSnapshot,
  readOnlyAdvisoryWarning,
  resolveEffectiveEffort,
  resolveEffectiveModel,
} from './run-agent.js';
import type { ToolCallReturn, ToolHandlerDeps, ToolRequestExtra } from './shared.js';
import {
  errorContent,
  errorMessage,
  inFlightForRun,
  progressNotifierFrom,
  runDispatchAndRespond,
} from './shared.js';

export const continueRunInputSchema = z.object({
  run_id: z.string().min(1),
  prompt: z.string().default(''),
  peer_messages: z.array(peerMessageInputSchema).max(10000).optional(),
  model: z.string().optional(),
  /**
   * Per-call reasoning effort override. Same precedence as run_agent:
   * wins over the user's agents.json default + adapter default.
   * Vocabulary mirrors codex's `model_reasoning_effort` set.
   */
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
});

export type ContinueRunInput = z.infer<typeof continueRunInputSchema>;

export const CONTINUE_RUN_DESCRIPTION =
  'Resume an existing run with a new prompt and/or structured peer_messages when the same agent should continue in the same worktree. Input takes run_id, optional prompt, optional peer_messages, and optional model/effort overrides; read_only mode stays sticky from the original run. Returns the same async dispatch envelope as run_agent (run_id, tail_url); on Claude Code spawn crew-wait <run_id> in background, on other hosts check via get_run_status / list_runs on a later turn. Do not block the turn long-polling get_run_status.';

export async function continueRunToolHandler(
  args: ContinueRunInput,
  extra: ToolRequestExtra,
  deps: ToolHandlerDeps,
): Promise<ToolCallReturn> {
  const userPrompt = args.prompt ?? '';
  const preState = deps.runStateStore.read(args.run_id);
  if (!preState) {
    return errorContent(`Unknown run_id "${args.run_id}".`);
  }

  let validatedInput: readonly PeerMessageInput[];
  try {
    validatedInput = validatePeerMessagesPreflight(args.peer_messages, deps.runStateStore.caps);
  } catch (err) {
    return errorContent(err instanceof Error ? err.message : String(err));
  }

  if (userPrompt === '' && validatedInput.length === 0) {
    return errorContent('peer_messages.no_op: continue_run requires either prompt or peer_messages');
  }

  if (preState.status === 'running') {
    return errorContent('continue_run: run is currently running; call cancel_run first.');
  }
  const existingInFlight = inFlightForRun(deps.dispatcher, args.run_id);
  if (existingInFlight) {
    return errorContent(
      `continue_run: run "${args.run_id}" still has in-flight work ` +
      `(${existingInFlight.toolName}); retry after it finishes or call cancel_run first.`,
    );
  }
  if (
    preState.status === 'discarded'
    || preState.status === 'merged'
    || preState.status === 'merge_conflict'
  ) {
    return errorContent(
      `Cannot continue run "${args.run_id}" with status "${preState.status}".`,
    );
  }
  const adapter = typeof deps.registry.load === 'function'
    ? await deps.registry.load(preState.agentId)
    : deps.registry.get(preState.agentId);
  if (!adapter) {
    return errorContent(
      `Agent "${preState.agentId}" is no longer registered; cannot continue run "${args.run_id}".`,
    );
  }
  const continueExtra = extra;

  const toolCallId = randomUUID();
  const continueAgentPrefs = deps.readAgentPrefs();
  const effectiveEffort = resolveEffectiveEffort(
    adapter,
    args.effort,
    continueAgentPrefs,
  );
  const effectiveModel = resolveEffectiveModel(
    adapter,
    args.model,
    continueAgentPrefs,
  );
  let appendResult: Awaited<ReturnType<typeof deps.runStateStore.appendPrompt>>;
  try {
    appendResult = await deps.runStateStore.appendPrompt(args.run_id, {
      userPrompt,
      peerMessagesInput: validatedInput.length > 0 ? validatedInput : undefined,
    });
  } catch (err) {
    return errorContent(err instanceof Error ? err.message : String(err));
  }
  const { state, composedPrompt, warnings } = appendResult;
  const dispatchWarnings = state.readOnly === true && adapter.enforcesReadOnly !== true
    ? [readOnlyAdvisoryWarning(adapter.name)]
    : [];

  const rollbackContinuation = async (err: unknown): Promise<DispatchError> => {
    const message = `continue_run dispatch failed for ${args.run_id}: ${errorMessage(err)}`;
    await markContinueDispatchFailed(deps, args.run_id, message);
    return new DispatchError(message, { warnings: [...dispatchWarnings, ...warnings] });
  };

  if (state.readOnly !== true) {
    try {
      await deps.worktreeManager.syncUncommittedToRunWorktree(args.run_id);
    } catch (err) {
      const dispatchErr = await rollbackContinuation(err);
      return errorContent(dispatchErr.message);
    }
  }
  const branchPointBefore =
    state.readOnly !== true
      ? await captureRunBranchPointSnapshot(deps.worktreeManager, args.run_id, state.worktreePath)
      : undefined;

  const task = buildAdapterDispatchTask({
    toolCallId,
    runId: args.run_id,
    adapter,
    prompt: composedPrompt,
    effectiveWorkingDirectory: state.worktreePath,
    worktreePath: state.worktreePath,
    readOnly: state.readOnly === true,
    dispatchWarnings,
    branchPointBefore,
    effectiveModel,
    effectiveEffort,
    worktreeManager: deps.worktreeManager,
    input: { ...args },
  });

  try {
    return await runDispatchAndRespond({
      runId: args.run_id,
      agentName: state.agentId,
      worktreePath: state.worktreePath,
      toolCallId,
      task,
      dispatcher: deps.dispatcher,
      runStateStore: deps.runStateStore,
      warnings: [...dispatchWarnings, ...warnings],
      progress: progressNotifierFrom(continueExtra, state.agentId, deps.progressTokenSeen),
      clientKind: deps.getClientKind(),
      onStartFailure: rollbackContinuation,
    });
  } catch (err) {
    return errorContent(err instanceof Error ? err.message : String(err));
  }
}

async function markContinueDispatchFailed(
  deps: Pick<ToolHandlerDeps, 'runStateStore'>,
  runId: string,
  message: string,
): Promise<void> {
  try {
    await deps.runStateStore.markTerminal(runId, {
      status: 'error',
      summary: message,
      filesChanged: [],
      lastError: message,
    });
  } catch (err) {
    logger.warn(
      `continue_run terminal rollback failed for ${runId}: ${errorMessage(err)}`,
    );
  }
}
