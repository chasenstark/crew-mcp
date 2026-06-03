import type { RunStateV1 } from '../run-state.js';
import {
  peerMessageInputSchema,
  type PeerMessageInput,
} from '../peer-messages/schema.js';
import type {
  PanelReviewerRecord,
  PanelReviewerTerminalSnapshot,
  PanelStateV1,
} from './schema.js';
import { safePeerMessageFiles } from './implementer-message.js';
import { sanitizeFromLabel } from './sanitize.js';

export interface UnavailableReviewerState {
  readonly state_unavailable: true;
  readonly reason: string;
}

export type ReviewerStateForAggregation =
  | RunStateV1
  | PanelReviewerTerminalSnapshot
  | UnavailableReviewerState;

export interface AggregatePanelArgs {
  readonly panelState: PanelStateV1;
  readonly reviewerStates: ReadonlyMap<string, ReviewerStateForAggregation>;
}

export function aggregatePanel(args: AggregatePanelArgs): PeerMessageInput[] {
  const dispatched = args.panelState.reviewers.filter(isDispatched);
  const failed = args.panelState.reviewers.filter(isFailed);
  return [
    ...dispatched.map((reviewer) => {
      const state = args.reviewerStates.get(reviewer.runId);
      if (!state || isUnavailableReviewerState(state)) {
        const reason = state?.reason ?? 'missing state';
        return peerMessageInputSchema.parse({
          body: `(reviewer state unavailable: ${reason})`,
          kind: 'review',
          from_label: sanitizeFromLabel(reviewer.agentId, 'state lost'),
        });
      }
      const summary = isPanelReviewerTerminalSnapshot(state)
        ? state.summary?.trim()
        : state.prompts.at(-1)?.summary?.trim();
      const safeFiles = safePeerMessageFiles({
        runId: reviewer.runId,
        filesChanged: isPanelReviewerTerminalSnapshot(state) ? state.filesChanged : state.filesChanged,
        logMessage: 'aggregate_panel files truncated for schema fit',
      });
      const status = state.status;
      const agentId = isPanelReviewerTerminalSnapshot(state) ? reviewer.agentId : state.agentId;
      return peerMessageInputSchema.parse({
        body: summary && summary.length > 0
          ? summary
          : `(no summary; status=${status})`,
        kind: 'review',
        from_label: sanitizeFromLabel(
          agentId,
          status === 'success' ? 'review' : `review, status=${status}`,
        ),
        ...(safeFiles.length > 0 ? { files: safeFiles } : {}),
      });
    }),
    ...failed.map((reviewer) => peerMessageInputSchema.parse({
      body: `(reviewer dispatch failed: ${reviewer.error})`,
      kind: 'review',
      from_label: sanitizeFromLabel(reviewer.agentId, 'dispatch failed'),
    })),
  ];
}

function isPanelReviewerTerminalSnapshot(
  state: ReviewerStateForAggregation,
): state is PanelReviewerTerminalSnapshot {
  return !isUnavailableReviewerState(state) && !('prompts' in state);
}

export function isUnavailableReviewerState(
  state: ReviewerStateForAggregation,
): state is UnavailableReviewerState {
  return 'state_unavailable' in state && state.state_unavailable === true;
}

function isDispatched(
  reviewer: PanelReviewerRecord,
): reviewer is Extract<PanelReviewerRecord, { dispatched: true }> {
  return reviewer.dispatched;
}

function isFailed(
  reviewer: PanelReviewerRecord,
): reviewer is Extract<PanelReviewerRecord, { dispatched: false; error: string }> {
  return !reviewer.dispatched && !('pending' in reviewer && reviewer.pending);
}
