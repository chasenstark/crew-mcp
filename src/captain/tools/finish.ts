/**
 * finish — terminate the session loop with a final report.
 *
 * Appends the summary as an assistant message so the report is part of the
 * durable session log, then calls SessionLoop.requestExit(finalReport) which
 * flips the loop's `done` flag. The captain's turn completes normally; the
 * loop's outer while observes `done === true` and exits.
 *
 * No timestamp/ordering concerns: the summary lands in the message log
 * before the tool_result (which itself is written by the scheduler after
 * this handler returns). This matches the M3-13 end-to-end-trivial test
 * expectation "session persists a minimal message log ending in an
 * assistant-authored report."
 */

import { z } from 'zod';
import type { ActionCatalogEntry } from '../action-server.js';
import type { CaptainSession } from '../session.js';
import type { SessionLoop } from '../session-loop.js';

export const finishInputSchema = z.object({
  summary: z.string().min(1),
  outcome: z.enum(['success', 'partial', 'failed']).optional(),
});

export type FinishInput = z.infer<typeof finishInputSchema>;

export const FINISH_DESCRIPTION =
  'Emit the final report and terminate the session. Call when the user request is addressed.';

export interface FinishResult {
  readonly status: 'finished';
  readonly outcome: FinishInput['outcome'];
}

export function buildFinishActionEntry(): ActionCatalogEntry {
  return {
    name: 'finish',
    description: FINISH_DESCRIPTION,
    inputSchema: finishInputSchema,
  };
}

export function dispatchFinish(
  session: CaptainSession,
  loop: SessionLoop,
  input: FinishInput,
): FinishResult {
  session.appendAssistantMessage(input.summary);
  loop.requestExit(input.summary);
  return { status: 'finished', outcome: input.outcome };
}
