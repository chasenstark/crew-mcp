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
 * surfaced out-of-band via crew-wait watchers (Claude Code/Codex), or
 * later get_run_status / list_runs reads.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import {
  criteriaPeerMessageBypassWarnings,
  DispatchError,
  revokeSidecarBestEffort,
  revokeSidecarOnTerminal,
} from '../dispatch-run-agent-internal.js';
import {
  recordCriteriaIterationContinuation,
  resolveConfirmedCriteriaContract,
  type CriteriaContractResolution,
} from '../criteria/store.js';
import { validatePeerMessagesPreflight } from '../peer-messages/preflight.js';
import { appendWorkerFooterForAdapter } from '../peer-messages/worker-footer.js';
import type { PeerMessageInput } from '../peer-messages/schema.js';
import { peerMessageInputSchema } from '../peer-messages/schema.js';
import { logger } from '../../utils/logger.js';
import { loadWorkflowConfig } from '../../workflow/loader.js';
import {
  deleteWorkerReadyMarker,
  issueRunAuthSidecar,
  startWorkerReadyHandshake,
  type DispatchMcpEnv,
} from '../auth/index.js';
import { ownsWorktree, runModeFromState } from '../run-mode.js';
import {
  buildAdapterDispatchTask,
  readOnlyAdvisoryWarning,
  readOnlyRejectMessage,
  applyModelPreflight,
  resolveEffectiveEffort,
  resolveEffectiveModel,
} from './run-agent.js';
import type { ToolCallReturn, ToolHandlerDeps, ToolRequestExtra } from './shared.js';
import {
  errorContent,
  errorMessage,
  agentIdForClientKind,
  inFlightForRun,
  progressNotifierFrom,
  runDispatchAndRespond,
} from './shared.js';
import { assertNoBusyWorktreeBlockers } from './lifecycle-guards.js';
import {
  agentBannedMessage,
  banOverrideWarning,
  findAgentBanMatch,
  isSameHostAgent,
  sameHostOverrideWarning,
} from './dispatch-policy.js';
import { preflightAgentDispatch } from './dispatch-preflight.js';

export const continueRunInputSchema = z.object({
  run_id: z.string().min(1),
  prompt: z.string().default(''),
  peer_messages: z.array(peerMessageInputSchema).max(10000).optional(),
  criteria_set_id: z.string().min(1).optional(),
  model: z.string().optional(),
  /**
   * Per-call reasoning effort override. Same precedence as run_agent:
   * wins over the user's agents.json default + adapter default.
   * Vocabulary mirrors codex's `model_reasoning_effort` set.
   */
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  ban_override: z.boolean().optional(),
  same_host_ok: z.boolean().optional(),
  cap_override: z.boolean().optional(),
  dispatch_anyway: z.boolean().optional(),
}).strict();

export type ContinueRunInput = z.infer<typeof continueRunInputSchema>;

export const CONTINUE_RUN_DESCRIPTION =
  'Resume an existing run with prompt and/or peer_messages. Linked criteria re-check policy and the continuation cap; ban_override, same_host_ok, cap_override, and health/quota dispatch_anyway require user approval. model/effort may override defaults and run_mode stays sticky; ephemeral_review continues against its frozen snapshot. Returns async with bounded relay_verbatim/ledger_line, warnings, and required_next_action crew-wait watcher when available.';

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
  try {
    assertNoBusyWorktreeBlockers({
      targetRun: preState,
      runStateStore: deps.runStateStore,
      dispatcher: deps.dispatcher,
    });
  } catch (err) {
    return errorContent(err instanceof Error ? err.message : String(err));
  }
  const adapter = typeof deps.registry.load === 'function'
    ? await deps.registry.load(preState.agentId)
    : deps.registry.get(preState.agentId);
  if (!adapter) {
    return errorContent(
      `Agent "${preState.agentId}" is no longer registered; cannot continue run "${args.run_id}".`,
    );
  }
  // Sticky lifecycle mode, resolved once for every branch below. Legacy
  // records (no runMode field) derive from the persisted readOnly shim.
  const runMode = runModeFromState(preState);
  // Defense in depth: a read-only run for a reject-read-only adapter should
  // never exist (planRunAgent refuses to create one), but if one is encountered
  // (e.g. a future adapter gained rejectsReadOnly after read-only runs existed),
  // refuse the continuation fail-closed rather than emit the "run it anyway"
  // advisory below. ephemeral_review is NOT rejected here — it is
  // continue-capable by design (conversational reviews, frozen snapshot).
  if (runMode === 'read_only' && adapter.rejectsReadOnly === true) {
    return errorContent(readOnlyRejectMessage(adapter.name, adapter));
  }
  const continueExtra = extra;
  let criteriaContract: CriteriaContractResolution | undefined;
  try {
    criteriaContract = resolveContinuationCriteriaContract({
      crewHome: deps.crewHome,
      repoRoot: deps.runStateStore.repoRoot,
      requestedCriteriaSetId: args.criteria_set_id,
      recordedCriteriaSetId: preState.criteriaSetId,
    });
  } catch (err) {
    return errorContent(err instanceof Error ? err.message : String(err));
  }

  const policyWarnings: string[] = [];
  try {
    const config = (deps.loadWorkflowConfig ?? loadWorkflowConfig)(deps.projectRoot);
    const banMatch = findAgentBanMatch({
      registry: deps.registry,
      config,
      agentId: adapter.name,
      scopes: criteriaContract === undefined ? ['iterate', 'panel'] : ['iterate'],
    });
    if (banMatch !== undefined) {
      if (args.ban_override !== true) {
        return errorContent(agentBannedMessage(
          banMatch,
          `continue_run refused for run "${args.run_id}": the newly matching rule applies to `,
        ));
      }
      policyWarnings.push(banOverrideWarning(banMatch));
    }
    if (isSameHostAgent({
      registry: deps.registry,
      agentId: adapter.name,
      sameHostAgentId: agentIdForClientKind(deps.getClientKind()),
    })) {
      if (args.same_host_ok !== true) {
        return errorContent(
          `same_host_reviewer: continue_run refused for run "${args.run_id}" because agent `
          + `"${adapter.name}" newly matches the current host. Ask the user to approve own-host `
          + 'dispatch, then retry with same_host_ok:true.',
        );
      }
      policyWarnings.push(sameHostOverrideWarning(adapter.name));
    }
    const dispatchPreflight = await preflightAgentDispatch({
      registry: deps.registry,
      agentId: adapter.name,
      quotaProbe: deps.quotaProbe,
      dispatchAnyway: args.dispatch_anyway,
    });
    if (dispatchPreflight.refuse !== undefined) {
      return errorContent(dispatchPreflight.refuse.message);
    }
    policyWarnings.push(...dispatchPreflight.warnings);
  } catch (err) {
    return errorContent(err instanceof Error ? err.message : String(err));
  }

  const toolCallId = randomUUID();
  const continueAgentPrefs = deps.readAgentPrefs();
  const effectiveEffort = resolveEffectiveEffort(
    adapter,
    args.effort,
    continueAgentPrefs,
  );
  const modelPreflight = applyModelPreflight(
    adapter,
    resolveEffectiveModel(adapter, args.model, continueAgentPrefs),
  );
  const effectiveModel = modelPreflight.model;
  const appendPrompt = () => deps.runStateStore.appendPrompt(args.run_id, {
    userPrompt,
    peerMessagesInput: validatedInput.length > 0 ? validatedInput : undefined,
    ...(criteriaContract !== undefined
      ? {
          contractPrefix: criteriaContract.contractPrefix,
          criteriaSetId: criteriaContract.criteriaSetId,
          criteriaEpoch: criteriaContract.criteriaEpoch,
        }
      : {}),
    workerReady: { status: 'pending' },
  });
  const dispatchWarnings: string[] = runMode === 'read_only' && adapter.enforcesReadOnly !== true
    ? [readOnlyAdvisoryWarning(adapter.name)]
    : [];
  dispatchWarnings.push(...policyWarnings);
  if (modelPreflight.warning !== undefined) {
    dispatchWarnings.push(modelPreflight.warning);
  }
  const criteriaWarnings = criteriaPeerMessageBypassWarnings(
    args.criteria_set_id,
    validatedInput,
    criteriaContract,
  );
  if (criteriaContract !== undefined) {
    try {
      const continuation = await recordCriteriaIterationContinuation({
        crewHome: deps.crewHome,
        criteriaSetId: criteriaContract.criteriaSetId,
        expectedEpoch: criteriaContract.criteriaEpoch,
        capOverride: args.cap_override === true,
      });
      dispatchWarnings.push(...continuation.warnings);
    } catch (err) {
      return errorContent(err instanceof Error ? err.message : String(err));
    }
  }

  const rollbackContinuation = async (err: unknown): Promise<DispatchError> => {
    const message = `continue_run dispatch failed for ${args.run_id}: ${errorMessage(err)}`;
    await markContinueDispatchFailed(deps, args.run_id, message);
    await revokeSidecarBestEffort(deps.crewHome, args.run_id, 'continue_run rollback');
    deleteWorkerReadyMarker(deps.crewHome, args.run_id);
    return new DispatchError(message, { warnings: [...dispatchWarnings, ...criteriaWarnings] });
  };

  let appendResult: Awaited<ReturnType<typeof deps.runStateStore.appendPrompt>>;
  await revokeSidecarBestEffort(deps.crewHome, args.run_id, 'new continue_run dispatch');
  deleteWorkerReadyMarker(deps.crewHome, args.run_id);
  // Source re-sync runs ONLY for write continues: an ephemeral_review
  // continue keeps a FROZEN snapshot, so the follow-up reasons about exactly
  // what was reviewed rather than a moved target (read_only has no worktree
  // to sync at all).
  try {
    if (runMode === 'write') {
      appendResult = await deps.worktreeManager.appendAndSyncUncommittedToRunWorktree(
        args.run_id,
        appendPrompt,
      );
    } else if (ownsWorktree(runMode)) {
      appendResult = await deps.worktreeManager.withRunWorktreeLock(args.run_id, appendPrompt);
    } else {
      appendResult = await appendPrompt();
    }
  } catch (err) {
    if (runMode === 'write' && deps.runStateStore.read(args.run_id)?.status === 'running') {
      const dispatchErr = await rollbackContinuation(err);
      return errorContent(dispatchErr.message);
    }
    return errorContent(err instanceof Error ? err.message : String(err));
  }
  const { state, composedPrompt } = appendResult;
  const warnings = [
    ...appendResult.warnings,
    ...criteriaWarnings,
  ];
  let dispatchMcpEnv: DispatchMcpEnv;
  try {
    const issued = await issueRunAuthSidecar({
      crewHome: deps.crewHome,
      runId: args.run_id,
      agentId: state.agentId,
      repoRoot: deps.runStateStore.repoRoot,
      captainServeInstance: deps.captainServeInstance ?? 'unknown-captain-serve',
      writeMode: 'replace-existing',
    });
    dispatchMcpEnv = issued.dispatchMcpEnv;
  } catch (err) {
    const dispatchErr = await rollbackContinuation(err);
    return errorContent(dispatchErr.message);
  }

  const task = buildAdapterDispatchTask({
    toolCallId,
    runId: args.run_id,
    adapter,
    prompt: appendWorkerFooterForAdapter(composedPrompt, adapter),
    dispatchMcpEnv,
    effectiveWorkingDirectory: state.worktreePath,
    worktreePath: state.worktreePath,
    runMode,
    dispatchWarnings,
    effectiveModel,
    effectiveEffort,
    // Resume the prior turn's provider conversation so a stateful adapter (agy)
    // continues server-side context instead of starting fresh. Read from the
    // persisted run state; undefined for adapters that don't return a sessionId.
    resumeSessionId: preState.sessionId,
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
      onTerminalPersisted: async (terminalState) => {
        await revokeSidecarOnTerminal(deps.crewHome)(terminalState);
        await deps.onTerminalPersisted?.(terminalState);
      },
      onDispatchStarted: () => startWorkerReadyHandshake({
        crewHome: deps.crewHome,
        runId: args.run_id,
        runStateStore: deps.runStateStore,
      }),
      clientKind: deps.getClientKind(),
      crewWaitCommand: deps.getCrewWaitCommand(),
      crewHome: deps.crewHome,
      projectRoot: deps.projectRoot,
      runMode,
      onStartFailure: rollbackContinuation,
    });
  } catch (err) {
    return errorContent(err instanceof Error ? err.message : String(err));
  }
}

function resolveContinuationCriteriaContract(args: {
  readonly crewHome: string;
  readonly repoRoot: string;
  readonly requestedCriteriaSetId: string | undefined;
  readonly recordedCriteriaSetId: string | undefined;
}): CriteriaContractResolution | undefined {
  if (
    args.requestedCriteriaSetId !== undefined
    && args.recordedCriteriaSetId !== undefined
    && args.requestedCriteriaSetId !== args.recordedCriteriaSetId
  ) {
    throw new Error(
      `criteria.linkage_mismatch: run is linked to ${args.recordedCriteriaSetId}, got ${args.requestedCriteriaSetId}`,
    );
  }
  const criteriaSetId = args.requestedCriteriaSetId ?? args.recordedCriteriaSetId;
  if (criteriaSetId === undefined) return undefined;
  return resolveConfirmedCriteriaContract({
    crewHome: args.crewHome,
    repoRoot: args.repoRoot,
    criteriaSetId,
  });
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
