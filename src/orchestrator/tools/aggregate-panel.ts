import { z } from 'zod';

import type { DispatchContext } from '../dispatch-run-agent-internal.js';
import type { RunStateV1 } from '../run-state.js';
import type { PeerMessageInput } from '../peer-messages/schema.js';
import { aggregatePanel, type ReviewerStateForAggregation } from '../panels/aggregate.js';
import type { PanelReviewerRecord } from '../panels/schema.js';
import { panelDir, readPanelState } from '../panels/store.js';
import type { ToolCallReturn, ToolHandlerDeps } from './shared.js';
import { errorContent, jsonContent } from './shared.js';

export const aggregatePanelInputSchema = z.object({
  panel_id: z.string().min(1),
}).strict();

export type AggregatePanelInput = z.infer<typeof aggregatePanelInputSchema>;

export interface AggregatePanelOutput {
  readonly panel_id: string;
  readonly peer_messages: PeerMessageInput[];
}

export interface AggregatePanelHandlerContext extends Pick<DispatchContext, 'crewHome' | 'runStateStore'> {}

export const AGGREGATE_PANEL_DESCRIPTION =
  'Build peer_messages from a completed review panel so they can be passed to continue_run. Rejects if any dispatched reviewer is still running; includes terminal, failed-dispatch, and state-unavailable reviewers.';

export function aggregatePanelToolHandler(
  args: AggregatePanelInput,
  deps: Pick<ToolHandlerDeps, 'crewHome' | 'runStateStore'>,
): ToolCallReturn {
  try {
    const out = aggregatePanelHandler(args, {
      crewHome: deps.crewHome,
      runStateStore: deps.runStateStore,
    });
    return jsonContent(out);
  } catch (err) {
    return errorContent(err instanceof Error ? err.message : String(err));
  }
}

export function aggregatePanelHandler(
  args: unknown,
  ctx: AggregatePanelHandlerContext,
): AggregatePanelOutput {
  const input = aggregatePanelInputSchema.parse(args);
  const panelState = readPanelState(panelDir(ctx.crewHome, input.panel_id));
  if (!panelState) {
    throw new Error(`run_panel.unknown: ${input.panel_id}`);
  }
  if (panelState.panelRepoRoot !== ctx.runStateStore.repoRoot) {
    throw new Error(`run_panel.cross_repo: panel was created in repo ${panelState.panelRepoRoot}`);
  }

  const dispatched = panelState.reviewers
    .filter((reviewer): reviewer is Extract<PanelReviewerRecord, { dispatched: true }> =>
      reviewer.dispatched);
  const reviewerStates = new Map<string, ReviewerStateForAggregation>();
  let runningCount = 0;

  for (const reviewer of dispatched) {
    let state: RunStateV1 | undefined;
    try {
      state = ctx.runStateStore.read(reviewer.runId);
    } catch (err) {
      if (reviewer.terminalSnapshot) {
        reviewerStates.set(reviewer.runId, reviewer.terminalSnapshot);
        continue;
      }
      reviewerStates.set(reviewer.runId, {
        state_unavailable: true,
        reason: errorMessage(err),
      });
      continue;
    }
    if (!state) {
      if (reviewer.terminalSnapshot) {
        reviewerStates.set(reviewer.runId, reviewer.terminalSnapshot);
        continue;
      }
      reviewerStates.set(reviewer.runId, {
        state_unavailable: true,
        reason: `missing state for run ${reviewer.runId}`,
      });
      continue;
    }
    if (state.status === 'running') {
      runningCount += 1;
    }
    reviewerStates.set(reviewer.runId, state);
  }

  if (runningCount > 0) {
    throw new Error(
      `run_panel.aggregate_not_ready: ${runningCount} of ${dispatched.length} reviewers still running`,
    );
  }

  return {
    panel_id: panelState.panelId,
    peer_messages: aggregatePanel({ panelState, reviewerStates }),
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
