/**
 * get_run_status — poll the current state of a run.
 *
 * Pairs with the async-first dispatch model (`run_agent` always returns
 * `status: "running"` immediately). The captain's chat-available default
 * is the snapshot mode — used at turn start, after a watcher exits, or
 * to answer a user status question. The wait modes block the captain's
 * turn open and are reserved for explicit "wait for this" opt-ins (see
 * GET_RUN_STATUS_DESCRIPTION and the skill body's Dispatch lifecycle
 * section). Supports three modes:
 *
 *   1. Snapshot (no `wait_for_change_ms`): returns the current state +
 *      events delta + cursor immediately. Cheap; always safe; the
 *      captain default.
 *   2. Long-poll (`wait_for_change_ms` set): returns immediately if the
 *      run already has new events past `since_event_line`, OR if the
 *      run is in a terminal state. Otherwise blocks server-side until
 *      one of: (a) a stream/terminal event fires for this run, (b)
 *      `wait_for_change_ms` elapses. Captains should not use this to
 *      surface a terminal result inside the dispatch turn — the
 *      crew-wait watcher (Claude Code/Codex) or a next-turn snapshot is the
 *      non-blocking path.
 *   3. Terminal-only long-poll (`wait_for_terminal_only: true`): with
 *      `wait_for_change_ms`, ignores stream chunks and waits only for a
 *      terminal event or timeout. Same opt-in-only caveat as mode (2).
 *
 * The cursor (`since_event_line` in, `next_event_line` out) keeps each
 * poll surfacing only the *new* events.log lines, so the captain
 * doesn't re-render the same paragraph every turn.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { z } from 'zod';

import { filterEventsTailNoise } from '../events-filter.js';
import { formatProgressLines } from '../progress.js';
import { runModeFromState } from '../run-mode.js';
import { isTerminalPersistPending } from '../run-lifecycle-listeners.js';
import type { RunStateStore, RunStateV1 } from '../run-state.js';
import type { ToolDispatcher } from '../tool-dispatcher.js';
import type { ToolCallReturn, ToolHandlerDeps } from './shared.js';
import {
  errorContent,
  getRunStatusContent,
  isTerminalRunStatus,
  MAX_LONG_POLL_MS,
} from './shared.js';

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
   * synchronous snapshot. Opt-in only — the captain should not use
   * this to surface a terminal result inside the dispatch turn (that
   * blocks chat); reserve it for cases where the user explicitly said
   * "wait for this." Capped at 60000 (server clamps; an overly long
   * wait risks tripping host MCP timeouts).
   */
  wait_for_change_ms: z.number().int().nonnegative().optional(),
  /**
   * When set with `wait_for_change_ms`, wait only for terminal
   * run events (`run:complete`, `run:failed`, `run:cancelled`) and
   * ignore stream chunks. Same opt-in-only caveat as
   * `wait_for_change_ms`: the chat-available default is the crew-wait
   * watcher (Claude Code/Codex) or a next-turn snapshot, not a blocking
   * long-poll inside the dispatch turn.
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
  `Read a run's current status by run_id. Default: omit wait params for an immediate snapshot (turn-start, post-watcher, status question). wait_for_change_ms / wait_for_terminal_only block until events arrive or terminal; opt-in only when the user explicitly asks to wait. Captain default is the crew-wait watcher (Claude Code/Codex) or next-turn snapshot, not a long-poll. Pass since_event_line to page events; max_events_tail caps terminal tail (default ${DEFAULT_MAX_EVENTS_TAIL}, max ${MAX_EVENTS_TAIL_CAP}). Terminal returns status, cursor, paths, summary/filesChanged/prompts/warnings, commits/commit_count, events_tail; timeouts return { status: "running", timed_out: true }.`;

export async function getRunStatusToolHandler(
  args: GetRunStatusInput,
  deps: Pick<ToolHandlerDeps, 'dispatcher' | 'runStateStore'>,
): Promise<ToolCallReturn> {
  const state = deps.runStateStore.read(args.run_id);
  if (!state) {
    return errorContent(`Unknown run_id "${args.run_id}".`);
  }

  const cursor = args.since_event_line ?? 0;
  const useLongPoll = (args.wait_for_change_ms ?? 0) > 0
    && !isTerminalRunStatus(state.status);

  if (!useLongPoll) {
    return buildGetRunStatusResponse(
      state,
      deps.runStateStore,
      args.run_id,
      cursor,
      args.log_lines,
      args.max_events_tail,
    );
  }

  const terminalOnly = args.wait_for_terminal_only === true;

  if (!terminalOnly) {
    const head = deps.runStateStore.readSignalEventsSince(args.run_id, cursor);
    if (head.lines.length > 0) {
      return buildGetRunStatusResponse(
        state,
        deps.runStateStore,
        args.run_id,
        cursor,
        args.log_lines,
        args.max_events_tail,
      );
    }
  }

  const waitMs = Math.min(args.wait_for_change_ms ?? 0, MAX_LONG_POLL_MS);
  const timedOut = await waitForRunChange({
    dispatcher: deps.dispatcher,
    runStateStore: deps.runStateStore,
    agentName: state.agentId,
    runId: args.run_id,
    cursor,
    waitMs,
    terminalOnly,
  });

  const fresh = deps.runStateStore.read(args.run_id) ?? state;
  if (terminalOnly && timedOut && !isTerminalRunStatus(fresh.status)) {
    return getRunStatusContent(args.run_id, { status: 'running', timed_out: true });
  }
  return buildGetRunStatusResponse(
    fresh,
    deps.runStateStore,
    args.run_id,
    cursor,
    args.log_lines,
    args.max_events_tail,
  );
}

interface GetRunStatusResponse {
  readonly status: string;
  readonly events_tail: readonly string[];
  readonly next_event_line: number;
  readonly timed_out?: true;
  readonly failure?: RunStateV1['failure'];
  readonly [key: string]: unknown;
  readonly events_tail_skipped?: number;
  readonly log_tail?: readonly string[];
}

interface CommitSummary {
  readonly sha: string;
  readonly subject: string;
}

interface CommitSummaryCacheEntry {
  readonly completedAt: string | undefined;
  readonly hostHead: string;
  readonly summary: { readonly commits: readonly CommitSummary[]; readonly commit_count: number };
}

const terminalCommitSummaryCache = new Map<string, CommitSummaryCacheEntry>();

type TerminalPromptRecord = {
  readonly turn: number;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly peer_messages_count: number;
};

function buildGetRunStatusResponse(
  state: RunStateV1,
  store: RunStateStore,
  runId: string,
  sinceLine: number,
  logLines: number | undefined,
  maxEventsTail: number | undefined,
): ToolCallReturn {
  const status = state.status;
  const terminal = isTerminalRunStatus(status);
  let cursorAfterDelta: number;

  let cappedLines: readonly string[] = [];
  let skipped = 0;
  if (terminal && status !== 'discarded') {
    const maxTail = maxEventsTail ?? DEFAULT_MAX_EVENTS_TAIL;
    const tail = store.readFilteredTailFromEnd(runId, maxTail);
    cursorAfterDelta = tail.totalLineCount;
    const overCap = tail.totalFilteredCount > maxTail;
    const eventLineBudget = overCap ? Math.max(0, maxTail - 1) : maxTail;
    skipped = overCap ? tail.totalFilteredCount - eventLineBudget : 0;
    const tailLines = eventLineBudget > 0 ? tail.lines.slice(-eventLineBudget) : [];
    cappedLines = overCap
      ? [`(${skipped} more events skipped)`, ...tailLines]
      : tail.lines;
  } else {
    // Running responses always ship an empty events_tail — only the
    // cursor is needed, and getEventLineCount computes it from the
    // store's own incremental cursor instead of re-reading the log
    // from the caller's (usually 0) since_event_line.
    cursorAfterDelta = store.getEventLineCount(runId);
  }

  const legacyLogTail = sinceLine === 0 && logLines !== undefined
    ? { log_tail: store.tailEvents(runId, logLines) }
    : {};

  if (!terminal) {
    const payload: GetRunStatusResponse = {
      status,
      events_tail: cappedLines,
      next_event_line: cursorAfterDelta,
      ...(state.workerReady !== undefined ? { worker_ready: state.workerReady } : {}),
      ...legacyLogTail,
    };
    return getRunStatusContent(runId, payload);
  }

  const projectedPrompts: readonly TerminalPromptRecord[] = state.prompts.map((p) => ({
    turn: p.turn,
    startedAt: p.startedAt,
    ...(p.completedAt !== undefined ? { completedAt: p.completedAt } : {}),
    peer_messages_count: p.peer_messages_input?.length ?? 0,
  }));
  const lastSummary = state.prompts.length > 0
    ? state.prompts[state.prompts.length - 1]?.summary
    : undefined;
  const commitSummary = collectRunCommits(state, store.repoRoot);

  const payload: GetRunStatusResponse = {
    status,
    events_tail: cappedLines,
    next_event_line: cursorAfterDelta,
    filesChanged: state.filesChanged,
    prompts: projectedPrompts,
    commits: commitSummary.commits,
    commit_count: commitSummary.commit_count,
    ...(lastSummary !== undefined ? { summary: lastSummary } : {}),
    ...(state.lastError !== undefined ? { lastError: state.lastError } : {}),
    ...(state.failure !== undefined ? { failure: state.failure } : {}),
    ...(state.mergeStatus !== undefined ? { mergeStatus: state.mergeStatus } : {}),
    ...(state.warnings !== undefined ? { warnings: state.warnings } : {}),
    ...(state.workerReady !== undefined ? { worker_ready: state.workerReady } : {}),
    // run_mode only when it isn't the default lifecycle; readOnly kept for
    // legacy consumers (it is the persisted !isMergeable shim, so it also
    // reads true for ephemeral_review — run_mode is the discriminator).
    ...(runModeFromState(state) !== 'write' ? { run_mode: runModeFromState(state) } : {}),
    ...(state.readOnly ? { readOnly: state.readOnly } : {}),
    ...(skipped > 0 ? { events_tail_skipped: skipped } : {}),
    ...legacyLogTail,
  };
  return getRunStatusContent(runId, payload);
}

function collectRunCommits(
  state: RunStateV1,
  fallbackRepoRoot: string,
): { readonly commits: readonly CommitSummary[]; readonly commit_count: number } {
  if (
    state.status === 'discarded'
    || state.status === 'merged'
    || !existsSync(state.worktreePath)
  ) {
    return { commits: [], commit_count: 0 };
  }

  try {
    const targetRoot = state.repoRoot ?? fallbackRepoRoot;
    const targetHead = gitOutput(targetRoot, ['rev-parse', 'HEAD']);
    const cached = terminalCommitSummaryCache.get(state.runId);
    if (
      cached !== undefined
      && cached.completedAt === state.completedAt
      && cached.hostHead === targetHead
    ) {
      return cached.summary;
    }
    const range = `${targetHead}..HEAD`;
    const count = Number.parseInt(gitOutput(state.worktreePath, ['rev-list', '--count', range]), 10);
    if (!Number.isFinite(count) || count <= 0) {
      const summary = { commits: [], commit_count: 0 };
      terminalCommitSummaryCache.set(state.runId, {
        completedAt: state.completedAt,
        hostHead: targetHead,
        summary,
      });
      return summary;
    }
    const raw = gitOutput(state.worktreePath, [
      'log',
      '--format=%H%x00%s',
      '-n',
      '20',
      range,
    ]);
    const commits = raw.split('\n')
      .map((line): CommitSummary | undefined => {
        const separator = line.indexOf('\0');
        if (separator <= 0) return undefined;
        return {
          sha: line.slice(0, separator),
          subject: line.slice(separator + 1),
        };
      })
      .filter((commit): commit is CommitSummary => commit !== undefined);
    const summary = { commits, commit_count: count };
    terminalCommitSummaryCache.set(state.runId, {
      completedAt: state.completedAt,
      hostHead: targetHead,
      summary,
    });
    return summary;
  } catch {
    return { commits: [], commit_count: 0 };
  }
}

function gitOutput(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

async function waitForRunChange(args: {
  dispatcher: ToolDispatcher;
  runStateStore: RunStateStore;
  agentName: string;
  runId: string;
  cursor: number;
  waitMs: number;
  terminalOnly: boolean;
}): Promise<boolean> {
  const subs: Array<{ dispose(): void }> = [];
  return new Promise<boolean>((resolve) => {
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (timedOut: boolean): void => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      for (const s of subs) s.dispose();
      resolve(timedOut);
    };
    const matches = (info: { runId?: string }): boolean => info.runId === args.runId;
    if (!args.terminalOnly) {
      subs.push(args.dispatcher.onEvent('run:stream', (info) => {
        if (!matches(info)) return;
        const signalLines = info.formattedSignalLines
          ?? filterEventsTailNoise(formatProgressLines(args.agentName, info.chunk));
        if (signalLines.length === 0) return;
        finish(false);
      }));
    }
    subs.push(
      args.dispatcher.onEvent('run:complete', (info) => {
        if (matches(info)) finish(false);
      }),
      args.dispatcher.onEvent('run:failed', (info) => {
        if (matches(info)) finish(false);
      }),
      args.dispatcher.onEvent('run:cancelled', (info) => {
        if (matches(info)) finish(false);
      }),
    );
    const fresh = args.runStateStore.read(args.runId);
    if (
      (fresh && isTerminalRunStatus(fresh.status))
      || isTerminalPersistPending(args.runId)
    ) {
      finish(false);
      return;
    }
    if (!args.terminalOnly) {
      const head = args.runStateStore.readSignalEventsSince(args.runId, args.cursor);
      if (head.lines.length > 0) {
        finish(false);
        return;
      }
    }
    timer = setTimeout(() => finish(true), args.waitMs);
    timer.unref?.();
  });
}
