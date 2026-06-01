import { readdirSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { logger } from '../utils/logger.js';
import {
  DEFAULT_WORKTREE_TTL_DAYS,
  DEFAULT_RUNDIR_TTL_DAYS,
  readConfigFile,
} from '../utils/config-store.js';
import type { RunStateStore, RunStateV1 } from './run-state.js';
import type { WorktreeManager } from '../git/worktree.js';

/**
 * Garbage-collect terminal crew runs so worktrees and run-dirs don't
 * accumulate unbounded under `<crewHome>/runs/`. Two independent retention
 * windows, both measured from when the run reached a terminal state:
 *
 *   1. Worktree TTL (`CREW_WORKTREE_TTL_DAYS`, default 7) — once a terminal
 *      run is older than this, its worktree directory is removed. The
 *      `crew-run/*` branch is KEPT (so any unmerged commits survive as a
 *      recoverable ref) EXCEPT for `merged` runs, whose branch is also
 *      deleted because the commits already live in the merge target.
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
): number {
  if (envRaw !== undefined) {
    const trimmed = envRaw.trim().toLowerCase();
    if (trimmed === 'off' || trimmed === 'never') return Number.POSITIVE_INFINITY;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return daysToMs(parsed);
    // Garbage env value → fall through to config / default.
  }
  if (configDays !== undefined) return daysToMs(configDays);
  return daysToMs(defaultDays);
}

export function resolveWorktreeTtlMs(crewHome?: string): number {
  const configDays = crewHome !== undefined
    ? readConfigFile(crewHome).cleanup.worktreeTtlDays
    : undefined;
  return resolveTtlMs(process.env.CREW_WORKTREE_TTL_DAYS, configDays, DEFAULT_WORKTREE_TTL_DAYS);
}

export function resolveRunDirTtlMs(crewHome?: string): number {
  const configDays = crewHome !== undefined
    ? readConfigFile(crewHome).cleanup.runDirTtlDays
    : undefined;
  return resolveTtlMs(process.env.CREW_RUNDIR_TTL_DAYS, configDays, DEFAULT_RUNDIR_TTL_DAYS);
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
  runDirTtlMs?: number;
  /**
   * When true, compute and return what WOULD be reclaimed without touching
   * the filesystem or git. Used by `crew-mcp cleanup --dry-run`.
   */
  dryRun?: boolean;
};

/** What the GC did (or would do, under `dryRun`) to one run. */
export interface RunGcOutcome {
  readonly runId: string;
  readonly status: string;
  readonly ageDays: number;
  readonly worktreeReclaimed: boolean;
  readonly branchDeleted: boolean;
  readonly runDirDeleted: boolean;
}

export interface RunGcResult {
  /** Run-dirs whose state.json was read for this repo. */
  readonly scanned: number;
  readonly worktreesReclaimed: number;
  readonly branchesDeleted: number;
  readonly runDirsDeleted: number;
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
  const runDirTtlMs = args.runDirTtlMs ?? resolveRunDirTtlMs(args.crewHome);
  const empty: RunGcResult = {
    scanned: 0,
    worktreesReclaimed: 0,
    branchesDeleted: 0,
    runDirsDeleted: 0,
    outcomes: [],
  };
  // Both windows disabled → nothing to do.
  if (worktreeTtlMs === Number.POSITIVE_INFINITY && runDirTtlMs === Number.POSITIVE_INFINITY) {
    return empty;
  }

  const runsDir = join(args.crewHome, 'runs');
  if (!existsSync(runsDir)) return empty;
  const currentRepoRoot = resolveComparablePath(args.projectRoot);

  let entries;
  try {
    entries = readdirSync(runsDir, { withFileTypes: true });
  } catch (err) {
    logger.warn(
      `run GC: failed to read ${runsDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return empty;
  }

  const outcomes: RunGcOutcome[] = [];
  let scanned = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runId = entry.name;
    if (runId === '.meta' || runId === '.locks') continue;
    const statePath = join(runsDir, runId, 'state.json');
    if (!existsSync(statePath)) continue;

    let state: RunStateV1;
    try {
      state = JSON.parse(readFileSync(statePath, 'utf-8')) as RunStateV1;
    } catch (err) {
      logger.warn(
        `run GC: failed to read state for ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    scanned += 1;

    // Only terminal runs of THIS repo are eligible. Legacy records with no
    // repoRoot can't be attributed — leave them (user can discard manually).
    if (state.status === 'running') continue;
    if (state.repoRoot === undefined) continue;
    if (resolveComparablePath(state.repoRoot) !== currentRepoRoot) continue;

    const terminalMs = terminalAtMs(state);
    if (terminalMs === undefined) continue;
    const ageMs = now - terminalMs;
    if (!Number.isFinite(ageMs) || ageMs < 0) continue;

    const pastWorktreeTtl = ageMs >= worktreeTtlMs;
    const deleteRunDir = ageMs >= runDirTtlMs;
    if (!pastWorktreeTtl && !deleteRunDir) continue;

    // A worktree is reclaimable only if its checkout is actually on disk —
    // otherwise this run is past the window but has nothing to do (e.g.
    // already merged + cleaned). We also git-remove a residual worktree
    // whenever we're about to delete the run-dir, so an `rmSync` can never
    // leave an orphaned git worktree registration behind.
    const hasWorktree = existsSync(join(runsDir, runId, 'worktree'));
    const worktreeReclaimed = hasWorktree && (pastWorktreeTtl || deleteRunDir);
    if (!worktreeReclaimed && !deleteRunDir) continue;

    const branchDeleted = worktreeReclaimed && state.status === 'merged';

    outcomes.push({
      runId,
      status: state.status,
      ageDays: Math.floor(ageMs / (24 * 60 * 60 * 1000)),
      worktreeReclaimed,
      branchDeleted,
      runDirDeleted: deleteRunDir,
    });

    if (args.dryRun) continue;

    if (worktreeReclaimed) {
      // Keep the branch for everything except merged runs, whose commits
      // are already in the merge target.
      try {
        await args.worktreeManager.cleanupByRunId(runId, {
          keepBranch: state.status !== 'merged',
        });
      } catch (err) {
        logger.warn(
          `run GC: worktree reclaim failed for ${runId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (deleteRunDir) {
      try {
        args.runStateStore.deleteRunDir(runId);
      } catch (err) {
        logger.warn(
          `run GC: failed to delete run-dir for ${runId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  return {
    scanned,
    worktreesReclaimed: outcomes.filter((o) => o.worktreeReclaimed).length,
    branchesDeleted: outcomes.filter((o) => o.branchDeleted).length,
    runDirsDeleted: outcomes.filter((o) => o.runDirDeleted).length,
    outcomes,
  };
}
