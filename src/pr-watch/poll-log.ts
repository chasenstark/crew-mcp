import { closeSync, existsSync, openSync, readSync, renameSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import { logBestEffortFailure } from '../utils/best-effort.js';
import type { PrWatchFullRefreshReason, PrWatchPollMode } from './observation-cache.js';
import type { PrWatchBlockerKind, PrWatchStatus } from './types.js';

/**
 * Per-poll diagnostic log, one JSON line per `pollOnce`, kept beside the
 * watch's ledger. It exists so delta polling can be watched on a large stack
 * over hours: which polls were probe-only, which PRs went dirty, what each
 * poll cost, how long GitHub took, and what the poll decided. Diagnostic
 * only: a failed append never changes monitor behavior.
 */
export const PR_WATCH_POLL_LOG_FILE = 'polls.jsonl';
export const PR_WATCH_POLL_LOG_ROTATED_FILE = 'polls.jsonl.1';
export const PR_WATCH_POLL_LOG_MAX_BYTES = 8 * 1024 * 1024;
export const PR_WATCH_POLL_LOG_DIRTY_LIST_CAP = 20;
export const PR_WATCH_POLL_LOG_REASON_CAP = 10;

export interface PrWatchPollLogRecordV1 {
  readonly v: 1;
  readonly ts: string;
  readonly watchId: string;
  readonly generation: number;
  readonly prCount: number;
  /** Absent when the poll failed before an observation completed. */
  readonly mode?: PrWatchPollMode;
  readonly fullRefreshReason?: PrWatchFullRefreshReason;
  /** True when a terminal candidate forced a second, full read in this poll. */
  readonly forcedRefresh: boolean;
  readonly apiCalls: number;
  readonly queryCost: number;
  readonly probeCost: number;
  readonly detailCost: number;
  readonly dirtyCount: number;
  readonly dirtyPrNumbers: readonly number[];
  readonly cachePersisted: boolean;
  readonly projectedPollCost: number;
  readonly projectedPointSpend?: number;
  readonly rateRemaining?: number;
  readonly rateResetAt?: string;
  /** Wall-clock time spent in GitHub observation (probe + detail + forced re-read). */
  readonly observeMs: number;
  /** Wall-clock time for the whole poll, including CircleCI and the ledger commit. */
  readonly totalMs: number;
  readonly complete?: boolean;
  readonly incompleteReasons?: readonly string[];
  readonly eventsObserved?: number;
  readonly eventsPending?: number;
  readonly terminalCandidate?: boolean;
  /** Watch status after this poll committed. */
  readonly status: PrWatchStatus;
  readonly blockerKind?: PrWatchBlockerKind;
  readonly error?: string;
}

export interface PrWatchPollSummary {
  readonly windowMs: number;
  readonly polls: number;
  readonly points: number;
  readonly apiCalls: number;
  readonly byMode: { readonly full: number; readonly probe: number; readonly partial: number };
  readonly forcedRefreshes: number;
  readonly dirtyPrTotal: number;
  readonly avgObserveMs: number;
  readonly maxObserveMs: number;
  readonly avgTotalMs: number;
  readonly actionable: number;
  readonly blocked: number;
  readonly errors: number;
  readonly lastRateRemaining?: number;
}

export function prWatchPollLogPath(watchDir: string): string {
  return join(watchDir, PR_WATCH_POLL_LOG_FILE);
}

/** Best-effort append with a single rotation once the file passes the cap. */
export function appendPrWatchPollLog(watchDir: string, record: PrWatchPollLogRecordV1): boolean {
  const path = prWatchPollLogPath(watchDir);
  try {
    if (existsSync(path) && statSync(path).size >= PR_WATCH_POLL_LOG_MAX_BYTES) {
      renameSync(path, join(watchDir, PR_WATCH_POLL_LOG_ROTATED_FILE));
    }
    const fd = openSync(path, 'a', 0o600);
    try {
      writeSync(fd, `${JSON.stringify(record)}\n`, undefined, 'utf-8');
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (error) {
    logBestEffortFailure('pr-watch-poll-log-append', error);
    return false;
  }
}

/**
 * Read the newest records without loading the whole file: only the last
 * `maxBytes` are parsed, a partial first line is dropped, and corrupt lines
 * are skipped rather than failing the read.
 */
export function readPrWatchPollLog(
  watchDir: string,
  options: { readonly tail?: number; readonly maxBytes?: number } = {},
): readonly PrWatchPollLogRecordV1[] {
  const path = prWatchPollLogPath(watchDir);
  if (!existsSync(path)) return [];
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  let text: string;
  let truncatedHead = false;
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - maxBytes);
    truncatedHead = start > 0;
    const fd = openSync(path, 'r');
    try {
      const buffer = Buffer.alloc(size - start);
      readSync(fd, buffer, 0, buffer.length, start);
      text = buffer.toString('utf-8');
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    logBestEffortFailure('pr-watch-poll-log-read', error);
    return [];
  }
  const lines = text.split('\n');
  if (truncatedHead) lines.shift();
  const records: PrWatchPollLogRecordV1[] = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isPollLogRecord(parsed)) records.push(parsed);
    } catch {
      // A torn or foreign line is skipped; the log is diagnostic.
    }
  }
  return options.tail === undefined ? records : records.slice(-options.tail);
}

function isPollLogRecord(value: unknown): value is PrWatchPollLogRecordV1 {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.v === 1
    && typeof record.ts === 'string'
    && typeof record.watchId === 'string'
    && typeof record.status === 'string'
    && typeof record.queryCost === 'number'
    && typeof record.observeMs === 'number';
}

export function summarizePrWatchPolls(
  records: readonly PrWatchPollLogRecordV1[],
  options: { readonly now: Date; readonly windowMs?: number },
): PrWatchPollSummary {
  const windowMs = options.windowMs ?? 60 * 60_000;
  const since = options.now.getTime() - windowMs;
  const inWindow = records.filter((record) => {
    const at = Date.parse(record.ts);
    return Number.isFinite(at) && at >= since && at <= options.now.getTime();
  });
  const byMode = { full: 0, probe: 0, partial: 0 };
  let points = 0;
  let apiCalls = 0;
  let forcedRefreshes = 0;
  let dirtyPrTotal = 0;
  let observeTotal = 0;
  let observeMax = 0;
  let totalTotal = 0;
  let actionable = 0;
  let blocked = 0;
  let errors = 0;
  let lastRateRemaining: number | undefined;
  for (const record of inWindow) {
    if (record.mode) byMode[record.mode] += 1;
    points += record.queryCost;
    apiCalls += record.apiCalls;
    if (record.forcedRefresh) forcedRefreshes += 1;
    dirtyPrTotal += record.dirtyCount;
    observeTotal += record.observeMs;
    observeMax = Math.max(observeMax, record.observeMs);
    totalTotal += record.totalMs;
    if (record.status === 'actionable') actionable += 1;
    if (record.status === 'blocked') blocked += 1;
    if (record.error !== undefined) errors += 1;
    if (record.rateRemaining !== undefined) lastRateRemaining = record.rateRemaining;
  }
  const polls = inWindow.length;
  return {
    windowMs,
    polls,
    points,
    apiCalls,
    byMode,
    forcedRefreshes,
    dirtyPrTotal,
    avgObserveMs: polls === 0 ? 0 : Math.round(observeTotal / polls),
    maxObserveMs: observeMax,
    avgTotalMs: polls === 0 ? 0 : Math.round(totalTotal / polls),
    actionable,
    blocked,
    errors,
    ...(lastRateRemaining !== undefined ? { lastRateRemaining } : {}),
  };
}

/** Fixed-width text view for `crew-pr-watch polls`. */
export function renderPrWatchPollTable(records: readonly PrWatchPollLogRecordV1[]): string {
  const header = [
    pad('time', 20), pad('mode', 8), pad('calls', 5), pad('pts', 5), pad('probe', 5),
    pad('detail', 6), pad('dirty', 5), pad('forced', 6), pad('obs_ms', 7), pad('total_ms', 8),
    pad('remain', 6), pad('proj', 5), pad('events', 6), pad('status', 10), 'note',
  ].join(' ');
  const rows = records.map((record) => {
    const note = record.error !== undefined
      ? `error: ${record.error}`
      : record.blockerKind !== undefined
        ? `blocked: ${record.blockerKind}`
        : record.fullRefreshReason !== undefined && record.fullRefreshReason !== 'no_cache'
          ? record.fullRefreshReason
          : record.complete === false
            ? `incomplete: ${(record.incompleteReasons ?? []).slice(0, 3).join(', ')}`
            : '';
    return [
      pad(record.ts.replace('T', ' ').slice(0, 19), 20),
      pad(record.mode ?? '-', 8),
      pad(String(record.apiCalls), 5),
      pad(String(record.queryCost), 5),
      pad(String(record.probeCost), 5),
      pad(String(record.detailCost), 6),
      pad(String(record.dirtyCount), 5),
      pad(record.forcedRefresh ? 'yes' : '', 6),
      pad(String(record.observeMs), 7),
      pad(String(record.totalMs), 8),
      pad(record.rateRemaining === undefined ? '-' : String(record.rateRemaining), 6),
      pad(record.projectedPollCost === undefined ? '-' : String(record.projectedPollCost), 5),
      pad(record.eventsPending === undefined ? '-' : `${record.eventsPending}/${record.eventsObserved ?? 0}`, 6),
      pad(record.status, 10),
      note,
    ].join(' ').trimEnd();
  });
  return [header, ...rows].join('\n');
}

export function renderPrWatchPollSummary(summary: PrWatchPollSummary): string {
  const minutes = Math.round(summary.windowMs / 60_000);
  return [
    `last ${minutes} min: ${summary.polls} polls, ${summary.points} points, ${summary.apiCalls} calls`
    + ` (full ${summary.byMode.full}, probe ${summary.byMode.probe}, partial ${summary.byMode.partial},`
    + ` forced re-reads ${summary.forcedRefreshes})`,
    `dirty PRs ${summary.dirtyPrTotal}, observe avg ${summary.avgObserveMs} ms / max ${summary.maxObserveMs} ms,`
    + ` poll avg ${summary.avgTotalMs} ms, actionable ${summary.actionable}, blocked ${summary.blocked},`
    + ` errors ${summary.errors}`
    + (summary.lastRateRemaining !== undefined ? `, rate remaining ${summary.lastRateRemaining}` : ''),
  ].join('\n');
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}
