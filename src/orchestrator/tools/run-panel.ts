import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { z } from 'zod';

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
  progressNotifierFrom,
  requiredNextActionForRun,
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
  'Dispatch parallel review agents as one panel. Optionally bind to a terminal implementer run to prepend its summary/files as peer_messages; omitted/empty reviewers fill from workflow.agentDefaults.panel, while explicit reviewers always win. Returns panel_id, successful reviewer run_ids, and failed_reviewers. For Claude Code reviewer runs, spawn one crew-wait watcher per run. Do not block the turn long-polling get_run_status.';

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
const PANEL_REVIEWER_SETUP_CONCURRENCY = 2;

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
  const crewWaitCommand = ctx.crewWaitCommand ?? 'crew-wait';

  let panelState = buildStubPanelState(panelId, ctx.runStateStore.repoRoot, implementerState);
  await writeAndNotify(targetPanelDir, panelState, ctx);
  panelState = {
    ...panelState,
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

  await mapBounded(reviewers, PANEL_REVIEWER_SETUP_CONCURRENCY, async (reviewer, index) => {
    const composed = composePeerMessages(implementerMessage, reviewer.peer_messages);
    const reviewerHasExplicitReadOnly = reviewer.read_only !== undefined;
    const effectiveReadOnly = reviewer.read_only ?? (implementerState !== undefined);
    const suppressWorkingDirDefault =
      reviewerHasExplicitReadOnly
      && !effectiveReadOnly
      && implementerState !== undefined;
    const effectiveWorkingDirectory = reviewer.working_directory
      ?? (suppressWorkingDirDefault ? undefined : implementerState?.worktreePath);

    try {
      validatePeerMessagesPreflight(composed, ctx.runStateStore.caps);
    } catch (err) {
      await replaceReviewer(index, failedReviewerRecord(reviewer.agent_id, errorMessage(err), []));
      return;
    }

    if (effectiveWorkingDirectory && !existsSync(effectiveWorkingDirectory)) {
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
    try {
      const result = await dispatchImpl({
        input: {
          agent_id: reviewer.agent_id,
          prompt: reviewer.prompt,
          ...(input.criteria_set_id !== undefined ? { criteria_set_id: input.criteria_set_id } : {}),
          ...(reviewer.model !== undefined ? { model: reviewer.model } : {}),
          ...(reviewer.effort !== undefined ? { effort: reviewer.effort } : {}),
          ...(effectiveWorkingDirectory !== undefined
            ? { working_directory: effectiveWorkingDirectory }
            : {}),
          read_only: effectiveReadOnly,
          ...(composed.length > 0 ? { peer_messages: composed } : {}),
        },
        ctx,
        progress: ctx.progress,
        ...(criteriaContract !== undefined ? { criteriaContract } : {}),
        linkCriteriaImplementerRun: false,
        onStart: async (info) => {
          await replaceReviewer(
            index,
            dispatchedReviewerPlaceholderRecord(reviewer.agent_id, info.runId),
          );
        },
        onTerminalPersisted: async (state) => {
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
      // Each reviewer dispatch is an independent crew run. Claude Code
      // therefore needs one watcher action per reviewer run, not one
      // panel-level watcher, so captains can spawn N watchers for N
      // reviewer run IDs.
      const requiredNextAction = requiredNextActionForRun(
        clientKind,
        crewWaitCommand,
        result.runId,
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

    await replaceReviewer(index, record);
    if (envelope) {
      dispatchEnvelopes[index] = envelope;
    }
  });
  await panelWriteQueue;

  return {
    panel_id: panelId,
    partial: panelState.reviewers.some(isFailedReviewerRecord),
    reviewers: dispatchEnvelopes.filter((envelope): envelope is ReviewerDispatchEnvelope =>
      envelope !== undefined),
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
  const requiredActions = out.reviewers
    .map((reviewer) => reviewer.required_next_action)
    .filter((action): action is RequiredNextAction => action !== undefined);
  if (clientKind === 'claude-code' && requiredActions.length > 0) {
    lines.push(
      '',
      '**REQUIRED before you end this turn:** spawn one watcher per reviewer run.',
      ...requiredActions.map((action) =>
        `- \`Bash(${action.command}, run_in_background: true)\``),
      'Skip any watcher and that crew run is orphaned.',
    );
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

async function mapBounded<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  for (let start = 0; start < items.length; start += concurrency) {
    const batch = items.slice(start, start + concurrency);
    await Promise.all(batch.map((item, offset) => worker(item, start + offset)));
  }
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

  return selected.map((agentId) => ({
    agent_id: agentId,
    prompt: DEFAULT_PANEL_REVIEW_PROMPT,
    read_only: true,
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

function dispatchedReviewerPlaceholderRecord(
  agentId: string,
  runId: string,
): PanelReviewerRecord {
  return {
    runId,
    agentId,
    dispatched: true,
    dispatchedAt: new Date().toISOString(),
    dispatchWarnings: [],
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
