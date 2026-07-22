import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { DEFAULT_RUNDIR_TTL_DAYS } from './config-store.js';
import { atomicWrite } from './atomic-write.js';
import { withFileLock } from './file-lock.js';

export const WATCH_INDEX_MAX_RUNS = 20_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

export type WatchIndexRecord =
  | {
      readonly event: 'start';
      readonly ts: string;
      readonly run_id: string;
      readonly watcher_pid: number;
      readonly watcher_instance: string;
    }
  | {
      readonly event: 'terminal_observed';
      readonly ts: string;
      readonly run_id: string;
      readonly watcher_pid: number;
      readonly watcher_instance: string;
      readonly status: string;
      readonly exit_outcome: 0 | 3;
      readonly terminal_at?: string;
    };

export interface AppendWatchIndexOptions {
  readonly crewHome: string;
  readonly record: WatchIndexRecord;
  readonly nowMs?: number;
  readonly ttlDays?: number;
  readonly maxRuns?: number;
  /** Test seam invoked after pruning is computed but before replacement. */
  readonly beforeCompactWrite?: () => void | Promise<void>;
}

export function watchIndexPath(crewHome: string): string {
  return join(crewHome, 'runs', '.meta', 'watch-index.jsonl');
}

/**
 * Best-effort watcher trace. The append is one O_APPEND line and compaction
 * is entry-based: expired terminal runs are removed, then the oldest run ids
 * are trimmed if the distinct-run bound is exceeded. Any failure is ignored.
 */
export async function appendWatchIndex(options: AppendWatchIndexOptions): Promise<void> {
  let path: string | undefined;
  let line: string | undefined;
  let appended = false;
  try {
    const resolvedPath = watchIndexPath(options.crewHome);
    const serializedLine = `${JSON.stringify(options.record)}\n`;
    path = resolvedPath;
    line = serializedLine;
    mkdirSync(dirname(resolvedPath), { recursive: true });
    await withFileLock(
      watchIndexLockOptions(resolvedPath),
      async () => {
        appendLine(resolvedPath, serializedLine);
        appended = true;
        await compactWatchIndexLocked({
          path: resolvedPath,
          nowMs: options.nowMs ?? Date.now(),
          ttlDays: options.ttlDays ?? DEFAULT_RUNDIR_TTL_DAYS,
          maxRuns: options.maxRuns ?? WATCH_INDEX_MAX_RUNS,
          beforeCompactWrite: options.beforeCompactWrite,
        });
      },
    );
  } catch {
    // If lock acquisition failed, preserve the record with one bare O_APPEND
    // and skip compaction. If the append already landed and only compaction
    // failed, do not duplicate it. Either way watcher behavior stays intact.
    if (!appended && path !== undefined && line !== undefined) {
      try {
        mkdirSync(dirname(path), { recursive: true });
        appendLine(path, line);
      } catch {
        // Fail open: watcher observability must not change its result or exit.
      }
    }
  }
}

interface CompactWatchIndexOptions {
  readonly path: string;
  readonly nowMs: number;
  readonly ttlDays: number;
  readonly maxRuns: number;
  readonly beforeCompactWrite?: () => void | Promise<void>;
}

async function compactWatchIndexLocked(options: CompactWatchIndexOptions): Promise<void> {
  if (!existsSync(options.path)) return;
  const records = parseRecords(readFileSync(options.path, 'utf-8'));
  if (!needsCompaction(records, options)) return;

  const latestByRun = new Map<string, WatchIndexRecord>();
  const order: string[] = [];
  for (const record of records) {
    if (!latestByRun.has(record.run_id)) order.push(record.run_id);
    latestByRun.set(record.run_id, record);
  }

  const cutoffMs = options.nowMs - Math.max(0, options.ttlDays) * DAY_MS;
  const retainedRunIds = order.filter((runId) => {
    const latest = latestByRun.get(runId);
    if (!latest || latest.event !== 'terminal_observed') return true;
    const terminalMs = Date.parse(latest.terminal_at ?? latest.ts);
    return !Number.isFinite(terminalMs) || terminalMs >= cutoffMs;
  });
  const boundedRunIds = retainedRunIds.slice(-Math.max(1, options.maxRuns));
  const keep = new Set(boundedRunIds);
  const retained = records.filter((record) => keep.has(record.run_id));

  if (retained.length === records.length) return;
  await options.beforeCompactWrite?.();
  atomicWrite(
    options.path,
    retained.length > 0 ? `${retained.map((record) => JSON.stringify(record)).join('\n')}\n` : '',
    { fsync: false },
  );
}

function watchIndexLockOptions(path: string): Parameters<typeof withFileLock>[0] {
  return {
    lockDir: `${path}.lock`,
    timeoutMs: 50,
    staleMs: 30_000,
    timeoutMessage: `Timed out updating watch index ${path}.`,
    missingRootMessage: `Watch index directory disappeared while updating ${path}.`,
  };
}

function parseRecords(raw: string): WatchIndexRecord[] {
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as WatchIndexRecord;
        return typeof parsed.run_id === 'string' && typeof parsed.ts === 'string'
          ? [parsed]
          : [];
      } catch {
        return [];
      }
    });
}

function needsCompaction(
  records: readonly WatchIndexRecord[],
  options: Pick<CompactWatchIndexOptions, 'nowMs' | 'ttlDays' | 'maxRuns'>,
): boolean {
  const latestByRun = new Map<string, WatchIndexRecord>();
  for (const record of records) latestByRun.set(record.run_id, record);
  if (latestByRun.size > options.maxRuns) return true;
  const cutoffMs = options.nowMs - Math.max(0, options.ttlDays) * DAY_MS;
  return [...latestByRun.values()].some((record) => (
    record.event === 'terminal_observed'
    && Number.isFinite(Date.parse(record.terminal_at ?? record.ts))
    && Date.parse(record.terminal_at ?? record.ts) < cutoffMs
  ));
}

function appendLine(path: string, line: string): void {
  const fd = openSync(path, 'a');
  try {
    writeSync(fd, line, undefined, 'utf-8');
  } finally {
    closeSync(fd);
  }
}
