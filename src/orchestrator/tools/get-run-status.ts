/**
 * get_run_status — poll the current state of a run.
 *
 * Pairs with the async-first dispatch model (`run_agent` always returns
 * `status: "running"` immediately). The captain uses this as an
 * on-demand status read at turn start, after a watcher exits, or after
 * an opt-in foreground wait. Supports three modes:
 *
 *   1. Snapshot (no `wait_for_change_ms`): returns the current state +
 *      events delta + cursor immediately. Cheap; always safe.
 *   2. Long-poll (`wait_for_change_ms` set): returns immediately if the
 *      run already has new events past `since_event_line`, OR if the
 *      run is in a terminal state. Otherwise blocks server-side until
 *      one of: (a) a stream/terminal event fires for this run, (b)
 *      `wait_for_change_ms` elapses.
 *   3. Terminal-only long-poll (`wait_for_terminal_only: true`): with
 *      `wait_for_change_ms`, ignores stream chunks and waits only for a
 *      terminal event or timeout. Advanced/legacy option for opt-in
 *      in-turn waiting.
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
 * Defaults to 10: matches the skill body's documented render budget
 * for the terminal tail (captains synthesize, not narrate). Burst
 * runs that need forensic context can opt up via `max_events_tail`;
 * the full `events_log_path` is always available on disk.
 */
export const DEFAULT_MAX_EVENTS_TAIL = 10;

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
   * synchronous snapshot. Advanced/legacy option for opt-in in-turn
   * waiting. Capped at 60000 (server clamps; an overly long wait risks
   * tripping host MCP timeouts).
   */
  wait_for_change_ms: z.number().int().nonnegative().optional(),
  /**
   * When set with `wait_for_change_ms`, wait only for terminal
   * run events (`run:complete`, `run:failed`, `run:cancelled`) and
   * ignore stream chunks. Advanced/legacy option for opt-in in-turn
   * waiting; the default captain dispatch flow ends the turn instead
   * of long-polling.
   */
  wait_for_terminal_only: z.boolean().optional(),
  /**
   * Legacy: include the last `log_lines` of events as a tail. Deprecated
   * — prefer cursor semantics via `since_event_line`. Retained for
   * compatibility with snapshot callers; ignored when `since_event_line`
   * is set.
   */
  log_lines: z.number().int().nonnegative().optional(),
  /**
   * Maximum number of events.log lines to return in `events_tail` on
   * the terminal poll-return. Defaults to {@link DEFAULT_MAX_EVENTS_TAIL}.
   * When the run's full log exceeds this, the server returns the most
   * recent lines plus a skipped-events marker. Bounded above by
   * {@link MAX_EVENTS_TAIL_CAP}. Has no effect on running poll-returns
   * (those always return `events_tail: []`).
   */
  max_events_tail: z.number().int().positive().max(MAX_EVENTS_TAIL_CAP).optional(),
});

export type GetRunStatusInput = z.infer<typeof getRunStatusInputSchema>;

export const GET_RUN_STATUS_DESCRIPTION =
  `Read a run's current status by run_id when recovering pending work, surfacing a terminal result, or answering a user status question. Omit wait_for_change_ms for an immediate snapshot; pass since_event_line to page new events, max_events_tail to cap terminal tail lines (default ${DEFAULT_MAX_EVENTS_TAIL}, max ${MAX_EVENTS_TAIL_CAP}), or wait_for_change_ms / wait_for_terminal_only for advanced in-turn waits. Returns the run status, cursor, paths, terminal summary/filesChanged/prompts/warnings when available, and events_tail on terminal responses; terminal-only wait timeouts return { status: "running", timed_out: true }.`;
