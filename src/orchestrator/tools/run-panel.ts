import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { z } from 'zod';

import { resolveReviewDispatchMode, type ReviewDispatchMode } from '../../adapters/types.js';
import type { EphemeralSnapshotSource } from '../../git/worktree.js';
import {
  DispatchError,
  dispatchRunAgentInternal,
  type DispatchContext,
  type DispatchRunAgentInternalResult,
} from '../dispatch-run-agent-internal.js';
import {
  resolveConfirmedCriteriaContract,
  type CriteriaContractResolution,
} from '../criteria/store.js';
import { validatePeerMessagesPreflight } from '../peer-messages/preflight.js';
import { peerMessageInputSchema, type PeerMessageInput } from '../peer-messages/schema.js';
import type { ProgressNotifier } from '../progress.js';
import type { RunStateV1 } from '../run-state.js';
import {
  PANEL_SCHEMA_VERSION,
  type PanelReviewerRecord,
  type PanelReviewerTerminalSnapshot,
  type PanelStateV1,
} from '../panels/schema.js';
import { buildImplementerPeerMessage } from '../panels/implementer-message.js';
import { validateRunPanelPreflight } from '../panels/preflight.js';
import {
  panelDir,
  readPanelState,
  snapshotPanelReviewerTerminal,
  writePanelStateAtomic,
} from '../panels/store.js';
import { loadWorkflowConfig } from '../../workflow/loader.js';
import type { FullConfig } from '../../workflow/types.js';
import { logBestEffortFailure } from '../../utils/best-effort.js';
import type {
  ClientKind,
  RequiredNextAction,
  ToolCallReturn,
  ToolHandlerDeps,
  ToolRequestExtra,
} from './shared.js';
import {
  agentIdForClientKind,
  errorContent,
  markdownContent,
  mdInlineCode,
  nextStepSentence,
  progressNotifierFrom,
  requiredNextActionForRun,
  requiredNextActionForRuns,
} from './shared.js';

const runPanelReviewerInputSchema = z.object({
  agent_id: z.string().min(1),
  prompt: z.string().min(1),
  model: z.string().optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  working_directory: z.string().optional(),
  read_only: z.boolean().optional(),
  peer_messages: z.array(peerMessageInputSchema).max(10000).optional(),
}).strict();

export const runPanelInputSchema = z.object({
  implementer_run_id: z.string().min(1).optional(),
  criteria_set_id: z.string().min(1).optional(),
  reviewers: z.array(runPanelReviewerInputSchema).max(100).optional(),
}).strict();

export type RunPanelInput = z.infer<typeof runPanelInputSchema>;
type RunPanelReviewerInput = z.infer<typeof runPanelReviewerInputSchema>;

export interface ReviewerDispatchEnvelope {
  readonly run_id: string;
  readonly agent_id: string;
  readonly tail_url: string;
  readonly worktree_path: string;
  readonly warnings: readonly string[];
  readonly required_next_action?: RequiredNextAction;
}

export interface FailedReviewerEnvelope {
  readonly agent_id: string;
  readonly error: string;
}

export interface RunPanelOutput {
  readonly panel_id: string;
  readonly partial: boolean;
  readonly required_next_action?: RequiredNextAction;
  readonly reviewers: readonly ReviewerDispatchEnvelope[];
  readonly failed_reviewers: readonly FailedReviewerEnvelope[];
}

export interface RunPanelHandlerContext extends DispatchContext {
  readonly progress?: ProgressNotifier;
  readonly dispatchRunAgentInternalImpl?: typeof dispatchRunAgentInternal;
  readonly onPanelStateWritten?: (state: PanelStateV1) => void | Promise<void>;
  readonly loadConfig?: (projectRoot: string) => FullConfig;
  readonly sameHostAgentId?: string;
  readonly clientKind?: ClientKind;
  readonly crewWaitCommand?: string;
}

export const RUN_PANEL_DESCRIPTION =
  'Dispatch parallel reviewers as one panel. Optionally bind a terminal implementer to prepend summary/files; omitted reviewers use workflow.agentDefaults.panel. agy auto-routes to ephemeral_review. Returns panel_id, reviewer run_ids, failures, and on Claude Code/hosted Codex a panel-level crew-wait watcher command in required_next_action; per-reviewer wait commands remain available for selective recovery. Do not block the turn long-polling get_run_status.';

export async function runPanelToolHandler(
  args: RunPanelInput,
  extra: ToolRequestExtra,
  deps: ToolHandlerDeps,
): Promise<ToolCallReturn> {
  const agentPrefs = deps.readAgentPrefs();
  const clientKind = deps.getClientKind();
  try {
    const out = await runPanelHandler(args, {
      registry: deps.registry,
      worktreeManager: deps.worktreeManager,
      runStateStore: deps.runStateStore,
      agentPrefs,
      dispatcher: deps.dispatcher,
      crewHome: deps.crewHome,
      repoRoot: deps.runStateStore.repoRoot,
      projectRoot: deps.projectRoot,
      onTerminalPersisted: deps.onTerminalPersisted,
      sameHostAgentId: agentIdForClientKind(clientKind),
      clientKind,
      crewWaitCommand: deps.getCrewWaitCommand(),
      progress: progressNotifierFrom(extra, 'run_panel', deps.progressTokenSeen),
    });
    return markdownContent(renderRunPanelMarkdown(out, clientKind), out);
  } catch (err) {
    return errorContent(err instanceof Error ? err.message : String(err));
  }
}

const PANEL_IMPLEMENTER_TERMINAL = new Set(['success', 'partial', 'error', 'cancelled']);
const DEFAULT_PANEL_REVIEW_PROMPT =
  'Review the target changes for correctness, regressions, and missing tests. Return concrete findings with file/line references when possible.';
// Parallelizes reviewer validation/dispatch setup. Ephemeral reviewers bound
// to the same implementer still serialize their snapshot copy on the source
// run lock so they cannot review a torn source worktree.
const PANEL_REVIEWER_SETUP_CONCURRENCY = 4;

export async function runPanelHandler(
  args: unknown,
  ctx: RunPanelHandlerContext,
): Promise<RunPanelOutput> {
  const input = runPanelInputSchema.parse(args);
  const reviewers = resolvePanelReviewers(input.reviewers, ctx);
  validateRunPanelPreflight(reviewers);

  const implementerState = input.implementer_run_id
    ? readImplementerState(input.implementer_run_id, ctx)
    : undefined;
  const criteriaContract = resolvePanelCriteriaContract(input, implementerState, ctx);

  const panelId = randomUUID();
  const targetPanelDir = panelDir(ctx.crewHome, panelId);
  mkdirSync(targetPanelDir, { recursive: true });

  const implementerMessage = implementerState
    ? buildImplementerPeerMessage(implementerState)
    : undefined;
  const clientKind = ctx.clientKind ?? 'unknown';
  const crewWaitCommand = ctx.crewWaitCommand;

  let panelState: PanelStateV1 = {
    ...buildStubPanelState(panelId, ctx.runStateStore.repoRoot, implementerState),
    reviewers: reviewers.map((reviewer) => pendingReviewerRecord(reviewer.agent_id)),
  };
  await writeAndNotify(targetPanelDir, panelState, ctx);

  const dispatchEnvelopes = new Array<ReviewerDispatchEnvelope | undefined>(reviewers.length);
  const dispatchImpl = ctx.dispatchRunAgentInternalImpl ?? dispatchRunAgentInternal;
  let panelWriteQueue = Promise.resolve();

  const enqueuePanelWrite = async (operation: () => Promise<void>): Promise<void> => {
    const nextWrite = panelWriteQueue.then(operation, operation);
    panelWriteQueue = nextWrite.then(() => undefined, () => undefined);
    await nextWrite;
  };

  const replaceReviewer = async (
    index: number,
    record: PanelReviewerRecord,
  ): Promise<void> => {
    await enqueuePanelWrite(async () => {
      const latest = readPanelState(targetPanelDir) ?? panelState;
      const nextReviewers = [...latest.reviewers];
      nextReviewers[index] = mergeReviewerRecord(nextReviewers[index], record);
      panelState = {
        ...latest,
        reviewers: nextReviewers,
      };
      await writeAndNotify(targetPanelDir, panelState, ctx);
    });
  };

  await mapWithConcurrency(reviewers, PANEL_REVIEWER_SETUP_CONCURRENCY, async (reviewer, index) => {
    const composed = composePeerMessages(implementerMessage, reviewer.peer_messages);
    // Reviewer placement is derived from the ADAPTER's reviewDispatchMode,
    // not from a panel-wide read_only: an ephemeral-worktree adapter (agy)
    // is auto-routed to run_mode:'ephemeral_review' with its own disposable
    // snapshot of the implementer worktree, 'unsupported' adapters are
    // refused outright, and everyone else stays on the cheap in-place
    // read-only binding.
    const dispatchMode = reviewerDispatchMode(ctx.registry, reviewer.agent_id);
    const ephemeralReviewer = dispatchMode === 'ephemeral-worktree';
    const reviewerHasExplicitReadOnly = reviewer.read_only !== undefined;
    const effectiveReadOnly = reviewer.read_only ?? (implementerState !== undefined);
    const suppressWorkingDirDefault =
      reviewerHasExplicitReadOnly
      && !effectiveReadOnly
      && implementerState !== undefined;
    const effectiveWorkingDirectory = ephemeralReviewer
      ? undefined
      : reviewer.working_directory
        ?? (suppressWorkingDirDefault ? undefined : implementerState?.worktreePath);

    try {
      validatePeerMessagesPreflight(composed, ctx.runStateStore.caps);
    } catch (err) {
      await replaceReviewer(index, failedReviewerRecord(reviewer.agent_id, errorMessage(err), []));
      return;
    }

    if (dispatchMode === 'unsupported') {
      await replaceReviewer(
        index,
        failedReviewerRecord(
          reviewer.agent_id,
          `run_panel.reviewer_dispatch_unsupported: agent "${reviewer.agent_id}" declares `
          + "reviewDispatchMode:'unsupported' — it cannot be dispatched as a panel reviewer. "
          + 'Route this review to another agent.',
          [],
        ),
      );
      return;
    }

    if (ephemeralReviewer) {
      // Validate, don't silently downgrade: an explicit read_only or
      // working_directory on an adapter that can ONLY review via an
      // ephemeral worktree contradicts the routing — fail this reviewer
      // with the fix instead of guessing which input wins.
      const rejection = ephemeralPanelReviewerRejection(reviewer, implementerState);
      if (rejection !== undefined) {
        await replaceReviewer(index, failedReviewerRecord(reviewer.agent_id, rejection, []));
        return;
      }
    } else if (effectiveWorkingDirectory && !existsSync(effectiveWorkingDirectory)) {
      await replaceReviewer(
        index,
        failedReviewerRecord(
          reviewer.agent_id,
          `working_directory does not exist: ${effectiveWorkingDirectory} (implementer worktree may have been removed)`,
          [],
        ),
      );
      return;
    }

    let record: PanelReviewerRecord;
    let envelope: ReviewerDispatchEnvelope | undefined;
    let settleReviewerRecord!: () => void;
    const reviewerRecordSettled = new Promise<void>((resolve) => {
      settleReviewerRecord = resolve;
    });
    try {
      const result = await dispatchImpl({
        input: {
          agent_id: reviewer.agent_id,
          prompt: reviewer.prompt,
          ...(input.criteria_set_id !== undefined ? { criteria_set_id: input.criteria_set_id } : {}),
          ...(reviewer.model !== undefined ? { model: reviewer.model } : {}),
          ...(reviewer.effort !== undefined ? { effort: reviewer.effort } : {}),
          ...(ephemeralReviewer
            ? { run_mode: 'ephemeral_review' as const }
            : {
                ...(effectiveWorkingDirectory !== undefined
                  ? { working_directory: effectiveWorkingDirectory }
                  : {}),
                read_only: effectiveReadOnly,
              }),
          ...(composed.length > 0 ? { peer_messages: composed } : {}),
        },
        ctx,
        ...(ephemeralReviewer && implementerState !== undefined
          ? { ephemeralReviewSnapshot: implementerSnapshotSource(implementerState, ctx) }
          : {}),
        progress: ctx.progress,
        ...(criteriaContract !== undefined ? { criteriaContract } : {}),
        linkCriteriaImplementerRun: false,
        onTerminalPersisted: async (state) => {
          // dispatchRunAgentInternal can reach a very fast terminal state
          // before it returns its envelope. Wait for the same-call final
          // reviewer record instead of fsyncing an onStart placeholder that
          // the final record immediately supersedes.
          await reviewerRecordSettled;
          try {
            await enqueuePanelWrite(async () => {
              panelState = snapshotPanelReviewerTerminal(
                targetPanelDir,
                state.runId,
                terminalSnapshotFromRunState(state),
              );
            });
          } catch (err) {
            logBestEffortFailure('panel.reviewer-terminal-snapshot', err);
          }
        },
      });
      record = dispatchedReviewerRecord(reviewer.agent_id, result);
      // Reviewer-level actions remain available for selective/degraded
      // waits; the returned panel envelope adds the primary all-reviewer
      // watcher once the successful run ids are known.
      const requiredNextAction = requiredNextActionForRun(
        clientKind,
        crewWaitCommand,
        result.runId,
        ctx.crewHome,
        ctx.projectRoot,
        1,
      );
      envelope = {
        run_id: result.runId,
        agent_id: reviewer.agent_id,
        tail_url: result.tailUrl,
        worktree_path: result.worktreePath,
        warnings: result.warnings,
        ...(requiredNextAction !== undefined
          ? { required_next_action: requiredNextAction }
          : {}),
      };
    } catch (err) {
      const warnings = err instanceof DispatchError ? err.warnings : [];
      record = failedReviewerRecord(reviewer.agent_id, errorMessage(err), warnings);
    }

    try {
      await replaceReviewer(index, record);
    } finally {
      settleReviewerRecord();
    }
    if (envelope) {
      dispatchEnvelopes[index] = envelope;
    }
  });
  await panelWriteQueue;

  const successfulReviewers = dispatchEnvelopes.filter(
    (envelope): envelope is ReviewerDispatchEnvelope => envelope !== undefined,
  );
  const panelRequiredNextAction = requiredNextActionForRuns(
    clientKind,
    crewWaitCommand,
    successfulReviewers.map((envelope) => envelope.run_id),
    ctx.crewHome,
    ctx.projectRoot,
    successfulReviewers.map(() => 1),
  );

  return {
    panel_id: panelId,
    partial: panelState.reviewers.some(isFailedReviewerRecord),
    ...(panelRequiredNextAction !== undefined
      ? { required_next_action: panelRequiredNextAction }
      : {}),
    reviewers: successfulReviewers,
    failed_reviewers: panelState.reviewers
      .filter(isFailedReviewerRecord)
      .map((reviewer) => ({
        agent_id: reviewer.agentId,
        error: reviewer.error,
      })),
  };
}

function renderRunPanelMarkdown(out: RunPanelOutput, clientKind: ClientKind): string {
  const lines = [
    `**Panel dispatched** \`${out.panel_id}\`.`,
    `- Reviewer runs: ${out.reviewers.length}`,
  ];
  for (const reviewer of out.reviewers) {
    lines.push(`- ${reviewer.agent_id}: run \`${reviewer.run_id}\``);
  }
  if (out.failed_reviewers.length > 0) {
    lines.push(
      `- Failed reviewers: ${out.failed_reviewers.length}`,
      ...out.failed_reviewers.map((reviewer) =>
        `  - ${reviewer.agent_id}: ${reviewer.error}`),
    );
  }
  if (out.required_next_action !== undefined) {
    lines.push('', '**REQUIRED before you end this turn:** spawn one panel watcher.');
    if (clientKind === 'claude-code') {
      lines.push(`- \`Bash(${out.required_next_action.command}, run_in_background: true)\``);
    } else if (clientKind === 'codex') {
      lines.push(
        `- Start the Crew skill's hosted background watcher using \`required_next_action.command_json\`, then end the turn. Command: ${mdInlineCode(out.required_next_action.command)}.`,
      );
    }
    lines.push('Skip it and panel completion cannot automatically wake this thread.');
    const selectiveActions = out.reviewers
      .map((reviewer) => reviewer.required_next_action)
      .filter((action): action is RequiredNextAction =>
        action !== undefined
        && action.command !== out.required_next_action?.command);
    if (selectiveActions.length > 0) {
      lines.push(
        '- Selective waits if the panel watcher degrades: '
        + selectiveActions.map((action) => mdInlineCode(action.command)).join(', '),
      );
    }
  } else {
    lines.push(`- Next: ${nextStepSentence(clientKind, false)}`);
  }
  return lines.join('\n');
}

function resolvePanelCriteriaContract(
  input: RunPanelInput,
  implementerState: RunStateV1 | undefined,
  ctx: RunPanelHandlerContext,
): CriteriaContractResolution | undefined {
  if (input.criteria_set_id === undefined) return undefined;
  if (implementerState !== undefined && implementerState.criteriaSetId !== input.criteria_set_id) {
    throw new Error(
      `criteria.linkage_mismatch: implementer run is linked to ${
        implementerState.criteriaSetId ?? '(none)'
      }, got ${input.criteria_set_id}`,
    );
  }
  return resolveConfirmedCriteriaContract({
    crewHome: ctx.crewHome,
    repoRoot: ctx.runStateStore.repoRoot,
    criteriaSetId: input.criteria_set_id,
  });
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        await worker(items[index], index);
      }
    },
  );
  await Promise.all(workers);
}

function terminalSnapshotFromRunState(state: RunStateV1): PanelReviewerTerminalSnapshot {
  const summary = state.prompts.at(-1)?.summary;
  return {
    status: state.status as PanelReviewerTerminalSnapshot['status'],
    ...(summary !== undefined ? { summary } : {}),
    filesChanged: state.filesChanged,
    ...(state.completedAt !== undefined ? { completedAt: state.completedAt } : {}),
    ...(state.failure !== undefined ? { failure: state.failure } : {}),
  };
}

/**
 * The reviewer's resolved `reviewDispatchMode` — how its adapter is placed
 * as a reviewer ('read-only-dispatch' in place, 'ephemeral-worktree' via a
 * disposable snapshot, 'unsupported' not dispatchable as a reviewer).
 * Reads the lazy registry proxy — the capability is declared on registry
 * metadata in parity with the adapter class, so no adapter load is needed.
 * Unknown agent ids resolve undefined and fall through to the standard
 * path (the dispatch itself reports them).
 */
function reviewerDispatchMode(
  registry: RunPanelHandlerContext['registry'],
  agentId: string,
): ReviewDispatchMode | undefined {
  const adapter = registry.get(agentId);
  return adapter === undefined ? undefined : resolveReviewDispatchMode(adapter);
}

function reviewerUsesEphemeralWorktree(
  registry: RunPanelHandlerContext['registry'],
  agentId: string,
): boolean {
  return reviewerDispatchMode(registry, agentId) === 'ephemeral-worktree';
}

/**
 * Validation for an ephemeral-worktree panel reviewer. Explicit
 * read_only / working_directory inputs contradict the derived placement;
 * per the reviewer-schema rule they are rejected, never silently
 * overridden. Also fails fast when the bound implementer worktree is gone.
 */
function ephemeralPanelReviewerRejection(
  reviewer: RunPanelReviewerInput,
  implementerState: RunStateV1 | undefined,
): string | undefined {
  if (reviewer.read_only !== undefined) {
    return `run_panel.ephemeral_reviewer_read_only: agent "${reviewer.agent_id}" reviews via `
      + "run_mode:'ephemeral_review' (a disposable snapshot worktree) and the panel routes it "
      + `there automatically; read_only:${reviewer.read_only} conflicts with that placement. `
      + 'Omit read_only for this reviewer.';
  }
  if (reviewer.working_directory !== undefined) {
    return `run_panel.ephemeral_reviewer_working_directory: agent "${reviewer.agent_id}" runs `
      + 'ephemeral reviews only inside a crew-allocated disposable snapshot worktree; refusing '
      + `the working_directory override "${reviewer.working_directory}". Omit working_directory — `
      + 'the panel snapshots the implementer worktree (or host repo when unbound) automatically.';
  }
  if (implementerState !== undefined && !existsSync(implementerState.worktreePath)) {
    return `snapshot source does not exist: ${implementerState.worktreePath} `
      + '(implementer worktree may have been removed)';
  }
  return undefined;
}

/**
 * Snapshot source for a bound ephemeral reviewer: the implementer's
 * worktree, guarded by a re-read of the implementer's run state after the
 * copy. A continue_run / merge / manual mutation landing mid-copy moves
 * status, prompts.length, or completedAt — the snapshot is then torn, so
 * the reviewer fails and its worktree is discarded rather than reviewing
 * a moved target.
 */
function implementerSnapshotSource(
  implementerState: RunStateV1,
  ctx: RunPanelHandlerContext,
): EphemeralSnapshotSource {
  const baseline = {
    status: implementerState.status,
    promptCount: implementerState.prompts.length,
    completedAt: implementerState.completedAt,
  };
  return {
    sourcePath: implementerState.worktreePath,
    sourceRunId: implementerState.runId,
    assertSourceStableAfterSync: () => {
      const latest = ctx.runStateStore.read(implementerState.runId);
      if (
        !latest
        || latest.status !== baseline.status
        || latest.prompts.length !== baseline.promptCount
        || latest.completedAt !== baseline.completedAt
      ) {
        throw new Error(
          `run_panel.implementer_mutated_during_snapshot: run ${implementerState.runId} changed `
          + 'while its worktree was being snapshotted for an ephemeral reviewer. The reviewer '
          + 'worktree was discarded; re-dispatch the panel when the implementer run is stable.',
        );
      }
    },
  };
}

function resolvePanelReviewers(
  reviewers: readonly RunPanelReviewerInput[] | undefined,
  ctx: RunPanelHandlerContext,
): RunPanelReviewerInput[] {
  if (reviewers && reviewers.length > 0) {
    return [...reviewers];
  }

  const config = (ctx.loadConfig ?? loadWorkflowConfig)(ctx.projectRoot);
  const panelDefaults = config.workflow.agentDefaults?.panel;
  const configuredReviewers = panelDefaults?.reviewers ?? [];
  const banList = new Set(panelDefaults?.banList ?? []);
  if (ctx.sameHostAgentId) {
    banList.add(ctx.sameHostAgentId);
  }

  const selected = configuredReviewers.filter((agentId) => !banList.has(agentId));
  if (selected.length === 0) {
    throw new Error(
      'run_panel.no_reviewers: no reviewers were provided and workflow.agentDefaults.panel.reviewers ' +
      'is empty after banList and same-host filtering. Configure reviewers with ' +
      '`crew-mcp config set workflow.agentDefaults.panel.reviewers \'["<agent_id>"]\'` ' +
      'or pass an explicit reviewers array for this run.',
    );
  }

  // Preference-filled ephemeral-worktree reviewers must NOT carry
  // read_only:true — the dispatch loop derives their run_mode from the
  // adapter capability, and an explicit read_only is a validation error
  // there (agy hard-rejects in-place read-only).
  return selected.map((agentId) => ({
    agent_id: agentId,
    prompt: DEFAULT_PANEL_REVIEW_PROMPT,
    ...(reviewerUsesEphemeralWorktree(ctx.registry, agentId) ? {} : { read_only: true }),
  }));
}

function readImplementerState(
  runId: string,
  ctx: RunPanelHandlerContext,
): RunStateV1 {
  const state = ctx.runStateStore.read(runId);
  if (!state) {
    throw new Error(`run_panel.implementer_unknown: ${runId}`);
  }
  if (!PANEL_IMPLEMENTER_TERMINAL.has(state.status)) {
    throw new Error(`run_panel.implementer_not_terminal: ${runId} status=${state.status}`);
  }
  if (state.repoRoot === undefined) {
    throw new Error(`run_panel.implementer_legacy_no_repo: ${runId}`);
  }
  if (state.repoRoot !== ctx.runStateStore.repoRoot) {
    throw new Error(
      `run_panel.implementer_cross_repo: ${runId} belongs to repo ${state.repoRoot}`,
    );
  }
  if (!existsSync(state.worktreePath)) {
    throw new Error(
      `run_panel.implementer_worktree_unavailable: ${state.worktreePath}`,
    );
  }
  return state;
}

function buildStubPanelState(
  panelId: string,
  panelRepoRoot: string,
  implementerState: RunStateV1 | undefined,
): PanelStateV1 {
  return {
    schemaVersion: PANEL_SCHEMA_VERSION,
    panelId,
    createdAt: new Date().toISOString(),
    panelRepoRoot,
    ...(implementerState
      ? {
          implementerRunId: implementerState.runId,
          implementerWorktreePath: implementerState.worktreePath,
          ...(implementerState.prompts.at(-1)?.summary !== undefined
            ? { implementerSummarySnapshot: implementerState.prompts.at(-1)?.summary }
            : {}),
          implementerRepoRoot: implementerState.repoRoot,
        }
      : {}),
    reviewers: [],
  };
}

function composePeerMessages(
  implementerMessage: PeerMessageInput | undefined,
  reviewerMessages: readonly PeerMessageInput[] | undefined,
): PeerMessageInput[] {
  return [
    ...(implementerMessage ? [implementerMessage] : []),
    ...(reviewerMessages ?? []),
  ];
}

function dispatchedReviewerRecord(
  agentId: string,
  result: DispatchRunAgentInternalResult,
): PanelReviewerRecord {
  return {
    runId: result.runId,
    agentId,
    dispatched: true,
    dispatchedAt: new Date().toISOString(),
    dispatchWarnings: result.warnings,
  };
}

function failedReviewerRecord(
  agentId: string,
  error: string,
  dispatchWarnings: readonly string[],
): PanelReviewerRecord {
  return {
    runId: null,
    agentId,
    dispatched: false,
    error,
    dispatchWarnings,
  };
}

function pendingReviewerRecord(agentId: string): PanelReviewerRecord {
  return {
    runId: null,
    agentId,
    dispatched: false,
    pending: true,
    dispatchWarnings: [],
  };
}

function mergeReviewerRecord(
  previous: PanelReviewerRecord | undefined,
  record: PanelReviewerRecord,
): PanelReviewerRecord {
  if (
    previous?.dispatched
    && record.dispatched
    && previous.runId === record.runId
    && previous.terminalSnapshot !== undefined
  ) {
    return {
      ...record,
      terminalSnapshot: previous.terminalSnapshot,
    };
  }
  return record;
}

function isFailedReviewerRecord(
  reviewer: PanelReviewerRecord,
): reviewer is Extract<PanelReviewerRecord, { dispatched: false; error: string }> {
  return !reviewer.dispatched && !('pending' in reviewer && reviewer.pending);
}

async function writeAndNotify(
  targetPanelDir: string,
  state: PanelStateV1,
  ctx: RunPanelHandlerContext,
): Promise<void> {
  writePanelStateAtomic(targetPanelDir, state);
  await ctx.onPanelStateWritten?.(state);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
