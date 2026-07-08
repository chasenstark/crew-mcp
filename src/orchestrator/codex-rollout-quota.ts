/**
 * Post-terminal codex quota seeding from the session rollout file.
 *
 * `codex exec --json` stdout carries NO rate-limit data, but codex
 * persists the real headroom — `used_percent` for the 5h (`primary`)
 * and weekly (`secondary`) windows plus `resets_at` — to its session
 * rollout file (`${CODEX_HOME:-~/.codex}/sessions/YYYY/MM/DD/
 * rollout-<ts>-<thread_id>.jsonl`), the same data the TUI `/status`
 * reads. The run→rollout mapping is deterministic: the exec stream's
 * `thread.started.thread_id` (persisted as `RunStateV1.sessionId`)
 * equals the filename's `<thread_id>` suffix.
 *
 * This reads codex-internal state, so everything here is fail-soft:
 * schema-gated parsing, `confidence: 'medium'`, and any miss (file
 * absent, format drift, `--ephemeral` suppressing rollouts) degrades
 * to the reactive-only behavior that existed before this module.
 * Rollouts can be large — only the tail is read, and `token_count`
 * events recur so the last one is always near the end.
 */

import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logBestEffortFailure } from '../utils/best-effort.js';
import type { QuotaCache } from './quota-cache.js';
import { QUOTA_SNAPSHOT_MAX_AGE_MS } from './quota-cache.js';
import type { QuotaSnapshot } from './tools/index.js';

export const CODEX_ROLLOUT_TAIL_BYTES = 256 * 1024;

/** used_percent at or above this (either window) reports `near_limit`. */
export const CODEX_NEAR_LIMIT_PERCENT = 90;

/** used_percent at or above this (either window) reports `limited`. */
export const CODEX_LIMITED_PERCENT = 100;

/**
 * Bounded walk depth under `sessions/`: year/month/day/rollout-*.jsonl
 * is depth 4; one extra level of slack in case codex nests differently.
 */
const MAX_WALK_DEPTH = 5;

interface RolloutWindow {
  readonly usedPercent: number;
  readonly resetsAt?: string;
  readonly windowMinutes?: number;
}

export interface CodexRolloutRateLimits {
  readonly primary?: RolloutWindow;
  readonly secondary?: RolloutWindow;
  readonly planType?: string;
}

function resolveCodexHome(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.CODEX_HOME?.trim();
  return fromEnv ? fromEnv : join(homedir(), '.codex');
}

/**
 * thread ids are UUIDs in every observed rollout filename; gate the
 * shape before using it in filename matching so a corrupt sessionId
 * can't match unrelated files.
 */
function isPlausibleThreadId(threadId: string): boolean {
  return /^[0-9a-zA-Z-]{8,64}$/.test(threadId);
}

async function findRolloutFile(
  codexHome: string,
  threadId: string,
): Promise<string | undefined> {
  const suffix = `-${threadId}.jsonl`;
  const matches: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_WALK_DEPTH) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (
        entry.isFile()
        && entry.name.startsWith('rollout-')
        && entry.name.endsWith(suffix)
      ) {
        matches.push(full);
      }
    }
  }

  await walk(join(codexHome, 'sessions'), 1);
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0];

  // Shouldn't happen (thread ids are unique), but prefer the newest.
  let best: { path: string; mtimeMs: number } | undefined;
  for (const path of matches) {
    try {
      const info = await stat(path);
      if (best === undefined || info.mtimeMs > best.mtimeMs) {
        best = { path, mtimeMs: info.mtimeMs };
      }
    } catch {
      // Race with deletion — skip.
    }
  }
  return best?.path;
}

async function readTail(path: string, tailBytes: number): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return undefined;
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, tailBytes);
    if (length === 0) return '';
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf-8');
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function parseWindow(raw: unknown): RolloutWindow | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const usedPercent = record.used_percent;
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent) || usedPercent < 0) {
    return undefined;
  }
  const resetsAtRaw = record.resets_at;
  const resetsAt =
    typeof resetsAtRaw === 'number' && Number.isFinite(resetsAtRaw) && resetsAtRaw > 0
      ? new Date(resetsAtRaw * 1000).toISOString()
      : undefined;
  const windowMinutesRaw = record.window_minutes;
  const windowMinutes =
    typeof windowMinutesRaw === 'number' && Number.isFinite(windowMinutesRaw)
      ? windowMinutesRaw
      : undefined;
  return {
    usedPercent,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(windowMinutes !== undefined ? { windowMinutes } : {}),
  };
}

function parseRateLimitsLine(line: string): CodexRolloutRateLimits | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const record = parsed as { type?: unknown; payload?: unknown };
  if (record.type !== 'event_msg') return undefined;
  const payload = record.payload;
  if (payload === null || typeof payload !== 'object') return undefined;
  const payloadRecord = payload as { type?: unknown; rate_limits?: unknown };
  if (payloadRecord.type !== 'token_count') return undefined;
  const rateLimits = payloadRecord.rate_limits;
  if (rateLimits === null || typeof rateLimits === 'undefined' || typeof rateLimits !== 'object') {
    return undefined;
  }
  const limitsRecord = rateLimits as Record<string, unknown>;
  const primary = parseWindow(limitsRecord.primary);
  const secondary = parseWindow(limitsRecord.secondary);
  if (primary === undefined && secondary === undefined) return undefined;
  const planType = typeof limitsRecord.plan_type === 'string' ? limitsRecord.plan_type : undefined;
  return {
    ...(primary !== undefined ? { primary } : {}),
    ...(secondary !== undefined ? { secondary } : {}),
    ...(planType !== undefined ? { planType } : {}),
  };
}

/**
 * Scan the tail for the LAST `token_count` event carrying a parseable
 * `rate_limits` block. Exported for targeted tests.
 */
export function lastRateLimitsFromTail(tail: string): CodexRolloutRateLimits | undefined {
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    const limits = parseRateLimitsLine(line);
    if (limits !== undefined) return limits;
  }
  return undefined;
}

function windowLabel(window: RolloutWindow | undefined): string | undefined {
  if (window === undefined) return undefined;
  const reset = window.resetsAt !== undefined ? `, resets ${window.resetsAt}` : '';
  return `${window.usedPercent}% used${reset}`;
}

export function quotaSnapshotFromRateLimits(
  limits: CodexRolloutRateLimits,
  checkedAt: string,
): QuotaSnapshot {
  const windows = [limits.primary, limits.secondary]
    .filter((window): window is RolloutWindow => window !== undefined);
  const governing = windows.reduce((worst, window) =>
    (window.usedPercent > worst.usedPercent ? window : worst));
  const state: QuotaSnapshot['state'] =
    governing.usedPercent >= CODEX_LIMITED_PERCENT
      ? 'limited'
      : governing.usedPercent >= CODEX_NEAR_LIMIT_PERCENT
        ? 'near_limit'
        : 'ok';

  // The snapshot goes stale once ANY window resets — the numbers below
  // it change at that boundary even if the governing window runs longer.
  const resetBoundaries = windows
    .map((window) => window.resetsAt)
    .filter((value): value is string => value !== undefined)
    .map((value) => Date.parse(value))
    .filter((value) => !Number.isNaN(value));
  const staleAfter = resetBoundaries.length > 0
    ? new Date(Math.min(...resetBoundaries)).toISOString()
    : new Date(Date.parse(checkedAt) + QUOTA_SNAPSHOT_MAX_AGE_MS).toISOString();

  const parts = [
    limits.primary !== undefined ? `5h ${windowLabel(limits.primary)}` : undefined,
    limits.secondary !== undefined ? `weekly ${windowLabel(limits.secondary)}` : undefined,
    limits.planType !== undefined ? `plan ${limits.planType}` : undefined,
  ].filter((part): part is string => part !== undefined);

  return {
    state,
    confidence: 'medium',
    source: 'session-file',
    checkedAt,
    staleAfter,
    usedPercent: governing.usedPercent,
    ...(governing.resetsAt !== undefined ? { resetAt: governing.resetsAt } : {}),
    message: `codex rollout: ${parts.join('; ')}`,
  };
}

export interface CodexRolloutQuotaArgs {
  readonly threadId: string;
  /** Override for tests; defaults to `${CODEX_HOME:-~/.codex}`. */
  readonly codexHome?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: string;
}

export async function codexRolloutQuotaSnapshot(
  args: CodexRolloutQuotaArgs,
): Promise<QuotaSnapshot | undefined> {
  if (!isPlausibleThreadId(args.threadId)) return undefined;
  const codexHome = args.codexHome ?? resolveCodexHome(args.env ?? process.env);
  const rolloutPath = await findRolloutFile(codexHome, args.threadId);
  if (rolloutPath === undefined) return undefined;
  const tail = await readTail(rolloutPath, CODEX_ROLLOUT_TAIL_BYTES);
  if (tail === undefined) return undefined;
  const limits = lastRateLimitsFromTail(tail);
  if (limits === undefined) return undefined;
  return quotaSnapshotFromRateLimits(limits, args.now ?? new Date().toISOString());
}

export interface SeedCodexRolloutQuotaArgs extends CodexRolloutQuotaArgs {
  /** CANONICAL agent id (post alias resolution). Only 'codex' seeds. */
  readonly agentId: string;
}

/**
 * Severity rank for the downgrade guard below. Only states the reactive
 * path can record for codex appear; anything unlisted ranks lowest.
 */
function quotaSeverityRank(state: QuotaSnapshot['state']): number {
  switch (state) {
    case 'limited':
      return 2;
    case 'near_limit':
      return 1;
    default:
      return 0;
  }
}

/**
 * Best-effort: parse the rollout for a just-terminated codex run and
 * seed the preemptive quota cache with the numeric headroom. Never
 * throws. The rollout read may never IMPROVE a reactive observation —
 * a quota/rate stop is fresher evidence than a token_count event that
 * may predate it (and a 429 can throttle at low used_percent), so a
 * `limited` or `near_limit` state stands until it expires or a
 * same-or-worse rollout replaces it with fresher numbers. Recovery
 * still happens via snapshot expiry (staleAfter) and reactive success
 * observations — just not via this seed.
 */
export async function seedCodexRolloutQuota(
  cache: Pick<QuotaCache, 'get' | 'record'>,
  args: SeedCodexRolloutQuotaArgs,
): Promise<void> {
  if (args.agentId !== 'codex') return;
  try {
    const snapshot = await codexRolloutQuotaSnapshot(args);
    if (snapshot === undefined) return;
    const existing = cache.get(args.agentId, args.now !== undefined ? { now: args.now } : {});
    if (
      existing !== undefined
      && quotaSeverityRank(snapshot.state) < quotaSeverityRank(existing.state)
    ) {
      return;
    }
    cache.record(args.agentId, snapshot);
  } catch (err) {
    logBestEffortFailure('codex-rollout-quota.seed', err);
  }
}
