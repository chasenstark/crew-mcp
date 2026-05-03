/**
 * finish — terminate the session loop with a final report.
 *
 * If no dispatched work is still in flight, appends the summary as an
 * assistant message so the report is part of the durable session log, then
 * calls SessionLoop.requestExit(finalReport) which flips the loop's `done`
 * flag. The captain's turn completes normally; the loop's outer while
 * observes `done === true` and exits.
 *
 * If dispatched work is still in flight, finish is blocked and no summary is
 * appended. The captain must wait for the tool result before finalizing.
 *
 * No timestamp/ordering concerns: the summary lands in the message log
 * before the tool_result (which itself is written by the scheduler after
 * this handler returns). This matches the M3-13 end-to-end-trivial test
 * expectation "session persists a minimal message log ending in an
 * assistant-authored report."
 */

import { z } from 'zod';
import type { CaptainSession } from '../session.js';
import type { SessionLoop } from '../session-loop.js';

// NB: the canonical ActionCatalogEntry for each M3 tool is built by
// src/captain/tools/catalog.ts. Per-tool files only export the schema +
// description + dispatch helper so catalog.ts has a single source.

export const finishInputSchema = z.object({
  summary: z.string().min(1),
  outcome: z.enum(['success', 'partial', 'failed']).optional(),
});

export type FinishInput = z.infer<typeof finishInputSchema>;

export const FINISH_DESCRIPTION =
  'Emit the final report and terminate the session. Call this when the user\'s request is addressed and (for planned work) you\'ve verified the result. Don\'t finish while alignment is still open or a dispatched agent\'s output is unverified. Don\'t wait for an unsolicited review.';

export interface FinishResult {
  readonly status: 'finished' | 'blocked';
  readonly outcome: FinishInput['outcome'];
  readonly reason?: string;
  readonly pendingDispatches?: readonly {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly runId?: string;
  }[];
}

export function dispatchFinish(
  session: CaptainSession,
  loop: SessionLoop,
  input: FinishInput,
): FinishResult {
  const pendingDispatches = loop.listPendingDispatches();
  if (pendingDispatches.length > 0) {
    return {
      status: 'blocked',
      outcome: input.outcome,
      reason: `Cannot finish while ${pendingDispatches.length} dispatched tool call${pendingDispatches.length === 1 ? '' : 's'} are still in flight.`,
      pendingDispatches,
    };
  }
  session.appendAssistantMessage(input.summary);
  loop.requestExit(input.summary);
  return { status: 'finished', outcome: input.outcome };
}
