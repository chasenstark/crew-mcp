/**
 * `crew-mcp cleanup` — run the terminal-run garbage collector on demand.
 *
 * The same GC that runs at server startup (`gcTerminalRuns`), exposed as a
 * command so users don't have to wait for a restart. Operates on the
 * current repo by default; `--all-repos` sweeps every repo represented in
 * `~/.crew/runs/`. `--dry-run` reports what would be reclaimed without
 * touching anything. TTL flags override the env/config windows for this
 * invocation only.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { WorktreeManager } from '../../git/worktree.js';
import { RunStateStore, type RunStateV1 } from '../../orchestrator/run-state.js';
import {
  daysToMs,
  gcTerminalRuns,
  resolveCriteriaSetTtlMs,
  resolveRunDirTtlMs,
  resolveWorktreeTtlMs,
  type RunGcOutcome,
} from '../../orchestrator/run-gc.js';
import { gcCriteriaSets } from '../../orchestrator/criteria/store.js';
import { resolveCrewHome } from '../../utils/crew-home.js';

export interface CleanupCommandOptions {
  readonly cwd?: string;
  readonly crewHome?: string;
  readonly dryRun?: boolean;
  readonly allRepos?: boolean;
  /** Override the worktree retention window (days; -1 = off). */
  readonly worktreeTtlDays?: number;
  /** Override the run-dir retention window (days; -1 = off). */
  readonly runDirTtlDays?: number;
  /** Override the criteria-set retention window (days; -1 = off). */
  readonly criteriaSetTtlDays?: number;
  /** Test seam. */
  readonly stdout?: NodeJS.WriteStream;
  /** Test seam — fixed clock. */
  readonly now?: number;
}

function fmtTtl(ms: number): string {
  if (!Number.isFinite(ms)) return 'off';
  return `${Math.round(ms / (24 * 60 * 60 * 1000))}d`;
}

/**
 * Distinct, on-disk repo roots referenced by run states under
 * `<crewHome>/runs/`. Used by `--all-repos` so we run a repo-bound
 * WorktreeManager (git worktree remove must run from the owning repo) for
 * each repo that still exists.
 */
function discoverRepoRoots(crewHome: string): string[] {
  const runsDir = join(crewHome, 'runs');
  if (!existsSync(runsDir)) return [];
  const roots = new Set<string>();
  let entries;
  try {
    entries = readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.meta' || entry.name === '.locks') continue;
    const statePath = join(runsDir, entry.name, 'state.json');
    if (!existsSync(statePath)) continue;
    try {
      const state = JSON.parse(readFileSync(statePath, 'utf-8')) as RunStateV1;
      if (typeof state.repoRoot === 'string' && existsSync(state.repoRoot)) {
        roots.add(state.repoRoot);
      }
    } catch {
      // Skip unreadable state; the GC's own pass logs these.
    }
  }
  return [...roots];
}

export async function cleanupCommand(opts: CleanupCommandOptions = {}): Promise<number> {
  const stdout = opts.stdout ?? process.stdout;
  const cwd = opts.cwd ?? process.cwd();
  const crewHome = opts.crewHome ?? resolveCrewHome();

  // CLI flags win over env/config for this run; otherwise resolve the
  // effective windows (env > config.json > default).
  const worktreeTtlMs = opts.worktreeTtlDays !== undefined
    ? daysToMs(opts.worktreeTtlDays)
    : resolveWorktreeTtlMs(crewHome);
  const runDirTtlMs = opts.runDirTtlDays !== undefined
    ? daysToMs(opts.runDirTtlDays)
    : resolveRunDirTtlMs(crewHome);
  const criteriaSetTtlMs = opts.criteriaSetTtlDays !== undefined
    ? daysToMs(opts.criteriaSetTtlDays)
    : resolveCriteriaSetTtlMs(crewHome);

  const repoRoots = opts.allRepos ? discoverRepoRoots(crewHome) : [cwd];

  stdout.write(
    `crew cleanup${opts.dryRun ? ' (dry run)' : ''}: `
    + `worktree TTL ${fmtTtl(worktreeTtlMs)}, run-dir TTL ${fmtTtl(runDirTtlMs)}, `
    + `criteria-set TTL ${fmtTtl(criteriaSetTtlMs)}, `
    + `${opts.allRepos ? `${repoRoots.length} repo(s)` : 'current repo'}\n`,
  );

  const totals = {
    worktreesReclaimed: 0,
    branchesDeleted: 0,
    runDirsDeleted: 0,
    runDirsPending: 0,
    criteriaSetsDeleted: 0,
  };
  const allOutcomes: RunGcOutcome[] = [];

  for (const repoRoot of repoRoots) {
    const worktreeManager = new WorktreeManager({ projectRoot: repoRoot, crewHome });
    const runStateStore = new RunStateStore({ crewHome, repoRoot });
    const result = await gcTerminalRuns({
      crewHome,
      projectRoot: repoRoot,
      runStateStore,
      worktreeManager,
      worktreeTtlMs,
      runDirTtlMs,
      dryRun: opts.dryRun,
      now: opts.now,
    });
    totals.worktreesReclaimed += result.worktreesReclaimed;
    totals.branchesDeleted += result.branchesDeleted;
    totals.runDirsDeleted += result.runDirsDeleted;
    totals.runDirsPending += result.runDirsPending;
    allOutcomes.push(...result.outcomes);
  }
  if (!opts.dryRun) {
    totals.criteriaSetsDeleted = gcCriteriaSets(crewHome, criteriaSetTtlMs, opts.now);
  }

  if (opts.dryRun && allOutcomes.length > 0) {
    stdout.write('\nWould reclaim:\n');
    for (const o of allOutcomes) {
      const acts = [
        o.worktreeReclaimed ? 'worktree' : null,
        o.branchDeleted ? 'branch' : null,
        o.runDirDeleted ? 'run-dir' : (o.runDirPending ? 'run-dir (after worktree reclaim)' : null),
      ].filter(Boolean).join(' + ');
      stdout.write(`  ${o.runId.slice(0, 8)}  ${o.status.padEnd(14)}  ${o.ageDays}d old  → ${acts}\n`);
    }
  }

  if (opts.dryRun) {
    stdout.write(
      `\nWould reclaim: ${totals.worktreesReclaimed} worktree(s)`
      + ` (${totals.branchesDeleted} merged branch(es) deleted), `
      + `${totals.runDirsDeleted} run-dir(s) now, `
      + `${totals.criteriaSetsDeleted} criteria set(s).\n`,
    );
    if (totals.runDirsPending > 0) {
      stdout.write(
        `  (${totals.runDirsPending} more run-dir(s) past TTL but pending worktree reclaim —`
        + ` deleted on a later pass once the worktree is gone.)\n`,
      );
    }
  } else {
    stdout.write(
      `\nReclaimed: ${totals.worktreesReclaimed} worktree(s)`
      + ` (${totals.branchesDeleted} merged branch(es) deleted), `
      + `${totals.runDirsDeleted} run-dir(s) deleted, `
      + `${totals.criteriaSetsDeleted} criteria set(s) deleted.\n`,
    );
    if (
      totals.worktreesReclaimed > 0
      || totals.runDirsDeleted > 0
      || totals.criteriaSetsDeleted > 0
    ) {
      stdout.write('Tip: run `du -sh ~/.crew` to see reclaimed disk.\n');
    }
  }
  return 0;
}
