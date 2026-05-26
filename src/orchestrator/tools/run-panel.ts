import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { z } from 'zod';

import {
  DispatchError,
  dispatchRunAgentInternal,
  type DispatchContext,
  type DispatchRunAgentInternalResult,
} from '../dispatch-run-agent-internal.js';
import { validatePeerMessagesPreflight } from '../peer-messages/preflight.js';
import { peerMessageInputSchema, type PeerMessageInput } from '../peer-messages/schema.js';
import type { ProgressNotifier } from '../progress.js';
import type { RunStateV1 } from '../run-state.js';
import {
  PANEL_SCHEMA_VERSION,
  type PanelReviewerRecord,
  type PanelStateV1,
} from '../panels/schema.js';
import { buildImplementerPeerMessage } from '../panels/implementer-message.js';
import { validateRunPanelPreflight } from '../panels/preflight.js';
import { panelDir, writePanelStateAtomic } from '../panels/store.js';
import { loadWorkflowConfig } from '../../workflow/loader.js';
import type { FullConfig } from '../../workflow/types.js';

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
}

export const RUN_PANEL_DESCRIPTION =
  'Dispatch parallel review agents as one panel. Optionally bind to a terminal implementer run to prepend its summary/files as peer_messages; omitted/empty reviewers fill from workflow.agentDefaults.panel, while explicit reviewers always win. Returns panel_id, successful reviewer run_ids, and failed_reviewers.';

const PANEL_IMPLEMENTER_TERMINAL = new Set(['success', 'partial', 'error', 'cancelled']);
const DEFAULT_PANEL_REVIEW_PROMPT =
  'Review the target changes for correctness, regressions, and missing tests. Return concrete findings with file/line references when possible.';

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

  const panelId = randomUUID();
  const targetPanelDir = panelDir(ctx.crewHome, panelId);
  mkdirSync(targetPanelDir, { recursive: true });

  const implementerMessage = implementerState
    ? buildImplementerPeerMessage(implementerState)
    : undefined;

  let panelState = buildStubPanelState(panelId, ctx.runStateStore.repoRoot, implementerState);
  await writeAndNotify(targetPanelDir, panelState, ctx);

  const dispatchEnvelopes: ReviewerDispatchEnvelope[] = [];
  const dispatchImpl = ctx.dispatchRunAgentInternalImpl ?? dispatchRunAgentInternal;

  for (const reviewer of reviewers) {
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
      panelState = await recordReviewer(
        targetPanelDir,
        panelState,
        failedReviewerRecord(reviewer.agent_id, errorMessage(err), []),
        ctx,
      );
      continue;
    }

    if (effectiveWorkingDirectory && !existsSync(effectiveWorkingDirectory)) {
      panelState = await recordReviewer(
        targetPanelDir,
        panelState,
        failedReviewerRecord(
          reviewer.agent_id,
          `working_directory does not exist: ${effectiveWorkingDirectory} (implementer worktree may have been removed)`,
          [],
        ),
        ctx,
      );
      continue;
    }

    let record: PanelReviewerRecord;
    try {
      const result = await dispatchImpl({
        input: {
          agent_id: reviewer.agent_id,
          prompt: reviewer.prompt,
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
      });
      record = dispatchedReviewerRecord(reviewer.agent_id, result);
      dispatchEnvelopes.push({
        run_id: result.runId,
        agent_id: reviewer.agent_id,
        tail_url: result.tailUrl,
        worktree_path: result.worktreePath,
        warnings: result.warnings,
      });
    } catch (err) {
      const warnings = err instanceof DispatchError ? err.warnings : [];
      record = failedReviewerRecord(reviewer.agent_id, errorMessage(err), warnings);
    }

    panelState = await recordReviewer(targetPanelDir, panelState, record, ctx);
  }

  return {
    panel_id: panelId,
    partial: panelState.reviewers.some((reviewer) => !reviewer.dispatched),
    reviewers: dispatchEnvelopes,
    failed_reviewers: panelState.reviewers
      .filter((reviewer): reviewer is Extract<PanelReviewerRecord, { dispatched: false }> =>
        !reviewer.dispatched)
      .map((reviewer) => ({
        agent_id: reviewer.agentId,
        error: reviewer.error,
      })),
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

async function recordReviewer(
  targetPanelDir: string,
  panelState: PanelStateV1,
  record: PanelReviewerRecord,
  ctx: RunPanelHandlerContext,
): Promise<PanelStateV1> {
  const next = {
    ...panelState,
    reviewers: [...panelState.reviewers, record],
  };
  await writeAndNotify(targetPanelDir, next, ctx);
  return next;
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
