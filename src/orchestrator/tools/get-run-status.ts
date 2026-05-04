/**
 * get_run_status — poll the current state of a run.
 *
 * Required for the async-fallback path: when run_agent returns early
 * with status='running' (dispatch exceeded 60s), the host CLI polls
 * this tool to learn when the dispatch finishes. Also useful for
 * inspecting a previously-merged or discarded run's history.
 *
 * Returns the full RunState plus the last N lines of events.log (for
 * progress visibility while a dispatch is still running).
 */

import { z } from 'zod';

export const getRunStatusInputSchema = z.object({
  run_id: z.string().min(1),
  log_lines: z.number().int().nonnegative().optional(),
});

export type GetRunStatusInput = z.infer<typeof getRunStatusInputSchema>;

export const GET_RUN_STATUS_DESCRIPTION =
  'Poll the current state of a run by run_id. Returns status (running | success | partial | error | cancelled | merged | merge_conflict | discarded), prompts history, files_changed, and the tail of the events log. Use for the async-fallback path: when run_agent returns status:"running", call this to wait for completion.';
