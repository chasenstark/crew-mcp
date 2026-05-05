/**
 * get_run_status — poll the current state of a run.
 *
 * Pairs with the async-first dispatch model (`run_agent` always returns
 * `status: "running"` immediately; the captain polls this tool to learn
 * how the run progresses). Supports two modes:
 *
 *   1. Snapshot (no `wait_for_change_ms`): returns the current state +
 *      events delta + cursor immediately. Cheap; always safe.
 *   2. Long-poll (`wait_for_change_ms` set): returns immediately if the
 *      run already has new events past `since_event_line`, OR if the
 *      run is in a terminal state. Otherwise blocks server-side until
 *      one of: (a) a stream/terminal event fires for this run, (b)
 *      `wait_for_change_ms` elapses. The captain runs the loop in a
 *      tight cadence; each return is an opportunity to render new
 *      content to the user with minimal latency.
 *
 * The cursor (`since_event_line` in, `next_event_line` out) keeps each
 * poll surfacing only the *new* events.log lines, so the captain
 * doesn't re-render the same paragraph every turn.
 */

import { z } from 'zod';

export const getRunStatusInputSchema = z.object({
  run_id: z.string().min(1),
  /**
   * Last `next_event_line` the captain received from a prior call.
   * 0 (or omitted) on the first poll. The response's events_tail
   * contains lines with index >= this value; the next call should
   * pass back the response's `next_event_line`.
   */
  since_event_line: z.number().int().nonnegative().optional(),
  /**
   * If set, the server holds the response open for up to this many
   * milliseconds, returning early as soon as new events arrive or the
   * run reaches a terminal state. If unset (or 0), the call returns a
   * synchronous snapshot. Recommended: 30000. Capped at 60000 (server
   * clamps; an overly long wait risks tripping host MCP timeouts).
   */
  wait_for_change_ms: z.number().int().nonnegative().optional(),
  /**
   * Legacy: include the last `log_lines` of events as a tail. Deprecated
   * — prefer cursor semantics via `since_event_line`. Retained for
   * compatibility with snapshot callers; ignored when `since_event_line`
   * is set.
   */
  log_lines: z.number().int().nonnegative().optional(),
});

export type GetRunStatusInput = z.infer<typeof getRunStatusInputSchema>;

export const GET_RUN_STATUS_DESCRIPTION =
  'Poll the current state of a run by run_id. **Always poll** after run_agent / continue_run — those tools return status:"running" immediately and the captain drives the lifecycle from here. Returns status (running | success | partial | error | cancelled | merged | merge_conflict | discarded), prompts history, files_changed, repo_root, worktree_path, events_tail (new lines since `since_event_line`), and `next_event_line` (cursor for the next poll). Pass `wait_for_change_ms: 30000` to long-poll: the call blocks server-side until new events arrive or a terminal state is reached, so the captain renders new content with sub-second latency rather than fixed-cadence snapshots. Capped at 60000ms by the server.';
