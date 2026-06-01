/**
 * Run GC: terminal runs age out of `<crewHome>/runs/` on two independent
 * windows — worktree reclaim (keeps the branch, except for merged runs) and
 * full run-dir deletion. Uses a real git repo + WorktreeManager so the
 * assertions are about the actual on-disk + git-ref state.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { WorktreeManager } from '../../src/git/worktree.js';
import { RunStateStore } from '../../src/orchestrator/run-state.js';
import {
  gcTerminalRuns,
  resolveTtlMs,
  terminalAtMs,
} from '../../src/orchestrator/run-gc.js';

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
});
