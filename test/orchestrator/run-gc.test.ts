/**
 * Run GC: terminal runs age out of `<crewHome>/runs/` on two independent
 * windows — worktree reclaim (keeps the branch, except for merged runs) and
 * full run-dir deletion. Uses a real git repo + WorktreeManager so the
 * assertions are about the actual on-disk + git-ref state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { WorktreeManager } from '../../src/git/worktree.js';
import { RunStateStore } from '../../src/orchestrator/run-state.js';
import {
  gcTerminalRuns,
  resolveRunDirTtlMs,
  resolveTtlMs,
  resolveWorktreeTtlMs,
  terminalAtMs,
} from '../../src/orchestrator/run-gc.js';
import { logger } from '../../src/utils/logger.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-01-01T00:00:00.000Z');

describe('resolveTtlMs', () => {
  it('env wins: parses day counts to ms', () => {
    expect(resolveTtlMs('7', undefined, 30)).toBe(7 * DAY_MS);
    expect(resolveTtlMs('0', undefined, 30)).toBe(0);
    expect(resolveTtlMs('5', 14, 30)).toBe(5 * DAY_MS); // env beats config
  });
  it('treats off/never/negative as disabled (Infinity)', () => {
    expect(resolveTtlMs('off', undefined, 30)).toBe(Number.POSITIVE_INFINITY);
    expect(resolveTtlMs('NEVER', undefined, 30)).toBe(Number.POSITIVE_INFINITY);
    expect(resolveTtlMs('-1', undefined, 30)).toBe(Number.POSITIVE_INFINITY);
  });
  it('falls through to config when env is unset or garbage', () => {
    expect(resolveTtlMs(undefined, 14, 30)).toBe(14 * DAY_MS);
    expect(resolveTtlMs('banana', 14, 30)).toBe(14 * DAY_MS);
    expect(resolveTtlMs(undefined, -1, 30)).toBe(Number.POSITIVE_INFINITY);
  });
  it('warns once per invalid env override name', () => {
    const priorWorktree = process.env.CREW_WORKTREE_TTL_DAYS;
    const priorRunDir = process.env.CREW_RUNDIR_TTL_DAYS;
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      process.env.CREW_WORKTREE_TTL_DAYS = 'banana';
      process.env.CREW_RUNDIR_TTL_DAYS = 'banana';
      resolveWorktreeTtlMs();
      resolveWorktreeTtlMs();
      resolveRunDirTtlMs();

      expect(warn.mock.calls.filter(([message]) =>
        typeof message === 'string' && message.includes('CREW_WORKTREE_TTL_DAYS'))).toHaveLength(1);
      expect(warn.mock.calls.filter(([message]) =>
        typeof message === 'string' && message.includes('CREW_RUNDIR_TTL_DAYS'))).toHaveLength(1);
    } finally {
      warn.mockRestore();
      if (priorWorktree === undefined) delete process.env.CREW_WORKTREE_TTL_DAYS;
      else process.env.CREW_WORKTREE_TTL_DAYS = priorWorktree;
      if (priorRunDir === undefined) delete process.env.CREW_RUNDIR_TTL_DAYS;
      else process.env.CREW_RUNDIR_TTL_DAYS = priorRunDir;
    }
  });
  it('falls back to the default when neither env nor config is set', () => {
    expect(resolveTtlMs(undefined, undefined, 30)).toBe(30 * DAY_MS);
  });
});

describe('terminalAtMs', () => {
  const base = {
    schemaVersion: 1 as const,
    runId: 'r',
    agentId: 'a',
    worktreePath: '/x',
    filesChanged: [],
  };
  it('prefers completedAt', () => {
    expect(
      terminalAtMs({
        ...base,
        status: 'success',
        startedAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-02T00:00:00.000Z',
        prompts: [],
      }),
    ).toBe(Date.parse('2026-01-02T00:00:00.000Z'));
  });
  it('falls back to last prompt completedAt then startedAt', () => {
    expect(
      terminalAtMs({
        ...base,
        status: 'merge_conflict',
        startedAt: '2026-01-01T00:00:00.000Z',
        prompts: [{ turn: 1, prompt: 'go', startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-03T00:00:00.000Z' }],
      }),
    ).toBe(Date.parse('2026-01-03T00:00:00.000Z'));
    expect(
      terminalAtMs({
        ...base,
        status: 'error',
        startedAt: '2026-01-01T00:00:00.000Z',
        prompts: [],
      }),
    ).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
  });
});

describe('gcTerminalRuns', () => {
  let repoRoot: string;
  let otherRoot: string;
  let crewHome: string;
  let manager: WorktreeManager;
  let store: RunStateStore;

  const gitInit = (root: string): void => {
    execSync('git init -q', { cwd: root });
    execSync('git config user.email test@crew.local', { cwd: root });
    execSync('git config user.name test', { cwd: root });
    writeFileSync(join(root, 'README.md'), 'init\n', 'utf-8');
    execSync('git add README.md', { cwd: root });
    execSync('git commit -q -m init', { cwd: root });
  };

  /** Allocate a real worktree+branch, then stamp a matching state.json. */
  const seedRun = async (
    runId: string,
    state: { status: string; repoRoot: string; completedAt?: string },
  ): Promise<string> => {
    await manager.createRunWorktree(runId);
    const dir = join(crewHome, 'runs', runId);
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({
        schemaVersion: 1,
        runId,
        agentId: 'mock',
        status: state.status,
        startedAt: '2026-01-01T00:00:00.000Z',
        completedAt: state.completedAt,
        worktreePath: join(dir, 'worktree'),
        repoRoot: state.repoRoot,
        prompts: [{ turn: 1, prompt: 'go', startedAt: '2026-01-01T00:00:00.000Z', completedAt: state.completedAt }],
        filesChanged: [],
      }, null, 2),
      'utf-8',
    );
    // Branch name lives in the worktree meta record.
    const meta = JSON.parse(
      readFileSync(join(crewHome, 'runs', '.meta', `${runId}.json`), 'utf-8'),
    ) as { branchName: string };
    return meta.branchName;
  };

  const branchExists = (branch: string): boolean =>
    execSync(`git branch --list ${branch}`, { cwd: repoRoot, encoding: 'utf-8' }).trim().length > 0;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'crew-gc-repo-'));
    otherRoot = mkdtempSync(join(tmpdir(), 'crew-gc-other-'));
    crewHome = mkdtempSync(join(tmpdir(), 'crew-gc-home-'));
    gitInit(repoRoot);
    gitInit(otherRoot);
    manager = new WorktreeManager({ projectRoot: repoRoot, crewHome });
    store = new RunStateStore({ crewHome, repoRoot });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(otherRoot, { recursive: true, force: true });
    rmSync(crewHome, { recursive: true, force: true });
  });

  const wtPath = (runId: string): string => join(crewHome, 'runs', runId, 'worktree');
  const statePath = (runId: string): string => join(crewHome, 'runs', runId, 'state.json');
  const metaPath = (runId: string): string => join(crewHome, 'runs', '.meta', `${runId}.json`);

  it('reclaims worktree past the worktree TTL, keeps the branch and run-dir', async () => {
    const branch = await seedRun('aaaaaaaa-0000-0000-0000-000000000001', {
      status: 'success',
      repoRoot,
      completedAt: '2026-01-01T00:00:00.000Z',
    });
    const runId = 'aaaaaaaa-0000-0000-0000-000000000001';
    expect(existsSync(wtPath(runId))).toBe(true);

    await gcTerminalRuns({
      crewHome,
      projectRoot: repoRoot,
      runStateStore: store,
      worktreeManager: manager,
      now: T0 + 8 * DAY_MS,
      worktreeTtlMs: 7 * DAY_MS,
      runDirTtlMs: 30 * DAY_MS,
    });

    expect(existsSync(wtPath(runId))).toBe(false); // worktree gone
    expect(existsSync(statePath(runId))).toBe(true); // run-dir/state kept
    expect(existsSync(join(crewHome, 'runs', '.meta', `${runId}.json`))).toBe(false);
    expect(branchExists(branch)).toBe(true); // branch preserved
  });

  it('deletes the whole run-dir past the run-dir TTL', async () => {
    const runId = 'aaaaaaaa-0000-0000-0000-000000000002';
    await seedRun(runId, { status: 'success', repoRoot, completedAt: '2026-01-01T00:00:00.000Z' });

    await gcTerminalRuns({
      crewHome,
      projectRoot: repoRoot,
      runStateStore: store,
      worktreeManager: manager,
      now: T0 + 31 * DAY_MS,
      worktreeTtlMs: 7 * DAY_MS,
      runDirTtlMs: 30 * DAY_MS,
    });

    expect(existsSync(join(crewHome, 'runs', runId))).toBe(false);
  });

  it('dry-run marks a run-dir blocked behind a worktree reclaim as pending, not deleted', async () => {
    // A run past BOTH windows that still owns a worktree: the real pass must
    // reclaim the worktree first and only delete the run-dir once it is gone.
    // The dry-run preview must NOT promise the run-dir deletion outright (the
    // optimistic "runDirDeleted: deleteRunDir" bug) — it surfaces it as
    // pending so the forecast matches what the real pass can do this pass.
    const runId = 'aaaaaaaa-0000-0000-0000-00000000002a';
    await seedRun(runId, { status: 'success', repoRoot, completedAt: '2026-01-01T00:00:00.000Z' });

    const dry = await gcTerminalRuns({
      crewHome,
      projectRoot: repoRoot,
      runStateStore: store,
      worktreeManager: manager,
      now: T0 + 31 * DAY_MS,
      worktreeTtlMs: 7 * DAY_MS,
      runDirTtlMs: 30 * DAY_MS,
      dryRun: true,
    });

    expect(dry.runDirsDeleted).toBe(0); // not promised now
    expect(dry.runDirsPending).toBe(1); // deferred behind the worktree reclaim
    expect(dry.outcomes).toMatchObject([
      { runId, worktreeReclaimed: true, runDirDeleted: false, runDirPending: true },
    ]);
    expect(existsSync(join(crewHome, 'runs', runId))).toBe(true); // untouched
  });

  it('keeps the run-dir and counts no reclaim when worktree cleanup reports failure', async () => {
    const runId = 'aaaaaaaa-0000-0000-0000-000000000012';
    await seedRun(runId, { status: 'success', repoRoot, completedAt: '2026-01-01T00:00:00.000Z' });
    vi.spyOn(manager, 'cleanupByRunId').mockResolvedValue({
      success: false,
      errors: ['remove worktree: mocked failure'],
      hadRecord: true,
      worktreeRemoved: false,
      branchDeleted: false,
      recordDeleted: false,
    });

    const result = await gcTerminalRuns({
      crewHome,
      projectRoot: repoRoot,
      runStateStore: store,
      worktreeManager: manager,
      now: T0 + 31 * DAY_MS,
      worktreeTtlMs: 7 * DAY_MS,
      runDirTtlMs: 30 * DAY_MS,
    });

    expect(existsSync(join(crewHome, 'runs', runId))).toBe(true);
    expect(existsSync(statePath(runId))).toBe(true);
    expect(result.worktreesReclaimed).toBe(0);
    expect(result.runDirsDeleted).toBe(0);
    expect(result.outcomes).toMatchObject([
      {
        runId,
        worktreeReclaimed: false,
        branchDeleted: false,
        runDirDeleted: false,
      },
    ]);
  });

  it('retries partial owned cleanup across passes before deleting the run-dir', async () => {
    const runId = 'aaaaaaaa-0000-0000-0000-000000000015';
    const branch = await seedRun(runId, {
      status: 'merged',
      repoRoot,
      completedAt: '2026-01-01T00:00:00.000Z',
    });
    const originalCleanup = manager.cleanupByRunId.bind(manager);
    const cleanup = vi.spyOn(manager, 'cleanupByRunId');
    cleanup
      .mockImplementationOnce(async () => {
        execSync(`git worktree remove --force ${JSON.stringify(wtPath(runId))}`, { cwd: repoRoot });
        return {
          success: false,
          errors: ['delete branch: mocked failure'],
          hadRecord: true,
          worktreeRemoved: true,
          branchDeleted: false,
          recordDeleted: false,
        };
      })
      .mockImplementation((id, options) => originalCleanup(id, options));

    const first = await gcTerminalRuns({
      crewHome,
      projectRoot: repoRoot,
      runStateStore: store,
      worktreeManager: manager,
      now: T0 + 31 * DAY_MS,
      worktreeTtlMs: 7 * DAY_MS,
      runDirTtlMs: 30 * DAY_MS,
    });

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(existsSync(wtPath(runId))).toBe(false);
    expect(existsSync(metaPath(runId))).toBe(true);
    expect(existsSync(join(crewHome, 'runs', runId))).toBe(true);
    expect(branchExists(branch)).toBe(true);
    expect(first.outcomes).toMatchObject([
      {
        runId,
        worktreeReclaimed: true,
        branchDeleted: false,
        runDirDeleted: false,
      },
    ]);

    const second = await gcTerminalRuns({
      crewHome,
      projectRoot: repoRoot,
      runStateStore: store,
      worktreeManager: manager,
      now: T0 + 32 * DAY_MS,
      worktreeTtlMs: 7 * DAY_MS,
      runDirTtlMs: 30 * DAY_MS,
    });

    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(existsSync(metaPath(runId))).toBe(false);
    expect(existsSync(join(crewHome, 'runs', runId))).toBe(false);
    expect(branchExists(branch)).toBe(false);
    expect(second.outcomes).toMatchObject([
      {
        runId,
        worktreeReclaimed: true,
        branchDeleted: true,
        runDirDeleted: true,
      },
    ]);
  });

  it('keeps the run-dir when worktree cleanup throws', async () => {
    const runId = 'aaaaaaaa-0000-0000-0000-000000000013';
    await seedRun(runId, { status: 'success', repoRoot, completedAt: '2026-01-01T00:00:00.000Z' });
    vi.spyOn(manager, 'cleanupByRunId').mockRejectedValue(new Error('mocked throw'));

    const result = await gcTerminalRuns({
      crewHome,
      projectRoot: repoRoot,
      runStateStore: store,
      worktreeManager: manager,
      now: T0 + 31 * DAY_MS,
      worktreeTtlMs: 7 * DAY_MS,
      runDirTtlMs: 30 * DAY_MS,
    });

    expect(existsSync(join(crewHome, 'runs', runId))).toBe(true);
    expect(result.worktreesReclaimed).toBe(0);
    expect(result.runDirsDeleted).toBe(0);
  });

  it('deletes the branch when GC reclaims a merged run', async () => {
    const runId = 'aaaaaaaa-0000-0000-0000-000000000003';
    const branch = await seedRun(runId, { status: 'merged', repoRoot, completedAt: '2026-01-01T00:00:00.000Z' });

    await gcTerminalRuns({
      crewHome,
      projectRoot: repoRoot,
      runStateStore: store,
      worktreeManager: manager,
      now: T0 + 8 * DAY_MS,
      worktreeTtlMs: 7 * DAY_MS,
      runDirTtlMs: 30 * DAY_MS,
    });

    expect(existsSync(wtPath(runId))).toBe(false);
    expect(branchExists(branch)).toBe(false); // merged branch dropped
  });

  it('skips running runs, other-repo runs, and fresh terminal runs', async () => {
    const running = 'aaaaaaaa-0000-0000-0000-00000000000a';
    const other = 'aaaaaaaa-0000-0000-0000-00000000000b';
    const fresh = 'aaaaaaaa-0000-0000-0000-00000000000c';
    await seedRun(running, { status: 'running', repoRoot });
    await seedRun(other, { status: 'success', repoRoot: otherRoot, completedAt: '2026-01-01T00:00:00.000Z' });
    await seedRun(fresh, { status: 'success', repoRoot, completedAt: '2026-01-01T00:00:00.000Z' });

    await gcTerminalRuns({
      crewHome,
      projectRoot: repoRoot,
      runStateStore: store,
      worktreeManager: manager,
      now: T0 + 1 * DAY_MS, // 1 day: below the 7-day worktree TTL
      worktreeTtlMs: 7 * DAY_MS,
      runDirTtlMs: 30 * DAY_MS,
    });

    expect(existsSync(wtPath(running))).toBe(true);
    expect(existsSync(wtPath(other))).toBe(true);
    expect(existsSync(wtPath(fresh))).toBe(true);
  });

  it('does nothing when both windows are disabled', async () => {
    const runId = 'aaaaaaaa-0000-0000-0000-00000000000d';
    await seedRun(runId, { status: 'success', repoRoot, completedAt: '2026-01-01T00:00:00.000Z' });

    await gcTerminalRuns({
      crewHome,
      projectRoot: repoRoot,
      runStateStore: store,
      worktreeManager: manager,
      now: T0 + 365 * DAY_MS,
      worktreeTtlMs: Number.POSITIVE_INFINITY,
      runDirTtlMs: Number.POSITIVE_INFINITY,
    });

    expect(existsSync(wtPath(runId))).toBe(true);
    expect(existsSync(statePath(runId))).toBe(true);
  });

  it('skips records rejected by the run-state schema guard', async () => {
    const runId = 'aaaaaaaa-0000-0000-0000-000000000014';
    await seedRun(runId, { status: 'success', repoRoot, completedAt: '2026-01-01T00:00:00.000Z' });
    writeFileSync(
      statePath(runId),
      JSON.stringify({
        schemaVersion: 2,
        runId,
        agentId: 'mock',
        status: 'success',
        startedAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:00:00.000Z',
        worktreePath: wtPath(runId),
        repoRoot,
        prompts: [],
        filesChanged: [],
      }, null, 2),
      'utf-8',
    );
    const cleanup = vi.spyOn(manager, 'cleanupByRunId');

    const result = await gcTerminalRuns({
      crewHome,
      projectRoot: repoRoot,
      runStateStore: store,
      worktreeManager: manager,
      now: T0 + 31 * DAY_MS,
      worktreeTtlMs: 7 * DAY_MS,
      runDirTtlMs: 30 * DAY_MS,
    });

    expect(cleanup).not.toHaveBeenCalled();
    expect(existsSync(join(crewHome, 'runs', runId))).toBe(true);
    expect(result.scanned).toBe(0);
    expect(result.outcomes).toEqual([]);
  });
});
