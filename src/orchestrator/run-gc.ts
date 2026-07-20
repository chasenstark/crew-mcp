import {
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { logger } from '../utils/logger.js';
import { warnOnce } from '../utils/warn-once.js';
import {
  DEFAULT_WORKTREE_TTL_DAYS,
  DEFAULT_RUNDIR_TTL_DAYS,
  DEFAULT_CRITERIA_SET_TTL_DAYS,
  readConfigFile,
} from '../utils/config-store.js';
import type { RunStateStore, RunStateV1 } from './run-state.js';
import type { WorktreeManager } from '../git/worktree.js';
import { gcCriteriaSets } from './criteria/store.js';
import { gcPanelStates } from './panels/store.js';
import { runModeFromState } from './run-mode.js';

/**
 * Garbage-collect terminal crew runs so worktrees and run-dirs don't
 * accumulate unbounded under `<crewHome>/runs/`. Two independent retention
 * windows, both measured from when the run reached a terminal state:
 *
 *   1. Worktree TTL (`CREW_WORKTREE_TTL_DAYS`, default 7) — once a terminal
 *      run is older than this, its worktree directory is removed. Disposable
 *      `ephemeral_review` snapshots use a shorter 24h default when this window
 *      is enabled; other modes retain the configured window. The `crew-run/*`
 *      branch is KEPT (so any unmerged commits survive as a recoverable ref)
 *      EXCEPT for `merged` runs, whose commits already live in the target, and
 *      `discarded` runs, whose work was explicitly abandoned.
 *
 *   2. Run-dir TTL (`CREW_RUNDIR_TTL_DAYS`, default 30) — once a terminal
 *      run is older than this, the entire run-dir (state.json + events.log
 *      + any residual worktree) is deleted. Branches are never touched by
 *      this step; they live in the host repo's git, not the run-dir.
 *
 * Repo-scoped, mirroring the stale-run sweeper: only runs whose `repoRoot`
 * matches the current server's project root are considered. Legacy records
 * without a `repoRoot` are skipped (we can't attribute them to this repo,
 * so we leave them alone rather than risk GC-ing another repo's run).
 * `running` runs are always skipped — only terminal runs are eligible.
 *
 * Set either env var to `off` / `never` to disable that window.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_REVIEWER_WORKTREE_TTL_MS = MS_PER_DAY;
const RUN_GC_YIELD_EVERY = 25;
const DEFAULT_ORPHAN_REPO_ROOT_GRACE_MS = 6 * 60 * 60 * 1000;
const ORPHAN_REPO_ROOT_MISSING_MARKER = '.repo-root-missing-at';

/** Convert a day count to ms; a negative count means "disabled" (Infinity). */
export function daysToMs(days: number): number {
  if (!Number.isFinite(days) || days < 0) return Number.POSITIVE_INFINITY;
  return Math.floor(days * MS_PER_DAY);
}

/**
 * Resolve a retention window to milliseconds with precedence
 * env > config.json > built-in default:
 *   - env (`CREW_*_TTL_DAYS`): `off`/`never`/negative → disabled
 *     (Infinity); a finite number → that many days; garbage → ignored,
 *     fall through to config.
 *   - configDays (from config.json, when a crewHome was supplied): a
 *     finite number → that many days; `-1` → disabled.
 *   - defaultDays: the built-in fallback.
 * `0` is honored throughout as "reclaim immediately once terminal".
 */
export function resolveTtlMs(
  envRaw: string | undefined,
  configDays: number | undefined,
  defaultDays: number,
  envName = 'GC TTL env override',
): number {
  if (envRaw !== undefined) {
    const trimmed = envRaw.trim().toLowerCase();
    if (trimmed === 'off' || trimmed === 'never') return Number.POSITIVE_INFINITY;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return daysToMs(parsed);
    warnOnce(`env-ttl:${envName}:${envRaw}`, () => {
      logger.warn(`${envName} is present but unparseable: ${envRaw}`);
    });
    // Garbage env value → fall through to config / default.
  }
  if (configDays !== undefined) return daysToMs(configDays);
  return daysToMs(defaultDays);
}

export function resolveWorktreeTtlMs(crewHome?: string): number {
  const configDays = crewHome !== undefined
    ? readConfigFile(crewHome).cleanup.worktreeTtlDays
    : undefined;
  return resolveTtlMs(
    process.env.CREW_WORKTREE_TTL_DAYS,
    configDays,
    DEFAULT_WORKTREE_TTL_DAYS,
    'CREW_WORKTREE_TTL_DAYS',
  );
}

export function resolveRunDirTtlMs(crewHome?: string): number {
  const configDays = crewHome !== undefined
    ? readConfigFile(crewHome).cleanup.runDirTtlDays
    : undefined;
  return resolveTtlMs(
    process.env.CREW_RUNDIR_TTL_DAYS,
    configDays,
    DEFAULT_RUNDIR_TTL_DAYS,
    'CREW_RUNDIR_TTL_DAYS',
  );
}

export function resolveCriteriaSetTtlMs(crewHome?: string): number {
  const configDays = crewHome !== undefined
    ? readConfigFile(crewHome).cleanup.criteriaSetTtlDays
    : undefined;
  return resolveTtlMs(
    process.env.CREW_CRITERIA_SET_TTL_DAYS,
    configDays,
    DEFAULT_CRITERIA_SET_TTL_DAYS,
    'CREW_CRITERIA_SET_TTL_DAYS',
  );
}

function resolveComparablePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Epoch-ms timestamp at which a run reached its terminal state. Prefers
 * `completedAt` (set by markTerminal/markMerged/markDiscarded), then the
 * last prompt's `completedAt` (markMergeConflict doesn't stamp the
 * top-level field), then `startedAt` as a last resort. Returns `undefined`
 * if nothing parses — such a run is skipped rather than GC'd on a guess.
 */
export function terminalAtMs(state: RunStateV1): number | undefined {
  const lastPrompt = state.prompts.length > 0
    ? state.prompts[state.prompts.length - 1]
    : undefined;
  const candidates = [state.completedAt, lastPrompt?.completedAt, state.startedAt];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const ms = Date.parse(candidate);
    if (Number.isFinite(ms)) return ms;
  }
  return undefined;
}

export type RunGcArgs = {
  crewHome: string;
  projectRoot: string;
  runStateStore: RunStateStore;
  worktreeManager: WorktreeManager;
  /** Injectable clock for tests; defaults to `Date.now()`. */
  now?: number;
  /** Injectable TTLs for tests; default to the env-resolved values. */
  worktreeTtlMs?: number;
  /**
   * Worktree TTL for disposable ephemeral_review snapshots. Defaults to 24h
   * when ordinary worktree GC is enabled; never lengthens a shorter ordinary
   * worktree TTL and leaves an explicitly disabled worktree window disabled.
   */
  reviewerWorktreeTtlMs?: number;
  runDirTtlMs?: number;
  criteriaSetTtlMs?: number;
  /** Boot-only state snapshots populated by the stale-run sweep. */
  bootStateCache?: ReadonlyMap<string, RunGcStateCacheEntry>;
  /**
   * Grace window after first observing a missing repoRoot before orphan
   * cleanup can delete anything. Protects transiently-unmounted volumes.
   */
  orphanRepoRootGraceMs?: number;
  /** Test seam: invoked by WorktreeManager after the per-run orphan cleanup lock is held. */
  onOrphanRunLockAcquired?: (runId: string) => void | Promise<void>;
  /** Test seams for proving the long directory walk yields. */
  yieldEveryEntries?: number;
  yieldToEventLoop?: () => Promise<void>;
  /**
   * When true, compute and return what WOULD be reclaimed without touching
   * the filesystem or git. Used by `crew-mcp cleanup --dry-run`.
   */
  dryRun?: boolean;
};

export interface RunGcStateCacheEntry {
  readonly mtimeMs: number;
  readonly state: RunStateV1;
}

/** What the GC did (or would do, under `dryRun`) to one run. */
export interface RunGcOutcome {
  readonly runId: string;
  readonly status: string;
  readonly ageDays: number;
  readonly worktreeReclaimed: boolean;
  readonly branchDeleted: boolean;
  readonly runDirDeleted: boolean;
  /**
   * Dry-run only: the run-dir is past its TTL but a worktree/owned-record must
   * be reclaimed first, so the real pass won't delete it THIS pass — it's
   * deferred to a later pass (and skipped entirely if that reclaim fails).
   * Distinguishes "will be deleted now" from "would be deleted eventually" so
   * the preview doesn't over-promise vs. the real run. Always false/undefined
   * for a real (non-dry) pass.
   */
  readonly runDirPending?: boolean;
}

export interface RunGcResult {
  /** Run-dirs whose state.json was read for this repo. */
  readonly scanned: number;
  readonly worktreesReclaimed: number;
  readonly branchesDeleted: number;
  readonly runDirsDeleted: number;
  /** Dry-run only: run-dirs past TTL but blocked behind a worktree reclaim. */
  readonly runDirsPending: number;
  readonly outcomes: readonly RunGcOutcome[];
}

/**
 * One-shot GC pass. Safe to run concurrently across the per-dispatch
 * sub-servers: each worktree removal takes the run lock, and only terminal
 * runs aged past a window are touched, so an in-flight run is never
 * disturbed. Best-effort throughout — a failure on one run logs and
 * continues so a single bad record can't stall the sweep.
 */
export async function gcTerminalRuns(args: RunGcArgs): Promise<RunGcResult> {
  const now = args.now ?? Date.now();
  const worktreeTtlMs = args.worktreeTtlMs ?? resolveWorktreeTtlMs(args.crewHome);
  const reviewerWorktreeTtlMs = args.reviewerWorktreeTtlMs
    ?? (worktreeTtlMs === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : Math.min(DEFAULT_REVIEWER_WORKTREE_TTL_MS, worktreeTtlMs));
  const runDirTtlMs = args.runDirTtlMs ?? resolveRunDirTtlMs(args.crewHome);
  const orphanRepoRootGraceMs = args.orphanRepoRootGraceMs ?? DEFAULT_ORPHAN_REPO_ROOT_GRACE_MS;
  const empty: RunGcResult = {
    scanned: 0,
    worktreesReclaimed: 0,
    branchesDeleted: 0,
    runDirsDeleted: 0,
    runDirsPending: 0,
    outcomes: [],
  };
  // All worktree/run-dir windows disabled → nothing to do.
  if (
    worktreeTtlMs === Number.POSITIVE_INFINITY
    && reviewerWorktreeTtlMs === Number.POSITIVE_INFINITY
    && runDirTtlMs === Number.POSITIVE_INFINITY
  ) {
    return empty;
  }

  const runsDir = join(args.crewHome, 'runs');
  if (!existsSync(runsDir)) return empty;
  const currentRepoRoot = resolveComparablePath(args.projectRoot);

  let entries: Dirent[];
  try {
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch (err) {
    logger.warn(
      `run GC: failed to read ${runsDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return empty;
  }

  const outcomes: RunGcOutcome[] = [];
  let scanned = 0;
  let visited = 0;
  const yieldEveryEntries = args.yieldEveryEntries ?? RUN_GC_YIELD_EVERY;
  const yieldToEventLoop = args.yieldToEventLoop ?? defaultYieldToEventLoop;

  for (const entry of entries) {
    visited += 1;
    if (yieldEveryEntries > 0 && visited % yieldEveryEntries === 0) {
      await yieldToEventLoop();
    }
    if (!entry.isDirectory()) continue;
    const runId = entry.name;
    if (runId === '.meta' || runId === '.locks') continue;
    let state: RunStateV1 | undefined;
    try {
      state = await readRunStateForGc(args, runsDir, runId);
    } catch (err) {
      logger.warn(
        `run GC: failed to read state for ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (!state) continue;
    scanned += 1;

    // Only terminal runs are eligible. Legacy records with no repoRoot can't
    // be attributed — leave them (user can discard manually).
    if (state.repoRoot === undefined) continue;
    const stateRepoRootExists = existsSync(state.repoRoot);
    const stateRepoRoot = stateRepoRootExists
      ? resolveComparablePath(state.repoRoot)
      : state.repoRoot;
    const isCurrentRepo = stateRepoRoot === currentRepoRoot;
    const missingRootMarkerPath = join(runsDir, runId, ORPHAN_REPO_ROOT_MISSING_MARKER);
    if (stateRepoRootExists) {
      clearMissingRepoRootMarker(missingRootMarkerPath);
    }
    if (state.status === 'running') {
      if (!isCurrentRepo) args.runStateStore.dropParsedStateCache(runId);
      continue;
    }

    const terminalMs = terminalAtMs(state);
    if (terminalMs === undefined) continue;
    const ageMs = now - terminalMs;
    if (!Number.isFinite(ageMs) || ageMs < 0) continue;

    const effectiveWorktreeTtlMs = runModeFromState(state) === 'ephemeral_review'
      ? reviewerWorktreeTtlMs
      : worktreeTtlMs;
    const pastWorktreeTtl = ageMs >= effectiveWorktreeTtlMs;
    const deleteRunDir = ageMs >= runDirTtlMs;
    if (!pastWorktreeTtl && !deleteRunDir) continue;

    if (!isCurrentRepo) {
      args.runStateStore.dropParsedStateCache(runId);
      if (!stateRepoRootExists) {
        const worktreePath = join(runsDir, runId, 'worktree');
        const hasWorktree = existsSync(worktreePath);
        const statusOrModeAllowsReclaim = isOrphanReclaimAllowed(state);
        const presentWorktreeReclaimSafe = worktreePresentReclaimSafe(state);
        // T4-1 protects every potentially-continuable write run while its
        // worktree exists: success, partial, cancelled, error, and
        // merge_conflict may hold the only copy of uncommitted work. Only an
        // explicitly safe disposition may remove a present worktree. Once no
        // worktree exists, any terminal mode can age out at the run-dir TTL.
        const worktreeLessRunDirReclaim = deleteRunDir && !hasWorktree;
        if (!statusOrModeAllowsReclaim && !worktreeLessRunDirReclaim) {
          continue;
        }

        const missingSinceMs = readOrStartMissingRepoRootGrace({
          markerPath: missingRootMarkerPath,
          now,
          dryRun: args.dryRun === true,
        });
        if (missingSinceMs === undefined || now - missingSinceMs < orphanRepoRootGraceMs) {
          continue;
        }
        if (hasWorktree && !presentWorktreeReclaimSafe) {
          continue;
        }

        let hasOwnedRecord: boolean;
        try {
          hasOwnedRecord = args.worktreeManager.hasOwnedRunWorktreeRecord(runId);
        } catch (err) {
          logger.warn(
            `run GC: failed to read orphaned worktree metadata for ${runId}: ${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }
        const shouldReclaimWorktree = (hasOwnedRecord || hasWorktree) && (pastWorktreeTtl || deleteRunDir);
        if (!shouldReclaimWorktree && !deleteRunDir) continue;

        if (args.dryRun) {
          outcomes.push({
            runId,
            status: state.status,
            ageDays: Math.floor(ageMs / MS_PER_DAY),
            worktreeReclaimed: shouldReclaimWorktree,
            branchDeleted: false,
            runDirDeleted: deleteRunDir,
            runDirPending: false,
          });
          continue;
        }

        let worktreeReclaimed = false;
        let runDirDeleted = false;
        try {
          await args.worktreeManager.withRunWorktreeLock(runId, async () => {
            await args.onOrphanRunLockAcquired?.(runId);

            const fresh = freshOrphanEligibility({
              args,
              runId,
              now,
              runsDir,
              worktreeTtlMs,
              reviewerWorktreeTtlMs,
              runDirTtlMs,
            });
            if (!fresh?.eligible) return;

            let cleanupSucceeded = true;
            if (fresh.shouldReclaimWorktree) {
              const cleanup = await args.worktreeManager.cleanupOrphanedRunWorktree(runId, {
                lockAlreadyHeld: true,
              });
              worktreeReclaimed = cleanup.worktreeRemoved || cleanup.recordDeleted;
              cleanupSucceeded = cleanup.success;
              if (!cleanup.success) {
                logger.warn(
                  `run GC: orphaned worktree reclaim incomplete for ${runId}: ${cleanup.errors.join('; ')}`,
                );
              }
            }
            if (!cleanupSucceeded) return;

            // Still under the run lock: continuation cannot append a prompt
            // between this final fresh read and deletion. Re-check every
            // destructive eligibility input because cleanup may have yielded.
            const final = freshOrphanEligibility({
              args,
              runId,
              now,
              runsDir,
              worktreeTtlMs,
              reviewerWorktreeTtlMs,
              runDirTtlMs,
            });
            if (
              !final?.deleteRunDir
              || existsSync(worktreePath)
              || args.worktreeManager.hasOwnedRunWorktreeRecord(runId)
            ) {
              return;
            }
            rmSync(missingRootMarkerPath, { force: true });
            args.runStateStore.deleteRunDir(runId);
            runDirDeleted = true;
          });
        } catch (err) {
          logger.warn(
            `run GC: orphaned reclaim failed for ${runId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        outcomes.push({
          runId,
          status: state.status,
          ageDays: Math.floor(ageMs / MS_PER_DAY),
          worktreeReclaimed,
          branchDeleted: false,
          runDirDeleted,
        });
      }
      continue;
    }

    // Reclaim is driven by the owned metadata record, not just the physical
    // checkout path. cleanupByRunId can remove the checkout and then fail
    // branch deletion; in that state the next pass must still retry from the
    // .meta record instead of deleting the run-dir and stranding the branch.
    const worktreePath = join(runsDir, runId, 'worktree');
    let hasOwnedRecord: boolean;
    try {
      hasOwnedRecord = args.worktreeManager.hasOwnedRunWorktreeRecord(runId);
    } catch (err) {
      logger.warn(
        `run GC: failed to read worktree metadata for ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    const hasWorktree = existsSync(worktreePath);
    const shouldReclaimWorktree = (hasOwnedRecord || hasWorktree) && (pastWorktreeTtl || deleteRunDir);
    if (!shouldReclaimWorktree && !deleteRunDir) continue;

    if (args.dryRun) {
      const worktreeReclaimed = shouldReclaimWorktree;
      // Mirror the real pass's run-dir gate: it deletes the run-dir only once
      // nothing remains to reclaim. When a worktree/owned-record must be
      // reclaimed first, the real pass defers run-dir deletion to a later pass
      // (and skips it if reclaim fails), so don't promise deletion now —
      // surface it as pending instead.
      const runDirDeletedNow = deleteRunDir && !shouldReclaimWorktree;
      const runDirPending = deleteRunDir && shouldReclaimWorktree;
      outcomes.push({
        runId,
        status: state.status,
        ageDays: Math.floor(ageMs / (24 * 60 * 60 * 1000)),
        worktreeReclaimed,
        branchDeleted:
          worktreeReclaimed && (state.status === 'merged' || state.status === 'discarded'),
        runDirDeleted: runDirDeletedNow,
        runDirPending,
      });
      continue;
    }

    let worktreeReclaimed = false;
    let branchDeleted = false;
    if (shouldReclaimWorktree) {
      // Keep the branch for everything except merged runs (already landed)
      // and discarded runs (explicitly abandoned by the user).
      try {
        const cleanup = await args.worktreeManager.cleanupByRunId(runId, {
          keepBranch: state.status !== 'merged' && state.status !== 'discarded',
        });
        worktreeReclaimed = cleanup.worktreeRemoved;
        branchDeleted =
          (state.status === 'merged' || state.status === 'discarded')
          && cleanup.branchDeleted;
        if (!cleanup.success) {
          logger.warn(
            `run GC: worktree reclaim incomplete for ${runId}: ${cleanup.errors.join('; ')}`,
          );
        }
        if (cleanup.hadRecord && !cleanup.recordDeleted) {
          logger.warn(
            `run GC: owned worktree metadata retained for ${runId}; retrying on a later pass`,
          );
        }
      } catch (err) {
        logger.warn(
          `run GC: worktree reclaim failed for ${runId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    let ownedRecordRemaining = hasOwnedRecord;
    try {
      ownedRecordRemaining = args.worktreeManager.hasOwnedRunWorktreeRecord(runId);
    } catch (err) {
      logger.warn(
        `run GC: failed to re-read worktree metadata for ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      ownedRecordRemaining = true;
    }
    const worktreeRemaining = existsSync(worktreePath);

    let runDirDeleted = false;
    if (deleteRunDir && !ownedRecordRemaining && !worktreeRemaining) {
      try {
        args.runStateStore.deleteRunDir(runId);
        runDirDeleted = true;
      } catch (err) {
        logger.warn(
          `run GC: failed to delete run-dir for ${runId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else if (deleteRunDir && (ownedRecordRemaining || worktreeRemaining)) {
      if (ownedRecordRemaining) {
        logger.warn(
          `run GC: keeping run-dir for ${runId}; owned worktree metadata still requires cleanup`,
        );
      }
      if (worktreeRemaining) {
        logger.warn(
          `run GC: keeping run-dir for ${runId}; worktree directory still exists`,
        );
      }
    }

    outcomes.push({
      runId,
      status: state.status,
      ageDays: Math.floor(ageMs / (24 * 60 * 60 * 1000)),
      worktreeReclaimed,
      branchDeleted,
      runDirDeleted,
    });
  }

  return {
    scanned,
    worktreesReclaimed: outcomes.filter((o) => o.worktreeReclaimed).length,
    branchesDeleted: outcomes.filter((o) => o.branchDeleted).length,
    runDirsDeleted: outcomes.filter((o) => o.runDirDeleted).length,
    runDirsPending: outcomes.filter((o) => o.runDirPending).length,
    outcomes,
  };
}

function isOrphanReclaimAllowed(state: RunStateV1): boolean {
  const runMode = runModeFromState(state);
  if (runMode === 'read_only' || runMode === 'ephemeral_review') return true;
  return state.status === 'merged'
    || state.status === 'discarded'
    || state.status === 'cancelled'
    || state.status === 'error';
}

function worktreePresentReclaimSafe(state: RunStateV1): boolean {
  return runModeFromState(state) === 'ephemeral_review'
    || state.status === 'merged'
    || state.status === 'discarded';
}

function freshOrphanEligibility(args: {
  readonly args: RunGcArgs;
  readonly runId: string;
  readonly now: number;
  readonly runsDir: string;
  readonly worktreeTtlMs: number;
  readonly reviewerWorktreeTtlMs: number;
  readonly runDirTtlMs: number;
}): {
  readonly eligible: boolean;
  readonly shouldReclaimWorktree: boolean;
  readonly deleteRunDir: boolean;
} | undefined {
  const state = args.args.runStateStore.read(args.runId);
  if (
    state === undefined
    || state.status === 'running'
    || state.repoRoot === undefined
    || existsSync(state.repoRoot)
  ) {
    return undefined;
  }
  const terminalMs = terminalAtMs(state);
  if (terminalMs === undefined) return undefined;
  const ageMs = args.now - terminalMs;
  if (!Number.isFinite(ageMs) || ageMs < 0) return undefined;

  const effectiveWorktreeTtlMs = runModeFromState(state) === 'ephemeral_review'
    ? args.reviewerWorktreeTtlMs
    : args.worktreeTtlMs;
  const pastWorktreeTtl = ageMs >= effectiveWorktreeTtlMs;
  const deleteRunDir = ageMs >= args.runDirTtlMs;
  if (!pastWorktreeTtl && !deleteRunDir) return undefined;

  const worktreePath = join(args.runsDir, args.runId, 'worktree');
  const hasWorktree = existsSync(worktreePath);
  const hasOwnedRecord = args.args.worktreeManager.hasOwnedRunWorktreeRecord(args.runId);
  const worktreeLessRunDirReclaim = deleteRunDir && !hasWorktree;
  const eligible = (!hasWorktree || worktreePresentReclaimSafe(state))
    && (isOrphanReclaimAllowed(state) || worktreeLessRunDirReclaim);
  return {
    eligible,
    shouldReclaimWorktree:
      eligible && (hasOwnedRecord || hasWorktree) && (pastWorktreeTtl || deleteRunDir),
    deleteRunDir: eligible && deleteRunDir,
  };
}

async function readRunStateForGc(
  args: RunGcArgs,
  runsDir: string,
  runId: string,
): Promise<RunStateV1 | undefined> {
  const cached = args.bootStateCache?.get(runId);
  if (cached) {
    try {
      const current = await stat(join(runsDir, runId, 'state.json'));
      if (current.mtimeMs === cached.mtimeMs) return cached.state;
    } catch (err) {
      if (isEnoent(err)) return undefined;
      throw err;
    }
  }
  return args.runStateStore.read(runId);
}

function defaultYieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

function readOrStartMissingRepoRootGrace(args: {
  readonly markerPath: string;
  readonly now: number;
  readonly dryRun: boolean;
}): number | undefined {
  try {
    const raw = readFileSync(args.markerPath, 'utf-8').trim();
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  } catch {
    // Missing/unreadable marker: start the grace window below.
  }
  if (!args.dryRun) {
    try {
      writeFileSync(args.markerPath, `${args.now}\n`, 'utf-8');
    } catch (err) {
      logger.warn(
        `run GC: failed to write missing-repo-root grace marker ${args.markerPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return args.now;
}

function clearMissingRepoRootMarker(markerPath: string): void {
  try {
    rmSync(markerPath, { force: true });
  } catch {
    // Marker cleanup is opportunistic; a stale marker only matters if the
    // repo later disappears, when the grace gate will re-check it.
  }
}

export interface CrewGcResult extends RunGcResult {
  readonly criteriaSetsDeleted: number;
  readonly panelStatesDeleted: number;
}

export async function gcTerminalRunsAndCriteriaSets(args: RunGcArgs): Promise<CrewGcResult> {
  const runResult = await gcTerminalRuns(args);
  const criteriaSetTtlMs = args.criteriaSetTtlMs ?? resolveCriteriaSetTtlMs(args.crewHome);
  const criteriaSetsDeleted = args.dryRun
    ? 0
    : gcCriteriaSets(args.crewHome, criteriaSetTtlMs, args.now);
  const panelStatesDeleted = args.dryRun
    ? 0
    : gcPanelStates(args.crewHome, criteriaSetTtlMs, args.now);
  return {
    ...runResult,
    criteriaSetsDeleted,
    panelStatesDeleted,
  };
}
