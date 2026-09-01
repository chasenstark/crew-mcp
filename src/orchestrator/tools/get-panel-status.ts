import { z } from 'zod';

import type { TaskFailure } from '../../adapters/types.js';
import {
  latestModelSelection,
  modelSelectionToWire,
  type WireModelSelection,
} from '../../adapters/model-selection.js';
import type { DispatchContext } from '../dispatch-run-agent-internal.js';
import type { RunStateV1 } from '../run-state.js';
import type { PanelReviewerRecord, PanelReviewerTerminalSnapshot } from '../panels/schema.js';
import { panelDir, readPanelState } from '../panels/store.js';
import { resolveCheckInIntervalMs } from '../../utils/config-store.js';
import type {
  ClientKind,
  SpawnWatcherRequiredNextAction,
  ToolCallReturn,
  ToolHandlerDeps,
  ToolRequestExtra,
} from './shared.js';
import {
  errorContent,
  isTerminalRunStatus,
  markdownContent,
  mdInlineCode,
  requiredNextActionForRuns,
} from './shared.js';
import { goalTurnToWire, type WireGoalTurn } from '../goals.js';

export const PANEL_STATUS_SUMMARY_MAX_CHARS = 200;
export const PANEL_STATUS_TRUNCATION_MARKER =
  '… [truncated; full summary in structuredContent]';

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
      readonly model_selection?: WireModelSelection;
      readonly goal?: WireGoalTurn;
    }
  | {
      readonly run_id: string;
      readonly agent_id: string;
      readonly state_unavailable: true;
      readonly state_unavailable_reason: string;
      readonly dispatch_warnings: readonly string[];
      readonly model_selection?: WireModelSelection;
      readonly goal?: WireGoalTurn;
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
    readonly requested_model?: string;
  }>;
  /**
   * Fresh panel watcher for a still-running panel, so a check-in turn can
   * re-arm the next interval. Present only when the handler was given
   * watcher context, at least one reviewer is running, and every dispatched
   * reviewer's live state was readable (generations are part of the wake
   * claim, so a partially-readable panel gets no re-arm action).
   */
  readonly required_next_action?: SpawnWatcherRequiredNextAction;
}

export interface GetPanelStatusHandlerContext extends Pick<DispatchContext, 'crewHome' | 'runStateStore'> {
  readonly clientKind?: ClientKind;
  readonly crewWaitCommand?: string;
  readonly projectRoot?: string;
  readonly checkInIntervalMs?: number;
}

export const GET_PANEL_STATUS_DESCRIPTION =
  'Read a panel by panel_id. Returns dispatched reviewer statuses, failed_reviewers, durable dispatch_warnings, and counts for dispatched reviewers only. Rejects unknown, corrupted, unknown-schema, or cross-repo panels.';

export function getPanelStatusToolHandler(
  args: GetPanelStatusInput,
  deps: Pick<ToolHandlerDeps, 'crewHome' | 'runStateStore'>
    & Partial<Pick<ToolHandlerDeps, 'projectRoot' | 'getClientKind' | 'getCrewWaitCommand'>>,
  extra?: ToolRequestExtra,
): ToolCallReturn {
  try {
    const clientKind = deps.getClientKind?.();
    const crewWaitCommand = deps.getCrewWaitCommand?.(extra);
    const checkInIntervalMs = resolveCheckInIntervalMs(deps.crewHome);
    const out = getPanelStatusHandler(args, {
      crewHome: deps.crewHome,
      runStateStore: deps.runStateStore,
      ...(clientKind !== undefined ? { clientKind } : {}),
      ...(crewWaitCommand !== undefined ? { crewWaitCommand } : {}),
      ...(deps.projectRoot !== undefined ? { projectRoot: deps.projectRoot } : {}),
      ...(checkInIntervalMs !== undefined ? { checkInIntervalMs } : {}),
    });
    return markdownContent(renderPanelStatusMarkdown(out), out);
  } catch (err) {
    return errorContent(err instanceof Error ? err.message : String(err));
  }
}

function renderPanelStatusMarkdown(out: GetPanelStatusOutput): string {
  const lines = [
    `Panel ${mdInlineCode(out.panel_id)}: total=${out.total_count} terminal=${out.terminal_count} running=${out.running_count} failed_reviewers=${out.failed_reviewers.length}.`,
  ];
  for (const reviewer of out.reviewers) {
    if (reviewer.state_unavailable) {
      const model = reviewer.model_selection
        ? ` model=${panelModelLabel(reviewer.model_selection)}`
        : '';
      lines.push(
        `- ${mdInlineCode(reviewer.agent_id)}:${model} status=\`state_unavailable\` files_changed=0 summary=${truncatePanelStatusText(reviewer.state_unavailable_reason)}`,
      );
      continue;
    }
    const filesChanged = reviewer.files_changed?.length ?? 0;
    const summary = reviewer.summary === undefined
      ? ''
      : ` summary=${truncatePanelStatusText(reviewer.summary)}`;
    const model = reviewer.model_selection
      ? ` model=${panelModelLabel(reviewer.model_selection)}`
      : '';
    lines.push(
      `- ${mdInlineCode(reviewer.agent_id)}:${model} status=\`${reviewer.status}\` files_changed=${filesChanged}${summary}`,
    );
  }
  for (const reviewer of out.failed_reviewers) {
    const model = reviewer.requested_model ? ` model=${reviewer.requested_model}` : '';
    lines.push(
      `- ${mdInlineCode(reviewer.agent_id)}:${model} status=\`dispatch_failed\` files_changed=0 summary=${truncatePanelStatusText(reviewer.error)}`,
    );
  }
  if (out.required_next_action !== undefined) {
    lines.push(
      '',
      '**REQUIRED after a check-in wake (the one-shot watcher has exited):** re-arm the panel watcher before ending the turn. Skip only if a live watcher is already armed for this panel.',
      out.required_next_action.mechanism === 'background_shell'
        ? `- \`Bash(${out.required_next_action.command}, run_in_background: true)\``
        : `- Pass \`required_next_action.spawn_recipe_json\` verbatim as the \`tools.exec_command\` argument (its \`require_escalated\` sandbox permission is load-bearing). Command: ${mdInlineCode(out.required_next_action.command)}.`,
    );
  }
  return lines.join('\n');
}

function panelModelLabel(selection: WireModelSelection): string {
  return selection.observed_model
    ?? selection.display_name
    ?? selection.model_argument
    ?? 'CLI default';
}

function truncatePanelStatusText(value: string): string {
  const compacted = value.replace(/\s+/g, ' ').trim();
  const characters = Array.from(compacted);
  if (characters.length <= PANEL_STATUS_SUMMARY_MAX_CHARS) return compacted;
  const maxBodyChars = PANEL_STATUS_SUMMARY_MAX_CHARS
    - Array.from(PANEL_STATUS_TRUNCATION_MARKER).length;
  return `${characters.slice(0, maxBodyChars).join('').trimEnd()}${PANEL_STATUS_TRUNCATION_MARKER}`;
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

  // Collected while mapping so a still-running panel can return a fresh
  // check-in watcher. Generations are part of the durable wake claim, so a
  // reviewer whose live state cannot be read (and has no terminal snapshot)
  // disqualifies the re-arm action rather than risking a stale claim.
  const watchTargets: Array<{ readonly runId: string; readonly generation: number }> = [];
  let watcherEligible = true;
  const recordWatchTarget = (state: RunStateV1): void => {
    if (state.prompts.length >= 1) {
      watchTargets.push({ runId: state.runId, generation: state.prompts.length });
    } else {
      watcherEligible = false;
    }
  };
  const reviewers = panelState.reviewers
    .filter((reviewer): reviewer is Extract<PanelReviewerRecord, { dispatched: true }> =>
      reviewer.dispatched)
    .map((reviewer): PanelReviewerStatus => {
      let state: RunStateV1 | undefined;
      try {
        state = ctx.runStateStore.read(reviewer.runId);
      } catch (err) {
        if (!reviewer.terminalSnapshot) watcherEligible = false;
        return snapshotStatus(reviewer, errorMessage(err));
      }
      if (!state) {
        if (!reviewer.terminalSnapshot) watcherEligible = false;
        return snapshotStatus(reviewer, `missing state for run ${reviewer.runId}`);
      }
      recordWatchTarget(state);
      if (!isTerminalRunStatus(state.status)) {
        const modelSelection = latestModelSelection(state.prompts) ?? reviewer.modelSelection;
        const goal = state.prompts.at(-1)?.goal;
        return {
          run_id: reviewer.runId,
          agent_id: reviewer.agentId,
          state_unavailable: false,
          status: state.status,
          dispatch_warnings: reviewer.dispatchWarnings,
          ...(modelSelection !== undefined
            ? { model_selection: modelSelectionToWire(modelSelection) }
            : {}),
          ...(goal !== undefined ? { goal: goalTurnToWire(goal) } : {}),
        };
      }
      const summary = state.prompts.at(-1)?.summary;
      const modelSelection = latestModelSelection(state.prompts) ?? reviewer.modelSelection;
      const goal = state.prompts.at(-1)?.goal;
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
        ...(modelSelection !== undefined
          ? { model_selection: modelSelectionToWire(modelSelection) }
          : {}),
        ...(goal !== undefined ? { goal: goalTurnToWire(goal) } : {}),
      };
    });

  const runningCount = reviewers.filter((reviewer) =>
    !reviewer.state_unavailable && reviewer.status === 'running').length;
  const requiredNextAction = watcherEligible
    && runningCount > 0
    && watchTargets.length > 0
    && ctx.clientKind !== undefined
    && ctx.projectRoot !== undefined
    ? requiredNextActionForRuns(
        ctx.clientKind,
        ctx.crewWaitCommand,
        watchTargets.map((target) => target.runId),
        ctx.crewHome,
        ctx.projectRoot,
        watchTargets.map((target) => target.generation),
        ctx.checkInIntervalMs,
      )
    : undefined;

  return {
    panel_id: panelState.panelId,
    ...(panelState.implementerRunId !== undefined
      ? { implementer_run_id: panelState.implementerRunId }
      : {}),
    partial: panelState.reviewers.some((reviewer) => !reviewer.dispatched),
    total_count: reviewers.length,
    terminal_count: reviewers.filter((reviewer) =>
      !reviewer.state_unavailable && isTerminalRunStatus(reviewer.status)).length,
    running_count: runningCount,
    reviewers,
    failed_reviewers: panelState.reviewers
      .filter(isFailedReviewerRecord)
      .map((reviewer) => ({
        agent_id: reviewer.agentId,
        error: reviewer.error,
        dispatch_warnings: reviewer.dispatchWarnings,
        ...(reviewer.requestedModel !== undefined
          ? { requested_model: reviewer.requestedModel }
          : {}),
      })),
    ...(requiredNextAction !== undefined
      ? { required_next_action: requiredNextAction }
      : {}),
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
    ...(reviewer.modelSelection !== undefined
      ? { model_selection: modelSelectionToWire(reviewer.modelSelection) }
      : {}),
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
    ...(snapshot.modelSelection ?? reviewer.modelSelection
      ? {
          model_selection: modelSelectionToWire(
            (snapshot.modelSelection ?? reviewer.modelSelection)!,
          ),
        }
      : {}),
    ...(snapshot.goal !== undefined ? { goal: goalTurnToWire(snapshot.goal) } : {}),
  };
}

function isFailedReviewerRecord(
  reviewer: PanelReviewerRecord,
): reviewer is Extract<PanelReviewerRecord, { dispatched: false; error: string }> {
  return !reviewer.dispatched && !('pending' in reviewer && reviewer.pending);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
