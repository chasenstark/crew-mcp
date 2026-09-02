import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { atomicWrite } from '../utils/atomic-write.js';
import { logBestEffortFailure } from '../utils/best-effort.js';
import {
  changeSignalOf,
  changeSignalsEqual,
  commentCanProduceEvent,
  type GitHubProbeObservation,
  type GitHubPullRequestObservation,
  type GitHubSnapshotObservation,
  type PrWatchCommentSignalPolicy,
} from './github-observation.js';
import { parsePrWatchId } from './id.js';

/**
 * Delta-polling sidecar. The authoritative ledger never depends on these
 * files: a missing, stale, or corrupt cache only forces the next poll to take
 * a full snapshot. Two files keep churn proportional to change:
 *
 * - `observation-cache.json` holds the last detail observation for every
 *   watched PR plus the change signal it was fetched under. It is rewritten
 *   only when a detail fetch happened (full refresh or dirty PRs).
 * - `observation-poll.json` is a small per-poll record: last probe cost, the
 *   recent detail-cost window, and diagnostics. It is rewritten every poll.
 */
export const PR_WATCH_OBSERVATION_CACHE_FILE = 'observation-cache.json';
export const PR_WATCH_OBSERVATION_POLL_FILE = 'observation-poll.json';
export const PR_WATCH_FULL_REFRESH_INTERVAL_MS = 15 * 60_000;
export const PR_WATCH_RECENT_DETAIL_COST_WINDOW = 10;
/**
 * The detail-cost average divides by at least this many polls, so a young
 * window with one expensive sample reads as "mostly quiet" rather than as a
 * steady state of that one cost.
 */
export const PR_WATCH_MIN_COST_WINDOW_SAMPLES = 5;

export type PrWatchPollMode = 'full' | 'probe' | 'partial';
export type PrWatchFullRefreshReason =
  | 'no_cache'
  | 'repository_changed'
  | 'interval_elapsed'
  | 'terminal_candidate';

export interface PrWatchPollDiagnosticsV1 {
  readonly observedAt: string;
  readonly mode: PrWatchPollMode;
  readonly apiCalls: number;
  readonly probeCost: number;
  readonly detailCost: number;
  readonly dirtyPrNumbers: readonly number[];
  readonly projectedPollCost: number;
  readonly fullRefreshReason?: PrWatchFullRefreshReason;
}

export interface PrWatchObservationCacheV1 {
  readonly schemaVersion: 1;
  readonly watchId: string;
  readonly repository: string;
  readonly viewer: string;
  readonly lastFullRefreshAt: string;
  readonly lastFullRefreshCost: number;
  readonly prs: Readonly<Record<string, GitHubPullRequestObservation>>;
  readonly lastProbeCost?: number;
  readonly recentDetailCosts: readonly number[];
  /** Absent when the poll record is missing or unreadable. */
  readonly lastPoll?: PrWatchPollDiagnosticsV1;
}

export type PrWatchObservationPlan =
  | { readonly mode: 'full'; readonly reason: PrWatchFullRefreshReason }
  | { readonly mode: 'delta'; readonly cache: PrWatchObservationCacheV1 };

const nonNegativeInteger = z.number().int().min(0);
const prState = z.enum(['OPEN', 'CLOSED', 'MERGED']);
const reviewDecision = z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']).nullable();

const changeSignalSchema = z.object({
  state: prState,
  updatedAt: z.string().min(1),
  headSha: z.string().min(1),
  baseRefName: z.string().min(1),
  reviewDecision,
  isDraft: z.boolean(),
  rollupState: z.enum(['EXPECTED', 'ERROR', 'FAILURE', 'PENDING', 'SUCCESS']).nullable(),
  commentsDigest: z.string().min(1),
  threadsDigest: z.string().min(1),
}).strict();

const observationSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().min(1),
  state: prState,
  headRefName: z.string().min(1),
  baseRefName: z.string().min(1),
  headRepository: z.string().min(1),
  baseRepository: z.string().min(1),
  headSha: z.string().min(1),
  headCommittedAt: z.string().min(1),
  author: z.string(),
  reviewDecision,
  checks: z.array(z.object({
    context: z.string(),
    sourceId: z.string(),
    attempt: z.number().int(),
    status: z.enum(['QUEUED', 'IN_PROGRESS', 'COMPLETED', 'EXPECTED']),
    conclusion: z.enum([
      'SUCCESS', 'FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'SKIPPED', 'NEUTRAL',
    ]).nullable(),
  }).strict()),
  reviews: z.array(z.object({
    id: z.string(),
    author: z.string(),
    state: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED']),
    submittedAt: z.string(),
    commitSha: z.string().optional(),
  }).strict()),
  threads: z.array(z.object({
    id: z.string(),
    isResolved: z.boolean(),
    isOutdated: z.boolean(),
    updatedAt: z.string(),
    lastCommentDatabaseId: z.number().int().optional(),
  }).strict()),
  comments: z.array(z.object({
    id: z.string(),
    author: z.string(),
    authorType: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    lastEditedAt: z.string().nullable(),
    body: z.string(),
  }).strict()),
  paginationComplete: z.boolean(),
  detailsComplete: z.boolean(),
  changeSignal: changeSignalSchema,
}).strict();

const detailsFileSchema = z.object({
  schemaVersion: z.literal(1),
  watchId: z.string().min(1),
  repository: z.string().min(1),
  viewer: z.string(),
  lastFullRefreshAt: z.string().min(1),
  lastFullRefreshCost: nonNegativeInteger,
  prs: z.record(z.string().regex(/^[1-9][0-9]*$/), observationSchema),
}).strict();

const diagnosticsSchema = z.object({
  observedAt: z.string().min(1),
  mode: z.enum(['full', 'probe', 'partial']),
  apiCalls: nonNegativeInteger,
  probeCost: nonNegativeInteger,
  detailCost: nonNegativeInteger,
  dirtyPrNumbers: z.array(z.number().int().positive()),
  projectedPollCost: nonNegativeInteger,
  fullRefreshReason: z.enum([
    'no_cache', 'repository_changed', 'interval_elapsed', 'terminal_candidate',
  ]).optional(),
}).strict();

const pollFileSchema = z.object({
  schemaVersion: z.literal(1),
  watchId: z.string().min(1),
  lastProbeCost: nonNegativeInteger.optional(),
  recentDetailCosts: z.array(nonNegativeInteger).max(PR_WATCH_RECENT_DETAIL_COST_WINDOW),
  lastPoll: diagnosticsSchema,
}).strict();

export function prWatchObservationCachePath(watchDir: string): string {
  return join(watchDir, PR_WATCH_OBSERVATION_CACHE_FILE);
}

export function prWatchObservationPollPath(watchDir: string): string {
  return join(watchDir, PR_WATCH_OBSERVATION_POLL_FILE);
}

/**
 * Fail-soft read: any problem with the details file returns `undefined` and
 * the caller refreshes. A missing or unreadable poll record only loses the
 * cost window and diagnostics.
 */
export function readPrWatchObservationCache(
  watchDir: string,
  watchId: string,
): PrWatchObservationCacheV1 | undefined {
  const id = parsePrWatchId(watchId);
  const details = readJsonFile(prWatchObservationCachePath(watchDir), detailsFileSchema, id);
  if (!details) return undefined;
  for (const [key, pr] of Object.entries(details.prs)) {
    if (String(pr.number) !== key) return undefined;
  }
  const poll = readJsonFile(prWatchObservationPollPath(watchDir), pollFileSchema, id);
  return {
    ...(details as Omit<PrWatchObservationCacheV1, 'recentDetailCosts'>),
    ...(poll
      ? {
          ...(poll.lastProbeCost !== undefined ? { lastProbeCost: poll.lastProbeCost } : {}),
          recentDetailCosts: poll.recentDetailCosts,
          lastPoll: poll.lastPoll,
        }
      : { recentDetailCosts: [] }),
  };
}

function readJsonFile<T extends { readonly watchId: string }>(
  path: string,
  schema: z.ZodType<T>,
  watchId: string,
): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(readFileSync(path, 'utf-8')) as unknown);
    if (!parsed.success || parsed.data.watchId !== watchId) return undefined;
    return parsed.data;
  } catch (error) {
    logBestEffortFailure('pr-watch-observation-cache-read', error);
    return undefined;
  }
}

/**
 * Best-effort durable write. Returns false when any attempted write failed;
 * the caller must then treat this poll's cost as unamortized, because the
 * next poll cannot rely on the cache. The details file is written only when
 * `detailsChanged` says a detail fetch happened.
 */
export function writePrWatchObservationCache(
  watchDir: string,
  cache: PrWatchObservationCacheV1,
  options: { readonly detailsChanged: boolean },
): boolean {
  let ok = true;
  if (options.detailsChanged) {
    ok = writeJsonFile(prWatchObservationCachePath(watchDir), {
      schemaVersion: 1,
      watchId: cache.watchId,
      repository: cache.repository,
      viewer: cache.viewer,
      lastFullRefreshAt: cache.lastFullRefreshAt,
      lastFullRefreshCost: cache.lastFullRefreshCost,
      prs: cache.prs,
    }) && ok;
  }
  if (cache.lastPoll) {
    ok = writeJsonFile(prWatchObservationPollPath(watchDir), {
      schemaVersion: 1,
      watchId: cache.watchId,
      ...(cache.lastProbeCost !== undefined ? { lastProbeCost: cache.lastProbeCost } : {}),
      recentDetailCosts: cache.recentDetailCosts,
      lastPoll: cache.lastPoll,
    }) && ok;
  }
  return ok;
}

function writeJsonFile(path: string, value: unknown): boolean {
  try {
    atomicWrite(path, `${JSON.stringify(value)}\n`, { makeDirs: false });
    if (process.platform !== 'win32') chmodSync(path, 0o600);
    return true;
  } catch (error) {
    logBestEffortFailure('pr-watch-observation-cache-write', error);
    return false;
  }
}

export function planPrWatchObservation(args: {
  readonly cache: PrWatchObservationCacheV1 | undefined;
  readonly repository: string;
  readonly now: Date;
  readonly fullRefreshIntervalMs?: number;
}): PrWatchObservationPlan {
  const interval = args.fullRefreshIntervalMs ?? PR_WATCH_FULL_REFRESH_INTERVAL_MS;
  if (!args.cache) return { mode: 'full', reason: 'no_cache' };
  if (args.cache.repository !== args.repository) return { mode: 'full', reason: 'repository_changed' };
  const lastFull = Date.parse(args.cache.lastFullRefreshAt);
  if (!Number.isFinite(lastFull) || args.now.getTime() - lastFull >= interval) {
    return { mode: 'full', reason: 'interval_elapsed' };
  }
  return { mode: 'delta', cache: args.cache };
}

/** PRs whose probe signal differs from, or is missing in, the cached detail. */
export function selectDirtyPrNumbers(args: {
  readonly probe: GitHubProbeObservation;
  readonly cache: PrWatchObservationCacheV1;
  readonly prNumbers: readonly number[];
}): readonly number[] {
  const dirty: number[] = [];
  for (const number of args.prNumbers) {
    const key = String(number);
    const signal = args.probe.signals[key];
    if (!signal) throw new Error(`pr_watch.probe_missing_pr: ${number}`);
    const cached = args.cache.prs[key];
    if (!cached || !changeSignalsEqual(changeSignalOf(cached), signal)) dirty.push(number);
  }
  return dirty;
}

/**
 * Expected steady-state cost of one poll: the probe, the full refresh
 * amortized over the polls between refreshes, and the recent average detail
 * spend. Rounded up so the ledger's projected spend stays an integer.
 */
export function projectedSteadyStatePollCost(args: {
  readonly probeCost: number;
  readonly fullRefreshCost: number;
  readonly recentDetailCosts: readonly number[];
  readonly cadenceSeconds: number;
  readonly fullRefreshIntervalMs?: number;
}): number {
  const interval = Math.max(1, args.fullRefreshIntervalMs ?? PR_WATCH_FULL_REFRESH_INTERVAL_MS);
  const cadenceMs = Math.max(1, args.cadenceSeconds) * 1000;
  const amortizedFull = args.fullRefreshCost * Math.min(1, cadenceMs / interval);
  const recent = args.recentDetailCosts;
  const averageDetail = recent.reduce((sum, cost) => sum + cost, 0)
    / Math.max(recent.length, PR_WATCH_MIN_COST_WINDOW_SAMPLES);
  return Math.ceil(args.probeCost + amortizedFull + averageDetail);
}

/** Three flat connections per PR (head commit, comments, threads) plus the root. */
export function estimateProbeCost(prCount: number): number {
  return Math.max(1, Math.ceil((1 + 3 * prCount) / 100));
}

/**
 * Keep only the comments evaluation can ever use. Everything else in the
 * observation is already bounded by the query shape (100 threads, reviews,
 * and check contexts per PR); comment bodies are the one unbounded payload.
 * Verdict-source comments keep their body for marker matching; review-bot
 * comments keep only their identity and edit time, which is all a bot
 * comment event needs; every other comment is dropped.
 */
export function compactObservationForCache(
  pr: GitHubPullRequestObservation,
  commentPolicy: PrWatchCommentSignalPolicy,
): GitHubPullRequestObservation {
  changeSignalOf(pr);
  const comments = pr.comments.flatMap((comment) => {
    if (!commentCanProduceEvent(comment, commentPolicy)) return [];
    if (commentPolicy.verdictAuthors.has(comment.author.toLowerCase())) return [comment];
    return [comment.body === '' ? comment : { ...comment, body: '' }];
  });
  const unchanged = comments.length === pr.comments.length
    && comments.every((comment, index) => comment === pr.comments[index]);
  return unchanged ? pr : { ...pr, comments };
}

export function cacheAfterFullRefresh(args: {
  readonly prior: PrWatchObservationCacheV1 | undefined;
  readonly watchId: string;
  readonly snapshot: GitHubSnapshotObservation;
  readonly reason: PrWatchFullRefreshReason;
  readonly cadenceSeconds: number;
  readonly fullRefreshIntervalMs?: number;
  readonly commentPolicy: PrWatchCommentSignalPolicy;
  /**
   * Set when this refresh continues a poll that already spent on a probe
   * and detail fetch (a terminal-candidate re-read). The refresh cost then
   * folds into that poll's window entry and diagnostics instead of being
   * treated as the amortized periodic refresh.
   */
  readonly continuation?: { readonly queryCost: number; readonly apiCalls: number };
}): { readonly cache: PrWatchObservationCacheV1; readonly projectedPollCost: number } {
  const carried = args.prior && args.prior.repository === args.snapshot.repository ? args.prior : undefined;
  const probeCost = carried?.lastProbeCost ?? estimateProbeCost(args.snapshot.prs.length);
  const samePoll = args.continuation ? carried?.lastPoll : undefined;
  const carriedWindow = carried?.recentDetailCosts ?? [];
  const recentDetailCosts = args.continuation
    ? [...carriedWindow.slice(0, -1), (carriedWindow.at(-1) ?? 0) + args.snapshot.queryCost]
      .slice(-PR_WATCH_RECENT_DETAIL_COST_WINDOW)
    : carriedWindow;
  const projectedPollCost = projectedSteadyStatePollCost({
    probeCost,
    fullRefreshCost: args.continuation ? (carried?.lastFullRefreshCost ?? args.snapshot.queryCost) : args.snapshot.queryCost,
    recentDetailCosts,
    cadenceSeconds: args.cadenceSeconds,
    ...(args.fullRefreshIntervalMs !== undefined ? { fullRefreshIntervalMs: args.fullRefreshIntervalMs } : {}),
  });
  const prs: Record<string, GitHubPullRequestObservation> = {};
  for (const pr of args.snapshot.prs) {
    prs[String(pr.number)] = compactObservationForCache(pr, args.commentPolicy);
  }
  return {
    projectedPollCost,
    cache: {
      schemaVersion: 1,
      watchId: parsePrWatchId(args.watchId),
      repository: args.snapshot.repository,
      viewer: args.snapshot.viewer,
      lastFullRefreshAt: args.snapshot.observedAt,
      lastFullRefreshCost: args.snapshot.queryCost,
      prs,
      ...(carried?.lastProbeCost !== undefined ? { lastProbeCost: carried.lastProbeCost } : {}),
      recentDetailCosts,
      lastPoll: {
        observedAt: args.snapshot.observedAt,
        mode: 'full',
        apiCalls: args.snapshot.apiCalls + (args.continuation?.apiCalls ?? 0),
        probeCost: samePoll?.probeCost ?? 0,
        detailCost: args.snapshot.queryCost + (samePoll?.detailCost ?? 0),
        dirtyPrNumbers: args.snapshot.prs.map((pr) => pr.number),
        projectedPollCost,
        fullRefreshReason: args.reason,
      },
    },
  };
}

/**
 * Combine a probe with the cached details (and the detail fetch for dirty
 * PRs, when any) into one snapshot shaped exactly like a full fetch, so the
 * evaluator and reducer never learn which PRs were served from cache.
 */
export function mergeDeltaObservation(args: {
  readonly cache: PrWatchObservationCacheV1;
  readonly probe: GitHubProbeObservation;
  readonly details: GitHubSnapshotObservation | undefined;
  readonly dirtyPrNumbers: readonly number[];
  readonly prNumbers: readonly number[];
  readonly observedAt: string;
  readonly cadenceSeconds: number;
  readonly fullRefreshIntervalMs?: number;
  readonly commentPolicy: PrWatchCommentSignalPolicy;
}): {
  readonly snapshot: GitHubSnapshotObservation;
  readonly cache: PrWatchObservationCacheV1;
  readonly detailsChanged: boolean;
  readonly projectedPollCost: number;
} {
  const fetched = new Map<number, GitHubPullRequestObservation>();
  for (const pr of args.details?.prs ?? []) fetched.set(pr.number, pr);
  for (const number of args.dirtyPrNumbers) {
    if (!fetched.has(number)) throw new Error(`pr_watch.detail_missing_pr: ${number}`);
  }
  const prs: GitHubPullRequestObservation[] = [];
  const nextPrs: Record<string, GitHubPullRequestObservation> = {};
  for (const number of args.prNumbers) {
    const key = String(number);
    const pr = fetched.get(number) ?? args.cache.prs[key];
    if (!pr) throw new Error(`pr_watch.cache_missing_pr: ${number}`);
    changeSignalOf(pr);
    prs.push(pr);
    nextPrs[key] = compactObservationForCache(pr, args.commentPolicy);
  }
  const detailCost = args.details?.queryCost ?? 0;
  const recentDetailCosts = [...args.cache.recentDetailCosts, detailCost]
    .slice(-PR_WATCH_RECENT_DETAIL_COST_WINDOW);
  const projectedPollCost = projectedSteadyStatePollCost({
    probeCost: args.probe.queryCost,
    fullRefreshCost: args.cache.lastFullRefreshCost,
    recentDetailCosts,
    cadenceSeconds: args.cadenceSeconds,
    ...(args.fullRefreshIntervalMs !== undefined ? { fullRefreshIntervalMs: args.fullRefreshIntervalMs } : {}),
  });
  const latest = args.details ?? args.probe;
  const snapshot: GitHubSnapshotObservation = {
    repository: args.probe.repository,
    viewer: latest.viewer,
    observedAt: args.observedAt,
    prs,
    queryCost: args.probe.queryCost + detailCost,
    rateRemaining: latest.rateRemaining,
    rateResetAt: latest.rateResetAt,
    apiCalls: args.details ? 2 : 1,
  };
  const detailsChanged = args.details !== undefined;
  return {
    snapshot,
    detailsChanged,
    projectedPollCost,
    cache: {
      ...args.cache,
      ...(detailsChanged ? { viewer: latest.viewer, prs: nextPrs } : {}),
      lastProbeCost: args.probe.queryCost,
      recentDetailCosts,
      lastPoll: {
        observedAt: args.observedAt,
        mode: detailsChanged ? 'partial' : 'probe',
        apiCalls: snapshot.apiCalls,
        probeCost: args.probe.queryCost,
        detailCost,
        dirtyPrNumbers: [...args.dirtyPrNumbers],
        projectedPollCost,
      },
    },
  };
}
