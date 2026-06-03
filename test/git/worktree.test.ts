import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { logger } from '../../src/utils/logger.js';

interface MockGitClient {
  raw: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  deleteLocalBranch: ReturnType<typeof vi.fn>;
  revparse: ReturnType<typeof vi.fn>;
  checkout: ReturnType<typeof vi.fn>;
  merge: ReturnType<typeof vi.fn>;
  diff: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  add: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
}

const gitClients = new Map<string, MockGitClient>();

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createGitClient(cwd: string): MockGitClient {
  return {
    raw: vi.fn(async (args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'add') {
        mkdirSync(args[4], { recursive: true });
        return '';
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        rmSync(args[2], { recursive: true, force: true });
        return '';
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        return '';
      }
      if (args[0] === 'worktree' && args[1] === 'prune') {
        return '';
      }
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        return '.git';
      }
      if (args[0] === 'rev-parse' && args[1] === '--git-path') {
        return join('.git', args[2]);
      }
      if (args[0] === 'symbolic-ref') {
        return 'refs/remotes/origin/main';
      }
      return '';
    }),
    status: vi.fn(async () => ({
      modified: [],
      created: [],
      not_added: [],
      renamed: [],
    })),
    deleteLocalBranch: vi.fn(async () => undefined),
    revparse: vi.fn(async () => 'main'),
    checkout: vi.fn(async () => undefined),
    merge: vi.fn(async () => undefined),
    // Default: squash staged a non-empty diff, so the squash commit proceeds.
    diff: vi.fn(async () => 'file.ts\n'),
    reset: vi.fn(async () => undefined),
    add: vi.fn(async () => undefined),
    commit: vi.fn(async () => undefined),
  };
}

function getGitClient(cwd: string): MockGitClient {
  const existing = gitClients.get(cwd);
  if (existing) {
    return existing;
  }
  const created = createGitClient(cwd);
  gitClients.set(cwd, created);
  return created;
}

const simpleGitMock = vi.fn((cwd: string) => getGitClient(cwd));

vi.mock('simple-git', () => ({
  default: simpleGitMock,
}));

vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  return {
    ...actual,
    randomUUID: vi.fn(),
  };
});

const { randomUUID } = await import('crypto');
const mockRandomUUID = vi.mocked(randomUUID);
const { WorktreeManager } = await import('../../src/git/worktree.js');

describe('WorktreeManager', () => {
  const tempDirs: string[] = [];

  function createManager() {
    const root = mkdtempSync(join(tmpdir(), 'crew-worktree-manager-'));
    const crewHome = mkdtempSync(join(tmpdir(), 'crew-worktree-home-'));
    mkdirSync(join(root, '.git'), { recursive: true });
    tempDirs.push(root, crewHome);
    return {
      root,
      crewHome,
      manager: new WorktreeManager({ projectRoot: root, crewHome }),
      rootGit: getGitClient(root),
    };
  }

  function createManagerForRoot(root: string, crewHome: string) {
    mkdirSync(join(root, '.git'), { recursive: true });
    tempDirs.push(root, crewHome);
    return {
      root,
      crewHome,
      manager: new WorktreeManager({ projectRoot: root, crewHome }),
      rootGit: getGitClient(root),
    };
  }

  function installHostCheckoutState(
    rootGit: MockGitClient,
    options: {
      branch?: string;
      head?: string;
      target?: string;
      targetHead?: string;
    } = {},
  ) {
    const target = options.target ?? 'main';
    const targetHead = options.targetHead ?? 'target-head';
    const originalBranch = options.branch ?? 'feature';
    const originalHead = options.head ?? 'feature-head';
    let currentBranch = originalBranch;
    let currentHead = originalHead;
    let mergeCommitCount = 0;

    rootGit.revparse.mockImplementation(async (args: string[]) => {
      if (args[0] === '--abbrev-ref') return currentBranch;
      if (args[0] === 'HEAD') return currentHead;
      if (args[0] === target) return targetHead;
      return target;
    });
    rootGit.checkout.mockImplementation(async (ref: string) => {
      if (ref === target) {
        currentBranch = target;
        currentHead = targetHead;
        return;
      }
      if (ref === originalBranch) {
        currentBranch = originalBranch;
        currentHead = originalHead;
        return;
      }
      currentBranch = 'HEAD';
      currentHead = ref;
    });
    rootGit.commit.mockImplementation(async () => {
      mergeCommitCount += 1;
      currentHead = `merged-sha-${mergeCommitCount}`;
    });

    return {
      branch: () => currentBranch,
      head: () => currentHead,
      setHead: (head: string) => { currentHead = head; },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    gitClients.clear();
    mockRandomUUID.mockReset();
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('Run-scoped API (M1.5-14)', () => {
    it('prunes run worktrees once per project root instead of on every createRunWorktree call', async () => {
      mockRandomUUID
        .mockReturnValueOnce('owner-1')
        .mockReturnValueOnce('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
        .mockReturnValueOnce('owner-2')
        .mockReturnValueOnce('bbbbbbbb-cccc-dddd-eeee-ffffffffffff');

      const { manager, rootGit } = createManager();
      const pruneCallsBeforeCreates = rootGit.raw.mock.calls.filter(
        ([args]) => args[0] === 'worktree' && args[1] === 'prune',
      );
      expect(pruneCallsBeforeCreates).toHaveLength(1);

      rootGit.raw.mockClear();

      await manager.createRunWorktree('run-1');
      await manager.createRunWorktree('run-2');

      const pruneCallsDuringCreates = rootGit.raw.mock.calls.filter(
        ([args]) => args[0] === 'worktree' && args[1] === 'prune',
      );
      expect(pruneCallsDuringCreates).toHaveLength(0);
    });

    it('downgrades the prune failure to debug when cwd is not a git repository', async () => {
      const root = mkdtempSync(join(tmpdir(), 'crew-worktree-not-a-repo-'));
      const crewHome = mkdtempSync(join(tmpdir(), 'crew-worktree-home-'));
      tempDirs.push(root, crewHome);

      // Replace the default `worktree prune` handler with the same fatal
      // git emits when launched from a non-repo cwd (Conductor's app bin
      // dir, etc.). All other raw calls fall through to the default.
      const fakeGit = getGitClient(root);
      const defaultRaw = fakeGit.raw.getMockImplementation();
      fakeGit.raw.mockImplementation(async (args: string[]) => {
        if (args[0] === 'worktree' && args[1] === 'prune') {
          throw new Error(
            `fatal: not a git repository (or any of the parent directories): .git`,
          );
        }
        return defaultRaw?.(args);
      });

      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);

      try {
        new WorktreeManager({ projectRoot: root, crewHome });
        // The prune is fire-and-forget (`void git.raw(...).catch(...)`); a
        // single microtask flush is enough to let the rejection handler run.
        await Promise.resolve();
        await Promise.resolve();

        const warnedAboutPrune = warn.mock.calls.some(
          ([msg]) => typeof msg === 'string' && msg.includes('prune stale git worktrees'),
        );
        const debuggedAboutNonRepo = debug.mock.calls.some(
          ([msg]) => typeof msg === 'string' && msg.includes('not a git repository'),
        );
        expect(warnedAboutPrune).toBe(false);
        expect(debuggedAboutNonRepo).toBe(true);
      } finally {
        warn.mockRestore();
        debug.mockRestore();
      }
    });

    it('still warns on other prune failures (non-cosmetic errors stay loud)', async () => {
      const root = mkdtempSync(join(tmpdir(), 'crew-worktree-prune-warn-'));
      const crewHome = mkdtempSync(join(tmpdir(), 'crew-worktree-home-'));
      tempDirs.push(root, crewHome);

      const fakeGit = getGitClient(root);
      const defaultRaw = fakeGit.raw.getMockImplementation();
      fakeGit.raw.mockImplementation(async (args: string[]) => {
        if (args[0] === 'worktree' && args[1] === 'prune') {
          throw new Error('fatal: unable to access .git: permission denied');
        }
        return defaultRaw?.(args);
      });

      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      try {
        new WorktreeManager({ projectRoot: root, crewHome });
        await Promise.resolve();
        await Promise.resolve();
        const warnedAboutPrune = warn.mock.calls.some(
          ([msg]) => typeof msg === 'string' && msg.includes('prune stale git worktrees'),
        );
        expect(warnedAboutPrune).toBe(true);
      } finally {
        warn.mockRestore();
      }
    });

    it('does not repeat the lazy prune for a second manager on the same project root', () => {
      const root = mkdtempSync(join(tmpdir(), 'crew-worktree-manager-'));
      const crewHomeA = mkdtempSync(join(tmpdir(), 'crew-worktree-home-'));
      const crewHomeB = mkdtempSync(join(tmpdir(), 'crew-worktree-home-'));

      const first = createManagerForRoot(root, crewHomeA);
      const pruneCallsAfterFirst = first.rootGit.raw.mock.calls.filter(
        ([args]) => args[0] === 'worktree' && args[1] === 'prune',
      );
      expect(pruneCallsAfterFirst).toHaveLength(1);

      first.rootGit.raw.mockClear();
      createManagerForRoot(root, crewHomeB);

      const pruneCallsAfterSecond = first.rootGit.raw.mock.calls.filter(
        ([args]) => args[0] === 'worktree' && args[1] === 'prune',
      );
      expect(pruneCallsAfterSecond).toHaveLength(0);
    });

    it('two concurrent createRunWorktree with distinct runIds produce distinct paths', async () => {
      mockRandomUUID
        .mockReturnValueOnce('owner-run-1')
        .mockReturnValueOnce('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
        .mockReturnValueOnce('owner-run-2')
        .mockReturnValueOnce('bbbbbbbb-cccc-dddd-eeee-ffffffffffff');

      const { crewHome, manager } = createManager();
      const [a, b] = await Promise.all([
        manager.createRunWorktree('run-1'),
        manager.createRunWorktree('run-2'),
      ]);
      expect(a).toBe(join(crewHome, 'runs', 'run-1', 'worktree'));
      expect(b).toBe(join(crewHome, 'runs', 'run-2', 'worktree'));
    });

    it('reclaims a stale run lock whose owner process is gone', async () => {
      mockRandomUUID
        .mockReturnValueOnce('owner-reclaimed')
        .mockReturnValueOnce('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

      const { crewHome, manager } = createManager();
      const lockDir = join(crewHome, 'runs', '.locks', 'run-1');
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(
        join(lockDir, 'owner.json'),
        JSON.stringify({
          ownerId: 'old-owner',
          pid: 999_999_999,
          acquiredAt: new Date(Date.now() - 60_000).toISOString(),
        }),
        'utf-8',
      );
      const stale = new Date(Date.now() - 60_000);
      utimesSync(lockDir, stale, stale);

      await expect(manager.createRunWorktree('run-1')).resolves.toBe(
        join(crewHome, 'runs', 'run-1', 'worktree'),
      );
      expect(existsSync(lockDir)).toBe(false);
    });

    it('times out instead of reclaiming a run lock held by a live process', async () => {
      mockRandomUUID.mockReturnValueOnce('owner-waiting');

      const { crewHome, manager } = createManager();
      const lockDir = join(crewHome, 'runs', '.locks', 'run-1');
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(
        join(lockDir, 'owner.json'),
        JSON.stringify({
          ownerId: 'live-owner',
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
        }),
        'utf-8',
      );

      const now = vi.spyOn(Date, 'now');
      now
        .mockReturnValueOnce(1_000)
        .mockReturnValueOnce(21_001);
      try {
        await expect(manager.createRunWorktree('run-1')).rejects.toThrow(
          /Timed out waiting for run worktree lock on run-1/,
        );
      } finally {
        now.mockRestore();
      }
      expect(existsSync(lockDir)).toBe(true);
    });

    it('cleanupByRunId removes the worktree + run dir without touching siblings', async () => {
      mockRandomUUID
        .mockReturnValueOnce('owner-1')
        .mockReturnValueOnce('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
        .mockReturnValueOnce('owner-2')
        .mockReturnValueOnce('bbbbbbbb-cccc-dddd-eeee-ffffffffffff')
        .mockReturnValueOnce('cleanup-owner-1');

      const { crewHome, manager } = createManager();
      await manager.createRunWorktree('run-1');
      await manager.createRunWorktree('run-2');
      expect(existsSync(join(crewHome, 'runs', 'run-1'))).toBe(true);
      expect(existsSync(join(crewHome, 'runs', 'run-2'))).toBe(true);

      await manager.cleanupByRunId('run-1');

      expect(existsSync(join(crewHome, 'runs', 'run-1'))).toBe(false);
      expect(existsSync(join(crewHome, 'runs', 'run-2'))).toBe(true);
    });

    it('.meta/<runId>.json is written and removed in lockstep with the worktree', async () => {
      mockRandomUUID
        .mockReturnValueOnce('owner-1')
        .mockReturnValueOnce('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
        .mockReturnValueOnce('cleanup-owner-1');

      const { crewHome, manager } = createManager();
      const metaPath = join(crewHome, 'runs', '.meta', 'run-1.json');

      await manager.createRunWorktree('run-1');
      expect(existsSync(metaPath)).toBe(true);
      const metadata = JSON.parse(readFileSync(metaPath, 'utf-8'));
      expect(metadata).toMatchObject({
        runId: 'run-1',
        branchName: 'crew-run/run-1-aaaaaaaa',
      });

      await manager.cleanupByRunId('run-1');
      expect(existsSync(metaPath)).toBe(false);
    });

    it('getRunWorktreePath returns the recorded path', async () => {
      mockRandomUUID
        .mockReturnValueOnce('owner-1')
        .mockReturnValueOnce('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const { manager } = createManager();
      const created = await manager.createRunWorktree('run-1');
      expect(manager.getRunWorktreePath('run-1')).toBe(created);
    });

    it('getRunWorktreePath throws for unknown runId', () => {
      const { manager } = createManager();
      expect(() => manager.getRunWorktreePath('nope')).toThrow(/No recorded run worktree/);
    });

    it('mergeRunWorktree merges cleanly when host repo has no uncommitted changes', async () => {
      mockRandomUUID
        .mockReturnValueOnce('owner-1')
        .mockReturnValueOnce('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const { crewHome, manager, rootGit } = createManager();
      const wPath = await manager.createRunWorktree('run-1');
      // Post-M3.5 the host repo's git status never includes any .crew/...
      // paths because run state lives at <crewHome>/runs/, not under the
      // host repo. The default empty status() mock reflects this reality.
      const wGit = getGitClient(wPath);
      wGit.revparse.mockResolvedValueOnce('worktree-sha'); // wGit revparse(['HEAD'])
      rootGit.revparse
        .mockResolvedValueOnce('main')        // resolveMergeTargetBranch → target='main'
        .mockResolvedValueOnce('target-sha')  // no-changes check: revparse([target])
        .mockResolvedValueOnce('main')        // capture original branch
        .mockResolvedValueOnce('pre-merge-sha') // capture original HEAD
        .mockResolvedValueOnce('merged-sha'); // post-merge commitSha

      const result = await manager.mergeRunWorktree('run-1');

      expect(result).toMatchObject({ status: 'merged', commitSha: 'merged-sha' });
      // Squash-merge by the worktree's actual HEAD SHA (not the recorded
      // branch ref — see the bug fix in mergeRunWorktree() for rationale),
      // then a single ordinary commit with the fallback subject (no
      // commit_title supplied) and no machine trailer.
      expect(rootGit.merge).toHaveBeenCalledWith(['worktree-sha', '--squash']);
      expect(rootGit.commit).toHaveBeenCalledWith('crew run run-1');
      expect(existsSync(join(crewHome, 'runs', '.meta', 'run-1.json'))).toBe(true);
    });

    it('mergeRunWorktree starts independent status and HEAD reads concurrently and preserves the merge result', async () => {
      mockRandomUUID
        .mockReturnValueOnce('owner-1')
        .mockReturnValueOnce('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const { manager, rootGit } = createManager();
      const wPath = await manager.createRunWorktree('run-1');
      const wGit = getGitClient(wPath);

      const worktreeStatus = deferred<{
        modified: string[];
        created: string[];
        not_added: string[];
        deleted: string[];
        renamed: never[];
      }>();
      const hostStatus = deferred<{
        modified: string[];
        created: string[];
        not_added: string[];
        deleted: string[];
        renamed: never[];
      }>();
      const worktreeHead = deferred<string>();
      const targetHead = deferred<string>();

      wGit.status.mockImplementationOnce(() => worktreeStatus.promise);
      rootGit.status.mockImplementationOnce(() => hostStatus.promise);
      wGit.revparse.mockImplementation(async (args: string[]) => {
        if (args[0] === 'HEAD') return worktreeHead.promise;
        if (args[0] === '--abbrev-ref') return 'crew-run/run-1-aaaaaaaa';
        return 'main';
      });
      rootGit.revparse.mockImplementation(async (args: string[]) => {
        if (args[0] === 'main') return targetHead.promise;
        if (args[0] === 'HEAD') return 'merged-sha';
        return 'main';
      });

      const merge = manager.mergeRunWorktree('run-1');

      await vi.waitFor(() => {
        expect(wGit.status).toHaveBeenCalledTimes(1);
        expect(rootGit.status).toHaveBeenCalledTimes(2);
      });
      expect(wGit.revparse).not.toHaveBeenCalled();

      worktreeStatus.resolve({
        modified: [],
        created: [],
        not_added: [],
        deleted: [],
        renamed: [],
      });
      hostStatus.resolve({
        modified: [],
        created: [],
        not_added: [],
        deleted: [],
        renamed: [],
      });

      await vi.waitFor(() => {
        expect(wGit.revparse).toHaveBeenCalledWith(['HEAD']);
        expect(rootGit.revparse).toHaveBeenCalledWith(['main']);
      });

      worktreeHead.resolve('worktree-sha');
      targetHead.resolve('target-sha');

      await expect(merge).resolves.toMatchObject({ status: 'merged', commitSha: 'merged-sha' });
      expect(rootGit.merge).toHaveBeenCalledWith(['worktree-sha', '--squash']);
      expect(rootGit.commit).toHaveBeenCalledWith('crew run run-1');
    });

    it('mergeRunWorktree uses captain-supplied commit_title + commit_body in the merge commit', async () => {
      mockRandomUUID
        .mockReturnValueOnce('owner-1')
        .mockReturnValueOnce('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const { manager, rootGit } = createManager();
      const wPath = await manager.createRunWorktree('run-1');
      const wGit = getGitClient(wPath);
      wGit.revparse.mockResolvedValueOnce('worktree-sha');
      rootGit.revparse
        .mockResolvedValueOnce('main')
        .mockResolvedValueOnce('target-sha')
        .mockResolvedValueOnce('main')
        .mockResolvedValueOnce('pre-merge-sha')
        .mockResolvedValueOnce('merged-sha');

      const result = await manager.mergeRunWorktree('run-1', {
        commitTitle: 'fix(parser): handle empty-line input correctly',
        commitBody: 'Adds the empty-line guard to parseLine() with a regression test.',
      });

      expect(result).toMatchObject({ status: 'merged', commitSha: 'merged-sha' });
      expect(rootGit.merge).toHaveBeenCalledWith(['worktree-sha', '--squash']);
      expect(rootGit.commit).toHaveBeenCalledWith(
        [
          'fix(parser): handle empty-line input correctly',
          '',
          'Adds the empty-line guard to parseLine() with a regression test.',
        ].join('\n'),
      );
    });

    it('mergeRunWorktree squashes with the commit_title (no body, no trailer)', async () => {
      mockRandomUUID
        .mockReturnValueOnce('owner-1')
        .mockReturnValueOnce('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const { manager, rootGit } = createManager();
      const wPath = await manager.createRunWorktree('run-1');
      const wGit = getGitClient(wPath);
      wGit.revparse.mockResolvedValueOnce('worktree-sha');
      rootGit.revparse
        .mockResolvedValueOnce('main')
        .mockResolvedValueOnce('target-sha')
        .mockResolvedValueOnce('main')
        .mockResolvedValueOnce('merged-sha');

      await manager.mergeRunWorktree('run-1', {
        commitTitle: 'docs: update README install steps',
      });

      expect(rootGit.merge).toHaveBeenCalledWith(['worktree-sha', '--squash']);
      expect(rootGit.commit).toHaveBeenCalledWith('docs: update README install steps');
    });

    it('mergeRunWorktree reuses commit_title for the pre-merge auto-commit when worktree has uncommitted changes', async () => {
      mockRandomUUID
        .mockReturnValueOnce('owner-1')
        .mockReturnValueOnce('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const { manager, rootGit } = createManager();
      const wPath = await manager.createRunWorktree('run-1');
      const wGit = getGitClient(wPath);
      // Worktree has uncommitted changes — triggers the pre-merge add+commit.
      wGit.status.mockResolvedValueOnce({
        modified: ['src.ts'],
        created: [],
        not_added: [],
        deleted: [],
        renamed: [],
      });
      wGit.revparse.mockResolvedValueOnce('worktree-sha');
      rootGit.revparse
        .mockResolvedValueOnce('main')
        .mockResolvedValueOnce('target-sha')
        .mockResolvedValueOnce('main')
        .mockResolvedValueOnce('merged-sha');

      await manager.mergeRunWorktree('run-1', {
        commitTitle: 'feat(api): add /v2/health endpoint',
      });

      expect(wGit.commit).toHaveBeenCalledWith('feat(api): add /v2/health endpoint');
    });

    it('mergeRunWorktree returns no-changes when worktree HEAD matches target', async () => {
      mockRandomUUID
        .mockReturnValueOnce('owner-1')
        .mockReturnValueOnce('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const { manager, rootGit } = createManager();
      const wPath = await manager.createRunWorktree('run-1');
      const wGit = getGitClient(wPath);
      wGit.revparse.mockResolvedValueOnce('same-sha'); // wGit revparse(['HEAD'])
      rootGit.revparse
        .mockResolvedValueOnce('main')      // resolveMergeTargetBranch
        .mockResolvedValueOnce('same-sha'); // my no-changes check: revparse([target])
      const result = await manager.mergeRunWorktree('run-1');
      expect(result).toMatchObject({ status: 'no-changes' });
      expect(rootGit.merge).not.toHaveBeenCalled();
    });

    it('mergeRunWorktree merges the worktree HEAD SHA, not record.branchName, so agent-switched branches still merge', async () => {
      // Regression: codex sandbox forced a non-standard branch
      // (`crew-run/list-runs-phase-1a`) inside the worktree. The recorded
      // `crew-run/<run_id>-<suffix>` ref stayed at the initial commit, so
      // merging the recorded branch was a silent no-op while the real work
      // survived on a different ref. mergeRunWorktree must merge by the
      // worktree's actual HEAD SHA so the work is captured regardless of
      // which branch the agent committed on.
      mockRandomUUID
        .mockReturnValueOnce('owner-1')
        .mockReturnValueOnce('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const { manager, rootGit } = createManager();
      const wPath = await manager.createRunWorktree('run-1');
      const wGit = getGitClient(wPath);
      // Worktree HEAD points at a commit on a DIFFERENT branch than
      // `record.branchName` (`crew-run/run-1-aaaaaaaa`). The recorded
      // branch ref is stale at the initial commit; this SHA is where the
      // agent actually committed.
      wGit.revparse.mockResolvedValueOnce('actual-work-sha');
      rootGit.revparse
        .mockResolvedValueOnce('main')              // resolveMergeTargetBranch
        .mockResolvedValueOnce('main-head-sha')     // no-changes check: != actual-work-sha
        .mockResolvedValueOnce('main')              // capture original branch
        .mockResolvedValueOnce('pre-merge-sha')     // capture original HEAD
        .mockResolvedValueOnce('post-merge-sha');   // commitSha after merge

      const result = await manager.mergeRunWorktree('run-1');

      expect(result).toMatchObject({ status: 'merged', commitSha: 'post-merge-sha' });
      // The squash target must be the worktree's actual HEAD SHA — not
      // `record.branchName` ('crew-run/run-1-aaaaaaaa'), which would
      // silently no-op when the agent worked on a different branch.
      expect(rootGit.merge).toHaveBeenCalledWith(['actual-work-sha', '--squash']);
    });

    it('mergeRunWorktree warn-logs when worktree HEAD is on a different branch than record.branchName', async () => {
      // Captures the orphan-branch case from the merge_run fix: the
      // agent committed on a non-recorded branch (e.g., codex sandbox
      // forced one). Merging by SHA captures the work, but the actual
      // branch ref persists locally after cleanup. Warn so the user
      // knows.
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      mockRandomUUID
        .mockReturnValueOnce('owner-1')
        .mockReturnValueOnce('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const { manager, rootGit } = createManager();
      const wPath = await manager.createRunWorktree('run-1');
      const wGit = getGitClient(wPath);
      // First wGit.revparse(['HEAD']) for no-changes check; then
      // wGit.revparse(['--abbrev-ref', 'HEAD']) for branch-divergence
      // detection. Order matters.
      wGit.revparse
        .mockResolvedValueOnce('actual-sha')                // HEAD SHA
        .mockResolvedValueOnce('crew-run/agent-fork');      // current branch (different!)
      rootGit.revparse
        .mockResolvedValueOnce('main')                      // resolveMergeTargetBranch
        .mockResolvedValueOnce('main-sha')                  // no-changes check (different)
        .mockResolvedValueOnce('main')                      // current-branch check
        .mockResolvedValueOnce('post-merge-sha');           // commitSha

      await manager.mergeRunWorktree('run-1');

      const warnCalls = warn.mock.calls.filter((c) =>
        typeof c[0] === 'string' && c[0].includes('crew-run/agent-fork'),
      );
      expect(warnCalls.length).toBeGreaterThanOrEqual(1);
      expect(warnCalls[0][0]).toMatch(/orphan local ref/);
      expect(warnCalls[0][0]).toMatch(/git branch -D crew-run\/agent-fork/);
    });

    it('mergeRunWorktree does NOT warn when worktree HEAD is on the recorded branch', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      mockRandomUUID
        .mockReturnValueOnce('owner-1')
        .mockReturnValueOnce('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const { manager, rootGit } = createManager();
      const wPath = await manager.createRunWorktree('run-1');
      const wGit = getGitClient(wPath);
      wGit.revparse
        .mockResolvedValueOnce('actual-sha')                  // HEAD SHA
        .mockResolvedValueOnce('crew-run/run-1-aaaaaaaa');    // current branch (matches record)
      rootGit.revparse
        .mockResolvedValueOnce('main')
        .mockResolvedValueOnce('main-sha')
        .mockResolvedValueOnce('main')
        .mockResolvedValueOnce('post-merge-sha');

      await manager.mergeRunWorktree('run-1');

      const branchWarnCalls = warn.mock.calls.filter((c) =>
        typeof c[0] === 'string' && c[0].includes('orphan local ref'),
      );
      expect(branchWarnCalls.length).toBe(0);
    });

    it('mergeRunWorktree preserve fast-forwards when the target has not diverged', async () => {
      mockRandomUUID
        .mockReturnValueOnce('owner-1')
        .mockReturnValueOnce('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const { manager, rootGit } = createManager();
      const wPath = await manager.createRunWorktree('run-1');
      const wGit = getGitClient(wPath);
      wGit.revparse.mockResolvedValueOnce('work-head'); // HEAD (no-changes check)
      rootGit.revparse
        .mockResolvedValueOnce('main')         // resolveMergeTargetBranch
        .mockResolvedValueOnce('target-head')  // no-changes check (!= work-head)
        .mockResolvedValueOnce('main')         // capture original branch
        .mockResolvedValueOnce('pre-merge-sha') // capture original HEAD
        .mockResolvedValueOnce('ff-sha');      // final HEAD
      // merge-base === targetHead → the target is an ancestor → fast-forward.
      rootGit.raw.mockImplementation(async (args: string[]) =>
        args[0] === 'merge-base' ? 'target-head' : '');

      const result = await manager.mergeRunWorktree('run-1', { mergeStrategy: 'preserve' });

      expect(result).toMatchObject({ status: 'merged', commitSha: 'ff-sha' });
      expect(rootGit.merge).toHaveBeenCalledWith(['work-head', '--ff-only']);
      // Fast-forward keeps the exact commits — no new squash commit.
      expect(rootGit.commit).not.toHaveBeenCalled();
    });

    it('mergeRunWorktree preserve cherry-picks the run range when the target diverged', async () => {
      mockRandomUUID
        .mockReturnValueOnce('owner-1')
        .mockReturnValueOnce('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const { manager, rootGit } = createManager();
      const wPath = await manager.createRunWorktree('run-1');
      const wGit = getGitClient(wPath);
      wGit.revparse.mockResolvedValueOnce('work-head');
      rootGit.revparse
        .mockResolvedValueOnce('main')         // target
        .mockResolvedValueOnce('target-head')  // no-changes check
        .mockResolvedValueOnce('main')         // capture original branch
        .mockResolvedValueOnce('pre-merge-sha') // capture original HEAD
        .mockResolvedValueOnce('picked-sha');  // final HEAD
      const cherryCalls: string[][] = [];
      rootGit.raw.mockImplementation(async (args: string[]) => {
        // base differs from BOTH target and work head → diverged → cherry-pick.
        if (args[0] === 'merge-base') return 'base-sha';
        if (args[0] === 'cherry-pick') { cherryCalls.push(args); return ''; }
        return '';
      });

      const result = await manager.mergeRunWorktree('run-1', { mergeStrategy: 'preserve' });

      expect(result).toMatchObject({ status: 'merged', commitSha: 'picked-sha' });
      expect(cherryCalls).toEqual([['cherry-pick', 'base-sha..work-head']]);
      expect(rootGit.commit).not.toHaveBeenCalled();
    });

    it('mergeRunWorktree refuses dirty host worktree without force', async () => {
      mockRandomUUID
        .mockReturnValueOnce('owner-1')
        .mockReturnValueOnce('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const { manager, rootGit } = createManager();
      await manager.createRunWorktree('run-1');
      rootGit.status.mockResolvedValueOnce({
        modified: ['somefile.ts'],
        created: [],
        not_added: [],
        deleted: [],
        renamed: [],
      });
      await expect(manager.mergeRunWorktree('run-1')).rejects.toThrow(/uncommitted changes/);
    });

    it('mergeRunWorktree force=true does not hard-reset a dirty host after squash commit failure', async () => {
      mockRandomUUID.mockReturnValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const { manager, rootGit } = createManager();
      const wPath = await manager.createRunWorktree('run-1');
      const wGit = getGitClient(wPath);
      const host = installHostCheckoutState(rootGit);
      wGit.revparse.mockImplementation(async (args: string[]) => (
        args[0] === 'HEAD' ? 'work-head' : 'crew-run/run-1-aaaaaaaa'
      ));
      rootGit.status.mockResolvedValue({
        modified: ['host-dirty.ts'],
        created: [],
        not_added: [],
        deleted: [],
        renamed: [],
      });
      rootGit.commit.mockRejectedValueOnce(new Error('commit hook failed'));

      await expect(
        manager.mergeRunWorktree('run-1', { targetBranch: 'main', force: true }),
      ).rejects.toThrow(/did not run git reset --hard/);

      expect(rootGit.reset).not.toHaveBeenCalled();
      expect(host.branch()).toBe('main');
      expect(host.head()).toBe('target-head');
      expect(rootGit.checkout.mock.calls.map(([ref]) => ref)).toEqual(['main']);
    });

    it('mergeRunWorktree reports merged when squash post-commit HEAD revparse fails', async () => {
      mockRandomUUID.mockReturnValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const { manager, rootGit } = createManager();
      const wPath = await manager.createRunWorktree('run-1');
      const wGit = getGitClient(wPath);
      const host = installHostCheckoutState(rootGit);
      wGit.revparse.mockImplementation(async (args: string[]) => (
        args[0] === 'HEAD' ? 'work-head' : 'crew-run/run-1-aaaaaaaa'
      ));
      const defaultRevparse = rootGit.revparse.getMockImplementation();
      let landed = false;
      rootGit.commit.mockImplementation(async () => {
        landed = true;
        host.setHead('commit-result-sha');
        return { commit: 'commit-result-sha' };
      });
      rootGit.revparse.mockImplementation(async (args: string[]) => {
        if (landed && args[0] === 'HEAD') {
          throw new Error('revparse failed after commit');
        }
        return defaultRevparse?.(args) ?? '';
      });

      const result = await manager.mergeRunWorktree('run-1', { targetBranch: 'main' });

      expect(result).toMatchObject({
        status: 'merged',
        commitSha: 'commit-result-sha',
        restoreFailed: true,
      });
      expect(result.restoreWarning).toContain('could not resolve the landed commit SHA');
      expect(result.restoreWarning).toContain('revparse failed after commit');
      expect(rootGit.reset).not.toHaveBeenCalled();
      expect(host.branch()).toBe('main');
      expect(host.head()).toBe('commit-result-sha');
      expect(rootGit.checkout.mock.calls.map(([ref]) => ref)).toEqual(['main']);
    });

    it('mergeRunWorktree reports merged when preserve fast-forward post-landing HEAD revparse fails', async () => {
      mockRandomUUID.mockReturnValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const { manager, rootGit } = createManager();
      const wPath = await manager.createRunWorktree('run-1');
      const wGit = getGitClient(wPath);
      const host = installHostCheckoutState(rootGit);
      wGit.revparse.mockImplementation(async (args: string[]) => (
        args[0] === 'HEAD' ? 'work-head' : 'crew-run/run-1-aaaaaaaa'
      ));
      const defaultRevparse = rootGit.revparse.getMockImplementation();
      rootGit.raw.mockImplementation(async (args: string[]) =>
        args[0] === 'merge-base' ? 'target-head' : '');
      let landed = false;
      rootGit.merge.mockImplementation(async () => {
        landed = true;
        host.setHead('work-head');
      });
      rootGit.revparse.mockImplementation(async (args: string[]) => {
        if (landed && args[0] === 'HEAD') {
          throw new Error('revparse failed after fast-forward');
        }
        return defaultRevparse?.(args) ?? '';
      });

      const result = await manager.mergeRunWorktree('run-1', {
        targetBranch: 'main',
        mergeStrategy: 'preserve',
      });

      expect(result).toMatchObject({
        status: 'merged',
        commitSha: 'work-head',
        restoreFailed: true,
      });
      expect(result.restoreWarning).toContain('could not resolve the landed commit SHA');
      expect(result.restoreWarning).toContain('revparse failed after fast-forward');
      expect(rootGit.reset).not.toHaveBeenCalled();
      expect(rootGit.raw.mock.calls).not.toContainEqual(['cherry-pick', '--abort']);
      expect(host.branch()).toBe('main');
      expect(host.head()).toBe('work-head');
      expect(rootGit.checkout.mock.calls.map(([ref]) => ref)).toEqual(['main']);
    });

    it('mergeRunWorktree reports merged when preserve cherry-pick post-landing HEAD revparse fails', async () => {
      mockRandomUUID.mockReturnValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const { manager, rootGit } = createManager();
      const wPath = await manager.createRunWorktree('run-1');
      const wGit = getGitClient(wPath);
      const host = installHostCheckoutState(rootGit);
      wGit.revparse.mockImplementation(async (args: string[]) => (
        args[0] === 'HEAD' ? 'work-head' : 'crew-run/run-1-aaaaaaaa'
      ));
      const defaultRaw = rootGit.raw.getMockImplementation();
      const defaultRevparse = rootGit.revparse.getMockImplementation();
      let landed = false;
      rootGit.raw.mockImplementation(async (args: string[]) => {
        if (args[0] === 'merge-base') return 'base-sha';
        if (args[0] === 'cherry-pick' && args[1] !== '--abort') {
          landed = true;
          host.setHead('picked-sha');
          return '';
        }
        return defaultRaw?.(args) ?? '';
      });
      rootGit.revparse.mockImplementation(async (args: string[]) => {
        if (landed && args[0] === 'HEAD') {
          throw new Error('revparse failed after cherry-pick');
        }
        return defaultRevparse?.(args) ?? '';
      });

      const result = await manager.mergeRunWorktree('run-1', {
        targetBranch: 'main',
        mergeStrategy: 'preserve',
      });

      expect(result).toMatchObject({
        status: 'merged',
        commitSha: 'unknown',
        restoreFailed: true,
      });
      expect(result.restoreWarning).toContain('could not resolve the landed commit SHA');
      expect(result.restoreWarning).toContain('revparse failed after cherry-pick');
      expect(rootGit.reset).not.toHaveBeenCalled();
      expect(rootGit.raw.mock.calls).not.toContainEqual(['cherry-pick', '--abort']);
      expect(host.branch()).toBe('main');
      expect(host.head()).toBe('picked-sha');
      expect(rootGit.checkout.mock.calls.map(([ref]) => ref)).toEqual(['main']);
    });

    it('mergeRunWorktree restores the original branch after a merged result', async () => {
      mockRandomUUID.mockReturnValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const { manager, rootGit } = createManager();
      const wPath = await manager.createRunWorktree('run-1');
      const wGit = getGitClient(wPath);
      const host = installHostCheckoutState(rootGit);
      wGit.revparse.mockImplementation(async (args: string[]) => (
        args[0] === 'HEAD' ? 'work-head' : 'crew-run/run-1-aaaaaaaa'
      ));

      const result = await manager.mergeRunWorktree('run-1', { targetBranch: 'main' });

      expect(result).toMatchObject({
        status: 'merged',
        commitSha: 'merged-sha-1',
        targetBranch: 'main',
        originalBranch: 'feature',
        originalHead: 'feature-head',
        landedOffCurrentBranch: true,
      });
      expect(host.branch()).toBe('feature');
      expect(host.head()).toBe('feature-head');
      expect(rootGit.checkout.mock.calls.map(([ref]) => ref)).toEqual(['main', 'feature']);
    });

    it('mergeRunWorktree reports merged with restore_failed when restore fails after the commit lands', async () => {
      mockRandomUUID.mockReturnValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const { manager, rootGit } = createManager();
      const wPath = await manager.createRunWorktree('run-1');
      const wGit = getGitClient(wPath);
      const host = installHostCheckoutState(rootGit);
      const checkout = rootGit.checkout.getMockImplementation();
      rootGit.checkout.mockImplementation(async (ref: string) => {
        if (ref === 'feature') {
          throw new Error('feature branch is unavailable');
        }
        await checkout?.(ref);
      });
      wGit.revparse.mockImplementation(async (args: string[]) => (
        args[0] === 'HEAD' ? 'work-head' : 'crew-run/run-1-aaaaaaaa'
      ));

      const result = await manager.mergeRunWorktree('run-1', { targetBranch: 'main' });

      expect(result).toMatchObject({
        status: 'merged',
        commitSha: 'merged-sha-1',
        targetBranch: 'main',
        originalBranch: 'feature',
        originalHead: 'feature-head',
        landedOffCurrentBranch: true,
        restoreFailed: true,
      });
      expect(result.restoreWarning).toContain('Merge landed');
      expect(result.restoreWarning).toContain('feature');
      expect(result.restoreWarning).toContain('main');
      expect(host.branch()).toBe('main');
      expect(host.head()).toBe('merged-sha-1');
      expect(rootGit.checkout.mock.calls.map(([ref]) => ref)).toEqual(['main', 'feature']);
    });

    it('mergeRunWorktree restores the original branch after staged-empty no-changes', async () => {
      mockRandomUUID.mockReturnValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const { manager, rootGit } = createManager();
      const wPath = await manager.createRunWorktree('run-1');
      const wGit = getGitClient(wPath);
      const host = installHostCheckoutState(rootGit);
      wGit.revparse.mockImplementation(async (args: string[]) => (
        args[0] === 'HEAD' ? 'work-head' : 'crew-run/run-1-aaaaaaaa'
      ));
      rootGit.diff.mockResolvedValueOnce('');

      const result = await manager.mergeRunWorktree('run-1', { targetBranch: 'main' });

      expect(result).toMatchObject({
        status: 'no-changes',
        targetBranch: 'main',
        originalBranch: 'feature',
        originalHead: 'feature-head',
        landedOffCurrentBranch: false,
      });
      expect(rootGit.reset).toHaveBeenCalledWith(['--hard', 'target-head']);
      expect(host.branch()).toBe('feature');
      expect(host.head()).toBe('feature-head');
      expect(rootGit.checkout.mock.calls.map(([ref]) => ref)).toEqual(['main', 'feature']);
    });

    it('mergeRunWorktree leaves the host on target after a conflict result', async () => {
      mockRandomUUID.mockReturnValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const { manager, rootGit } = createManager();
      const wPath = await manager.createRunWorktree('run-1');
      const wGit = getGitClient(wPath);
      const host = installHostCheckoutState(rootGit);
      wGit.revparse.mockImplementation(async (args: string[]) => (
        args[0] === 'HEAD' ? 'work-head' : 'crew-run/run-1-aaaaaaaa'
      ));
      rootGit.merge.mockRejectedValueOnce(new Error('CONFLICT'));
      const defaultRaw = rootGit.raw.getMockImplementation();
      let conflictProbeCount = 0;
      rootGit.raw.mockImplementation(async (args: string[]) => {
        if (args[0] === 'diff' && args.includes('--diff-filter=U')) {
          conflictProbeCount += 1;
          return conflictProbeCount === 1 ? '' : 'shared.txt\n';
        }
        return defaultRaw?.(args);
      });

      const result = await manager.mergeRunWorktree('run-1', { targetBranch: 'main' });

      expect(result).toMatchObject({
        status: 'conflict',
        conflicts: ['shared.txt'],
        targetBranch: 'main',
        originalBranch: 'feature',
        originalHead: 'feature-head',
        landedOffCurrentBranch: false,
      });
      expect(host.branch()).toBe('main');
      expect(host.head()).toBe('target-head');
      expect(rootGit.checkout.mock.calls.map(([ref]) => ref)).toEqual(['main']);
    });

    it('mergeRunWorktree restores a detached original checkout to the captured SHA', async () => {
      mockRandomUUID.mockReturnValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const { manager, rootGit } = createManager();
      const wPath = await manager.createRunWorktree('run-1');
      const wGit = getGitClient(wPath);
      const host = installHostCheckoutState(rootGit, {
        branch: 'HEAD',
        head: 'detached-sha',
      });
      wGit.revparse.mockImplementation(async (args: string[]) => (
        args[0] === 'HEAD' ? 'work-head' : 'crew-run/run-1-aaaaaaaa'
      ));

      const result = await manager.mergeRunWorktree('run-1', { targetBranch: 'main' });

      expect(result).toMatchObject({
        status: 'merged',
        commitSha: 'merged-sha-1',
        targetBranch: 'main',
        originalHead: 'detached-sha',
        landedOffCurrentBranch: true,
      });
      expect(result).not.toHaveProperty('originalBranch');
      expect(host.branch()).toBe('HEAD');
      expect(host.head()).toBe('detached-sha');
      expect(rootGit.checkout.mock.calls.map(([ref]) => ref)).toEqual(['main', 'detached-sha']);
    });

    it('mergeRunWorktree serializes concurrent merges through the repo lock', async () => {
      mockRandomUUID.mockReturnValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const { manager, rootGit } = createManager();
      const firstPath = await manager.createRunWorktree('run-1');
      const secondPath = await manager.createRunWorktree('run-2');
      const firstGit = getGitClient(firstPath);
      const secondGit = getGitClient(secondPath);
      installHostCheckoutState(rootGit);
      firstGit.revparse.mockImplementation(async (args: string[]) => (
        args[0] === 'HEAD' ? 'work-head-1' : 'crew-run/run-1-aaaaaaaa'
      ));
      secondGit.revparse.mockImplementation(async (args: string[]) => (
        args[0] === 'HEAD' ? 'work-head-2' : 'crew-run/run-2-aaaaaaaa'
      ));
      const firstMergeMayFinish = deferred<void>();
      let mergeCalls = 0;
      rootGit.merge.mockImplementation(async () => {
        mergeCalls += 1;
        if (mergeCalls === 1) {
          await firstMergeMayFinish.promise;
        }
      });

      const first = manager.mergeRunWorktree('run-1', { targetBranch: 'main' });
      await vi.waitFor(() => {
        expect(rootGit.merge).toHaveBeenCalledTimes(1);
      });

      const second = manager.mergeRunWorktree('run-2', { targetBranch: 'main' });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(secondGit.status).not.toHaveBeenCalled();

      firstMergeMayFinish.resolve();
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(firstResult).toMatchObject({ status: 'merged' });
      expect(secondResult).toMatchObject({ status: 'merged' });
      expect(rootGit.merge).toHaveBeenCalledTimes(2);
    });

    it('mergeRunWorktree serializes merges across managers with different crewHome values', async () => {
      mockRandomUUID.mockReturnValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const root = mkdtempSync(join(tmpdir(), 'crew-worktree-shared-lock-'));
      const crewHomeA = mkdtempSync(join(tmpdir(), 'crew-worktree-home-a-'));
      const crewHomeB = mkdtempSync(join(tmpdir(), 'crew-worktree-home-b-'));
      const first = createManagerForRoot(root, crewHomeA);
      const second = createManagerForRoot(root, crewHomeB);
      const firstPath = await first.manager.createRunWorktree('run-1');
      const secondPath = await second.manager.createRunWorktree('run-2');
      const firstGit = getGitClient(firstPath);
      const secondGit = getGitClient(secondPath);
      installHostCheckoutState(first.rootGit);
      firstGit.revparse.mockImplementation(async (args: string[]) => (
        args[0] === 'HEAD' ? 'work-head-1' : 'crew-run/run-1-aaaaaaaa'
      ));
      secondGit.revparse.mockImplementation(async (args: string[]) => (
        args[0] === 'HEAD' ? 'work-head-2' : 'crew-run/run-2-aaaaaaaa'
      ));
      const firstMergeMayFinish = deferred<void>();
      let mergeCalls = 0;
      first.rootGit.merge.mockImplementation(async () => {
        mergeCalls += 1;
        if (mergeCalls === 1) {
          await firstMergeMayFinish.promise;
        }
      });

      const firstMerge = first.manager.mergeRunWorktree('run-1', { targetBranch: 'main' });
      await vi.waitFor(() => {
        expect(first.rootGit.merge).toHaveBeenCalledTimes(1);
      });

      const secondMerge = second.manager.mergeRunWorktree('run-2', { targetBranch: 'main' });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(secondGit.status).not.toHaveBeenCalled();

      firstMergeMayFinish.resolve();
      const [firstResult, secondResult] = await Promise.all([firstMerge, secondMerge]);

      expect(firstResult).toMatchObject({ status: 'merged' });
      expect(secondResult).toMatchObject({ status: 'merged' });
      expect(first.rootGit.merge).toHaveBeenCalledTimes(2);
      expect(existsSync(join(crewHomeA, 'repo-locks'))).toBe(false);
      expect(existsSync(join(crewHomeB, 'repo-locks'))).toBe(false);
      expect(existsSync(join(root, '.git', 'crew-merge-lock'))).toBe(true);
    });

    it('mergeRunWorktree refuses unmerged index paths even with force=true', async () => {
      mockRandomUUID.mockReturnValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const { manager, rootGit } = createManager();
      await manager.createRunWorktree('run-1');
      rootGit.status.mockClear();
      const defaultRaw = rootGit.raw.getMockImplementation();
      rootGit.raw.mockImplementation(async (args: string[]) => {
        if (args[0] === 'diff' && args.includes('--diff-filter=U')) {
          return 'conflict.txt\n';
        }
        return defaultRaw?.(args);
      });

      await expect(
        manager.mergeRunWorktree('run-1', { targetBranch: 'main', force: true }),
      ).rejects.toThrow(/unmerged index paths: conflict\.txt/);
      expect(rootGit.status).not.toHaveBeenCalled();
    });

    it('mergeRunWorktree refuses an in-progress rebase before merge work starts', async () => {
      mockRandomUUID.mockReturnValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const { root, manager, rootGit } = createManager();
      await manager.createRunWorktree('run-1');
      rootGit.status.mockClear();
      mkdirSync(join(root, '.git', 'rebase-merge'), { recursive: true });

      await expect(
        manager.mergeRunWorktree('run-1', { targetBranch: 'main' }),
      ).rejects.toThrow(/rebase-merge/);
      expect(rootGit.status).not.toHaveBeenCalled();
    });

    describe('syncUncommittedToWorktree (mirror host working state)', () => {
      // Each test:
      //   1. seeds files in the host root's filesystem
      //   2. mocks rootGit.status() to report those as the appropriate
      //      uncommitted category (modified/not_added/deleted/renamed)
      //   3. invokes createRunWorktree (or syncUncommittedToRunWorktree)
      //   4. asserts the worktree's filesystem mirrors the host's
      //
      // The git operations themselves are mocked out — we're testing
      // the file-copying logic, not git semantics.
      it('copies untracked-non-gitignored files into a new run worktree', async () => {
        mockRandomUUID
          .mockReturnValueOnce('owner-1')
          .mockReturnValueOnce('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
        const { root, crewHome, manager, rootGit } = createManager();
        writeFileSync(join(root, 'notes.md'), 'untracked content', 'utf-8');
        mkdirSync(join(root, 'docs'), { recursive: true });
        writeFileSync(join(root, 'docs', 'plan.md'), 'plan body', 'utf-8');
        rootGit.status.mockResolvedValue({
          modified: [],
          created: [],
          not_added: ['notes.md', 'docs/plan.md'],
          deleted: [],
          renamed: [],
        });
        await manager.createRunWorktree('run-1');
        const wt = join(crewHome, 'runs', 'run-1', 'worktree');
        expect(readFileSync(join(wt, 'notes.md'), 'utf-8')).toBe('untracked content');
        expect(readFileSync(join(wt, 'docs', 'plan.md'), 'utf-8')).toBe('plan body');
      });

      it('copies tracked-modified files into the worktree', async () => {
        mockRandomUUID
          .mockReturnValueOnce('owner-1')
          .mockReturnValueOnce('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
        const { root, crewHome, manager, rootGit } = createManager();
        writeFileSync(join(root, 'src.ts'), 'export const x = 1; // edited', 'utf-8');
        rootGit.status.mockResolvedValue({
          modified: ['src.ts'],
          created: [],
          not_added: [],
          deleted: [],
          renamed: [],
        });
        await manager.createRunWorktree('run-1');
        const wt = join(crewHome, 'runs', 'run-1', 'worktree');
        expect(readFileSync(join(wt, 'src.ts'), 'utf-8')).toBe('export const x = 1; // edited');
      });

      it('removes tracked-deleted files from the worktree', async () => {
        mockRandomUUID
          .mockReturnValueOnce('owner-1')
          .mockReturnValueOnce('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
        const { crewHome, manager, rootGit } = createManager();
        rootGit.status.mockResolvedValue({
          modified: [],
          created: [],
          not_added: [],
          deleted: ['removed.ts'],
          renamed: [],
        });
        await manager.createRunWorktree('run-1');
        const wt = join(crewHome, 'runs', 'run-1', 'worktree');
        // Pre-seed the deleted file inside the worktree (would have come
        // from `git worktree add` checking out the committed state). Then
        // the next sync should remove it.
        writeFileSync(join(wt, 'removed.ts'), 'old content', 'utf-8');
        await manager.syncUncommittedToRunWorktree('run-1');
        expect(existsSync(join(wt, 'removed.ts'))).toBe(false);
      });

      it('handles renames by copying `to` and removing `from`', async () => {
        mockRandomUUID
          .mockReturnValueOnce('owner-1')
          .mockReturnValueOnce('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
        const { root, crewHome, manager, rootGit } = createManager();
        writeFileSync(join(root, 'new-name.ts'), 'renamed body', 'utf-8');
        rootGit.status.mockResolvedValue({
          modified: [],
          created: [],
          not_added: [],
          deleted: [],
          renamed: [{ from: 'old-name.ts', to: 'new-name.ts' }],
        });
        await manager.createRunWorktree('run-1');
        const wt = join(crewHome, 'runs', 'run-1', 'worktree');
        // Pre-seed the from-side; the sync would delete it.
        writeFileSync(join(wt, 'old-name.ts'), 'stale', 'utf-8');
        await manager.syncUncommittedToRunWorktree('run-1');
        expect(existsSync(join(wt, 'old-name.ts'))).toBe(false);
        expect(readFileSync(join(wt, 'new-name.ts'), 'utf-8')).toBe('renamed body');
      });

      it('syncUncommittedToRunWorktree returns counts', async () => {
        mockRandomUUID
          .mockReturnValueOnce('owner-1')
          .mockReturnValueOnce('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
        const { root, crewHome, manager, rootGit } = createManager();
        writeFileSync(join(root, 'a.md'), 'a', 'utf-8');
        writeFileSync(join(root, 'b.md'), 'b', 'utf-8');
        rootGit.status.mockResolvedValue({
          modified: [],
          created: [],
          not_added: ['a.md', 'b.md'],
          deleted: ['gone.ts'],
          renamed: [],
        });
        await manager.createRunWorktree('run-1');
        const wt = join(crewHome, 'runs', 'run-1', 'worktree');
        writeFileSync(join(wt, 'gone.ts'), 'old', 'utf-8');
        const counts = await manager.syncUncommittedToRunWorktree('run-1');
        expect(counts).toEqual({ copied: 2, removed: 1 });
      });

      it('sync failure during createRunWorktree is non-fatal', async () => {
        mockRandomUUID
          .mockReturnValueOnce('owner-1')
          .mockReturnValueOnce('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
        const { crewHome, manager, rootGit } = createManager();
        // Status throws — sync swallows + warns; createRunWorktree must
        // still return successfully.
        rootGit.status.mockRejectedValueOnce(new Error('git status boom'));
        const wt = await manager.createRunWorktree('run-1');
        expect(wt).toBe(join(crewHome, 'runs', 'run-1', 'worktree'));
        expect(existsSync(wt)).toBe(true);
      });
    });
  });
});
