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
  computeDepsFingerprint,
  resolveDepsStalenessAction,
} from '../../git/deps-provision.js';
import type { AgentAdapter, ModelSelectionRecord } from '../../adapters/types.js';
import { repoContextWarnings } from '../../adapters/repo-context.js';

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
import { readConfigFile, resolveCheckInIntervalMs } from '../../utils/config-store.js';
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
  contextFilesInputSchema,
  contextFilesUnsupportedMessage,
  contextFilesDispatchWarnings,
  hasAutomaticReviewContext,
  readOnlyAdvisoryWarning,
  readOnlyRejectMessage,
  resolveEffectiveEffort,
  resolveRequestedModelSelection,
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
import {
  continuationGoalPlan,
  GOAL_CONTINUATION_POLICIES,
  goalRequestSchema,
} from '../goals.js';

export const continueRunInputSchema = z.object({
  run_id: z.string().min(1),
  prompt: z.string().default(''),
  context_files: contextFilesInputSchema,
  peer_messages: z.array(peerMessageInputSchema).max(10000).optional(),
  criteria_set_id: z.string().min(1).optional(),
  model: z.string().trim().min(1).max(300).optional(),
  /**
   * Per-call reasoning effort override. Same precedence as run_agent:
   * wins over the user's agents.json default + adapter default.
   * Vocabulary mirrors codex's `model_reasoning_effort` set.
   */
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  /** Safe default is clear: stale native objectives never silently survive a
   * continuation. inherit and replace are explicit and aggregate-budgeted. */
  goal_policy: z.enum(GOAL_CONTINUATION_POLICIES).default('clear'),
  goal: goalRequestSchema.optional(),
  ban_override: z.boolean().optional(),
  same_host_ok: z.boolean().optional(),
  cap_override: z.boolean().optional(),
  dispatch_anyway: z.boolean().optional(),
}).strict();

export type ContinueRunInput = z.infer<typeof continueRunInputSchema>;

export const CONTINUE_RUN_DESCRIPTION =
  'Continue with prompt, peer_messages or per-call context_files. Capable supplied-text read_only runs refresh bounded diffs using their original review source. Remote context requires CREW_OPENAI_ALLOW_REMOTE_CONTEXT=1; restate intent for stateless agents. goal_policy: clear (default), inherit or replace; budgets cannot grow. Models are exact-or-refuse or inherited. Criteria/caps are rechecked. ban_override, same_host_ok, cap_override and health/quota dispatch_anyway require approval. effort may override defaults; run_mode stays sticky, ephemeral_review frozen. Returns async model/goal/relay/warnings and crew-wait required_next_action.';

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

  if (userPrompt === '' && validatedInput.length === 0 && !args.context_files?.length) {
    return errorContent('peer_messages.no_op: continue_run requires either prompt or peer_messages or context_files');
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
  if (args.context_files?.length && adapter.acceptsRepoContext !== true) {
    return errorContent(contextFilesUnsupportedMessage(adapter));
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

  const continueAgentPrefs = deps.readAgentPrefs();
  const modelSelection = await resolveContinuationModelSelection({
    adapter,
    explicitModel: args.model,
    priorPrompts: preState.prompts,
    agentPrefs: continueAgentPrefs,
  });
  if (!modelSelection.ok) {
    return errorContent(modelSelection.message);
  }

  // Exact model refusal happens before counters, sidecars, run state, or the
  // worktree can be mutated by this continuation.
  const toolCallId = randomUUID();
  const effectiveEffort = resolveEffectiveEffort(
    adapter,
    args.effort,
    continueAgentPrefs,
  );
  const priorGoal = preState.prompts.at(-1)?.goal;
  const goalPlan = continuationGoalPlan({
    adapter,
    runMode,
    policy: args.goal_policy ?? 'clear',
    request: args.goal,
    previous: priorGoal,
    budget: preState.goalBudget,
  });
  if (!goalPlan.ok) return errorContent(goalPlan.message);
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
    modelSelection: modelSelection.record,
    goal: goalPlan.record,
    goalBudget: goalPlan.budget,
  });
  const dispatchWarnings: string[] = runMode === 'read_only' && adapter.enforcesReadOnly !== true
    ? [readOnlyAdvisoryWarning(adapter.name)]
    : [];
  dispatchWarnings.push(...repoContextWarnings(adapter));
  dispatchWarnings.push(...contextFilesDispatchWarnings(adapter, args.context_files, hasAutomaticReviewContext(adapter, runMode)));
  dispatchWarnings.push(...policyWarnings);
  if (goalPlan.warning !== undefined) dispatchWarnings.push(goalPlan.warning);
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
        iterationLimits: readConfigFile(deps.crewHome).iterate,
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
  // Deps staleness: the continuation dirty-sync can replace
  // package.json / package-lock.json under an already-provisioned
  // node_modules. Re-check the persisted fingerprint; a mismatch warns,
  // and a run originally provisioned with the install-capable policy gets
  // a clone-only re-provision attempt (never an implicit mid-run install).
  if (runMode === 'write' && preState.deps !== undefined) {
    try {
      const freshFingerprint = await computeDepsFingerprint(state.worktreePath);
      const action = resolveDepsStalenessAction(preState.deps, freshFingerprint);
      if (action === 'reprovision') {
        // Atomic aside → clone-only → restore-on-failure, owned by the
        // worktree manager under one lock scope (stale deps beat no deps
        // at all; the old record is kept on every non-recloned outcome so
        // its old fingerprint re-triggers this check next continuation).
        const reprovision = await deps.worktreeManager.reprovisionRunDepsCloneOnly(args.run_id);
        if (reprovision.outcome === 'recloned' && reprovision.record !== undefined) {
          // Preserve the dispatch's install-capable intent for the next
          // staleness decision.
          const updated = {
            ...reprovision.record,
            requestedPolicy: preState.deps.requestedPolicy ?? preState.deps.policy,
          };
          await deps.runStateStore.update(args.run_id, (current) => ({
            ...current,
            deps: updated,
          }));
          warnings.push(
            'deps_stale: manifests changed since provisioning; node_modules re-cloned from the host.',
          );
        } else if (reprovision.outcome === 'restored') {
          warnings.push(
            'deps_stale: manifests changed but a clone-only re-provision was unavailable'
            + `${reprovision.detail !== undefined ? ` (${reprovision.detail})` : ''}; the original `
            + '(stale) node_modules was restored — the worker may need to reinstall deps itself.',
          );
        } else if (reprovision.outcome === 'restore_failed') {
          warnings.push(
            'deps_stale: manifests changed, the clone-only re-provision failed, AND the original '
            + `node_modules could not be restored (${reprovision.detail ?? 'unknown'}); the worktree `
            + 'currently has NO node_modules — tell the worker to reinstall deps.',
          );
        } else {
          warnings.push(
            'deps_stale: manifests changed since provisioning and no node_modules was present'
            + `${reprovision.detail !== undefined ? ` (${reprovision.detail})` : ''}; the worker may `
            + 'need to install deps itself.',
          );
        }
      } else if (action === 'warn') {
        warnings.push(
          'deps_stale: package.json/package-lock.json changed since node_modules was provisioned; '
          + 'the worker may need to reinstall deps itself.',
        );
      }
    } catch (err) {
      logger.warn(
        `continue_run deps staleness check failed for ${args.run_id}: ${errorMessage(err)}`,
      );
    }
  }
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
    contextFiles: args.context_files,
    reviewSource: state.repositoryReviewSource,
    onReviewSourceResolved: async (source) => {
      if (source.kind === 'unavailable') return;
      await deps.runStateStore.update(args.run_id, (current) => ({
        ...current,
        repositoryReviewSource: current.repositoryReviewSource ?? source,
      }));
    },
    dispatchMcpEnv,
    effectiveWorkingDirectory: state.worktreePath,
    worktreePath: state.worktreePath,
    runMode,
    dispatchWarnings,
    modelSelection: modelSelection.record,
    effectiveEffort,
    // Resume the prior turn's provider conversation so a stateful adapter (agy)
    // continues server-side context instead of starting fresh. Read from the
    // persisted run state; undefined for adapters that don't return a sessionId.
    resumeSessionId: preState.sessionId,
    goalConstraint: goalPlan.constraint,
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
      crewWaitCommand: deps.getCrewWaitCommand(extra),
      crewHome: deps.crewHome,
      projectRoot: deps.projectRoot,
      runMode,
      modelSelection: modelSelection.record,
      watcherCheckInIntervalMs: criteriaContract !== undefined && runMode === 'write'
        ? resolveCheckInIntervalMs(deps.crewHome)
        : undefined,
      onStartFailure: rollbackContinuation,
    });
  } catch (err) {
    return errorContent(err instanceof Error ? err.message : String(err));
  }
}

export async function resolveContinuationModelSelection(args: {
  readonly adapter: AgentAdapter;
  readonly explicitModel: string | undefined;
  readonly priorPrompts: readonly {
    readonly turn: number;
    readonly modelSelection?: ModelSelectionRecord;
  }[];
  readonly agentPrefs: Readonly<Record<string, { readonly model?: string }>>;
}): Promise<
  | { readonly ok: true; readonly record: ModelSelectionRecord }
  | { readonly ok: false; readonly message: string }
> {
  if (args.explicitModel !== undefined) {
    return resolveRequestedModelSelection(args.adapter, args.explicitModel, 'per_call');
  }

  const priorPrompt = args.priorPrompts.at(-1);
  const prior = priorPrompt?.modelSelection;
  if (prior !== undefined) {
    if (prior.source === 'cli_default' || prior.modelArgument === undefined) {
      return {
        ok: true,
        record: { source: 'cli_default', validation: 'cli_default' },
      };
    }
    return {
      ok: true,
      record: {
        source: 'inherited',
        requestedModel: prior.modelArgument,
        modelArgument: prior.modelArgument,
        ...(prior.displayName !== undefined ? { displayName: prior.displayName } : {}),
        validation: prior.validation,
        ...(priorPrompt !== undefined ? { inheritedFromTurn: priorPrompt.turn } : {}),
      },
    };
  }

  // Only legacy state lacks a prior decision. Modern continuations are sticky
  // and never pick up a changed per-machine preference mid-run.
  const legacyDefault = args.agentPrefs[args.adapter.name]?.model;
  if (legacyDefault !== undefined) {
    return resolveRequestedModelSelection(args.adapter, legacyDefault, 'agent_default');
  }
  return {
    ok: true,
    record: { source: 'cli_default', validation: 'cli_default' },
  };
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
