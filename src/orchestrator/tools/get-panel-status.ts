import { z } from 'zod';

import type { TaskFailure } from '../../adapters/types.js';
import type { DispatchContext } from '../dispatch-run-agent-internal.js';
import type { RunStateV1 } from '../run-state.js';
import type { PanelReviewerRecord, PanelReviewerTerminalSnapshot } from '../panels/schema.js';
import { panelDir, readPanelState } from '../panels/store.js';
import type { ToolCallReturn, ToolHandlerDeps } from './shared.js';
import { errorContent, jsonContent } from './shared.js';

export const getPanelStatusInputSchema = z.object({
  panel_id: z.string().min(1),
}).strict();

export type GetPanelStatusInput = z.infer<typeof getPanelStatusInputSchema>;

export type PanelReviewerStatus =
  | {
      readonly run_id: string;
      readonly agent_id: string;
      readonly state_unavailable: false;
      readonly status: RunStateV1['status'];
      readonly summary?: string;
      readonly files_changed?: readonly string[];
      readonly completedAt?: string;
      readonly failure?: TaskFailure;
      readonly dispatch_warnings: readonly string[];
    }
  | {
      readonly run_id: string;
      readonly agent_id: string;
      readonly state_unavailable: true;
      readonly state_unavailable_reason: string;
      readonly dispatch_warnings: readonly string[];
    };

export interface GetPanelStatusOutput {
  readonly panel_id: string;
  readonly implementer_run_id?: string;
  readonly partial: boolean;
  readonly total_count: number;
  readonly terminal_count: number;
  readonly running_count: number;
  readonly reviewers: readonly PanelReviewerStatus[];
  readonly failed_reviewers: ReadonlyArray<{
    readonly agent_id: string;
    readonly error: string;
    readonly dispatch_warnings: readonly string[];
  }>;
}

export interface GetPanelStatusHandlerContext extends Pick<DispatchContext, 'crewHome' | 'runStateStore'> {}

export const GET_PANEL_STATUS_DESCRIPTION =
  'Read a panel by panel_id. Returns dispatched reviewer statuses, failed_reviewers, durable dispatch_warnings, and counts for dispatched reviewers only. Rejects unknown, corrupted, unknown-schema, or cross-repo panels.';

export function getPanelStatusToolHandler(
  args: GetPanelStatusInput,
  deps: Pick<ToolHandlerDeps, 'crewHome' | 'runStateStore'>,
): ToolCallReturn {
  try {
    const out = getPanelStatusHandler(args, {
      crewHome: deps.crewHome,
      runStateStore: deps.runStateStore,
    });
    return jsonContent(out);
  } catch (err) {
    return errorContent(err instanceof Error ? err.message : String(err));
  }
}

export function getPanelStatusHandler(
  args: unknown,
  ctx: GetPanelStatusHandlerContext,
): GetPanelStatusOutput {
  const input = getPanelStatusInputSchema.parse(args);
  const panelState = readPanelState(panelDir(ctx.crewHome, input.panel_id));
  if (!panelState) {
    throw new Error(`run_panel.unknown: ${input.panel_id}`);
  }
  if (panelState.panelRepoRoot !== ctx.runStateStore.repoRoot) {
    throw new Error(`run_panel.cross_repo: panel was created in repo ${panelState.panelRepoRoot}`);
  }

  const reviewers = panelState.reviewers
    .filter((reviewer): reviewer is Extract<PanelReviewerRecord, { dispatched: true }> =>
      reviewer.dispatched)
    .map((reviewer): PanelReviewerStatus => {
      let state: RunStateV1 | undefined;
      try {
        state = ctx.runStateStore.read(reviewer.runId);
      } catch (err) {
        return snapshotStatus(reviewer, errorMessage(err));
      }
      if (!state) {
        return snapshotStatus(reviewer, `missing state for run ${reviewer.runId}`);
      }
      if (!isTerminalRunStatus(state.status)) {
        return {
          run_id: reviewer.runId,
          agent_id: reviewer.agentId,
          state_unavailable: false,
          status: state.status,
          dispatch_warnings: reviewer.dispatchWarnings,
        };
      }
      const summary = state.prompts.at(-1)?.summary;
      return {
        run_id: reviewer.runId,
        agent_id: reviewer.agentId,
        state_unavailable: false,
        status: state.status,
        ...(summary !== undefined ? { summary } : {}),
        files_changed: state.filesChanged,
        ...(state.completedAt !== undefined ? { completedAt: state.completedAt } : {}),
        ...(state.failure !== undefined ? { failure: state.failure } : {}),
        dispatch_warnings: reviewer.dispatchWarnings,
      };
    });

  return {
    panel_id: panelState.panelId,
    ...(panelState.implementerRunId !== undefined
      ? { implementer_run_id: panelState.implementerRunId }
      : {}),
    partial: panelState.reviewers.some((reviewer) => !reviewer.dispatched),
    total_count: reviewers.length,
    terminal_count: reviewers.filter((reviewer) =>
      !reviewer.state_unavailable && isTerminalRunStatus(reviewer.status)).length,
    running_count: reviewers.filter((reviewer) =>
      !reviewer.state_unavailable && reviewer.status === 'running').length,
    reviewers,
    failed_reviewers: panelState.reviewers
      .filter(isFailedReviewerRecord)
      .map((reviewer) => ({
        agent_id: reviewer.agentId,
        error: reviewer.error,
        dispatch_warnings: reviewer.dispatchWarnings,
      })),
  };
}

function unavailableStatus(
  reviewer: Extract<PanelReviewerRecord, { dispatched: true }>,
  reason: string,
): PanelReviewerStatus {
  return {
    run_id: reviewer.runId,
    agent_id: reviewer.agentId,
    state_unavailable: true,
    state_unavailable_reason: reason,
    dispatch_warnings: reviewer.dispatchWarnings,
  };
}

function snapshotStatus(
  reviewer: Extract<PanelReviewerRecord, { dispatched: true }>,
  reason: string,
): PanelReviewerStatus {
  if (reviewer.terminalSnapshot) {
    return statusFromSnapshot(reviewer, reviewer.terminalSnapshot);
  }
  return unavailableStatus(reviewer, reason);
}

function statusFromSnapshot(
  reviewer: Extract<PanelReviewerRecord, { dispatched: true }>,
  snapshot: PanelReviewerTerminalSnapshot,
): PanelReviewerStatus {
  return {
    run_id: reviewer.runId,
    agent_id: reviewer.agentId,
    state_unavailable: false,
    status: snapshot.status,
    ...(snapshot.summary !== undefined ? { summary: snapshot.summary } : {}),
    files_changed: snapshot.filesChanged,
    ...(snapshot.completedAt !== undefined ? { completedAt: snapshot.completedAt } : {}),
    ...(snapshot.failure !== undefined ? { failure: snapshot.failure } : {}),
    dispatch_warnings: reviewer.dispatchWarnings,
  };
}

export function isTerminalRunStatus(status: RunStateV1['status']): boolean {
  return (
    status === 'success'
    || status === 'partial'
    || status === 'error'
    || status === 'cancelled'
    || status === 'merged'
    || status === 'merge_conflict'
    || status === 'discarded'
  );
}

function isFailedReviewerRecord(
  reviewer: PanelReviewerRecord,
): reviewer is Extract<PanelReviewerRecord, { dispatched: false; error: string }> {
  return !reviewer.dispatched && !('pending' in reviewer && reviewer.pending);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
