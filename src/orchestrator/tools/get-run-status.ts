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

/**
 * Default per-poll cap on `events_tail` lines. Caller can request a
 * different cap via `max_events_tail` up to {@link MAX_EVENTS_TAIL_CAP}.
 *
 * Sized to comfortably fit a captain's render budget (skill body caps
 * the rendered tail at ~10 lines) while still leaving headroom when
 * adapters emit a burst of events between polls.
 */
export const DEFAULT_MAX_EVENTS_TAIL = 50;

/**
 * Hard upper bound on `max_events_tail`. Protects the MCP wire payload
 * from pathological bursts (e.g. an adapter going chatty mid-run); a
 * caller asking for more is a misuse rather than a UX need — they
 * should read the file at `events_log_path` directly.
 */
export const MAX_EVENTS_TAIL_CAP = 500;

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
  /**
   * Maximum number of new events.log lines to return in this poll.
   * Defaults server-side to {@link DEFAULT_MAX_EVENTS_TAIL}. When more
   * lines are available, the server returns the most recent lines plus
   * a skipped-events marker and advances `next_event_line` to the log
   * head. Bounded above by {@link MAX_EVENTS_TAIL_CAP}.
   */
  max_events_tail: z.number().int().positive().max(MAX_EVENTS_TAIL_CAP).optional(),
});

export type GetRunStatusInput = z.infer<typeof getRunStatusInputSchema>;

export const GET_RUN_STATUS_DESCRIPTION =
  `Poll the current state of a run by run_id. **Always poll** after run_agent / continue_run — those tools return status:"running" immediately and the captain drives the lifecycle from here. Returns status (running | success | partial | error | cancelled | merged | merge_conflict | discarded), prompts history, files_changed, repo_root, worktree_path, events_log_path, events_tail (new lines since \`since_event_line\`), and \`next_event_line\` (cursor for the next poll). Pass \`wait_for_change_ms: 30000\` to long-poll: the call blocks server-side until new events arrive or a terminal state is reached, so the captain renders new content with sub-second latency rather than fixed-cadence snapshots. \`events_tail\` is capped to ${DEFAULT_MAX_EVENTS_TAIL} lines per poll by default; pass \`max_events_tail\` to request a different cap (maximum ${MAX_EVENTS_TAIL_CAP}). When the cap is exceeded, the response skips older backlog, includes a skipped-events marker (\`events_tail_skipped\`), and advances the cursor to the current log head. Long-poll waits are capped at 60000ms by the server.`;
