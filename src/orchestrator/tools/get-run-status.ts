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
  `Poll a run by run_id. Always poll after run_agent / continue_run — those return status:"running" immediately. **Always pass wait_for_change_ms: 30000** plus since_event_line (the prior response's next_event_line). The server blocks until new signal events arrive or the run reaches terminal state (and returns immediately if already terminal), so each poll wakes the captain on real progress. Pure adapter receipts (e.g. codex "command: started ..." / "(exit 0)" / item.* lifecycle frames) do NOT wake the long-poll — they advance next_event_line on disk but the captain stays asleep until signal arrives. Snapshot polls (no wait_for_change_ms) return instantly and create tight polling loops — avoid. While running, response is lean — status + cursor only. On terminal, response adds summary (last turn's output), filesChanged, prompts, and events_tail (default ${DEFAULT_MAX_EVENTS_TAIL}; configurable via max_events_tail up to ${MAX_EVENTS_TAIL_CAP}).`;
