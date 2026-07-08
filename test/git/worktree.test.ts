import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'fs';
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
const MERGED_TREE_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TARGET_TREE_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

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
      if (args[0] === '--version') {
        return 'git version 2.38.0';
      }
      if (args[0] === 'merge-tree' && args[1] === '--write-tree') {
        return MERGED_TREE_SHA;
      }
      if (args[0] === 'commit-tree') {
        return 'merged-sha';
      }
      if (args[0] === 'update-ref') {
        return '';
      }
      if (args[0] === 'rev-parse' && args[1]?.endsWith('^{tree}')) {
        return TARGET_TREE_SHA;
      }
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
    it('captures source snapshot signatures byte-identically with async file hashing', async () => {
      const { root, manager, rootGit } = createManager();
      writeFileSync(join(root, 'README.md'), 'changed contents\n', 'utf-8');
      rootGit.revparse.mockImplementation(async (args: string[]) =>
        args[0] === 'HEAD' ? 'head-sha' : 'main');
      rootGit.status.mockResolvedValueOnce({
        modified: ['README.md'],
        created: [],
        not_added: [],
        deleted: [],
        renamed: [],
        files: [{ path: 'README.md', index: ' ', working_dir: 'M' }],
      });

      const result = await (manager as any).captureSourceSnapshotSignature(rootGit, root);
      const digest = createHash('sha256')
        .update(readFileSync(join(root, 'README.md')))
        .digest('hex');

      expect(result).toEqual({
        headSha: 'head-sha',
        signature: `head-sha\nREADME.md${String.fromCharCode(0)}sha256:${digest}`,
      });
    });

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

    it('K-way concurrent createRunWorktree fan-out does not hold the repo lock while dirty sync waits', async () => {
      mockRandomUUID.mockReturnValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const { crewHome, manager, rootGit } = createManager();
      const releaseDirtySync = deferred<void>();
      let dirtySyncStatusCalls = 0;
      rootGit.status.mockImplementation(async () => {
        dirtySyncStatusCalls += 1;
        await releaseDirtySync.promise;
        return {
          modified: [],
          created: [],
          not_added: [],
          deleted: [],
          renamed: [],
        };
      });

      const runIds = Array.from({ length: 5 }, (_, index) => `fanout-${index + 1}`);
      const creates = runIds.map((runId) => manager.createRunWorktree(runId));

      await vi.waitFor(() => {
        expect(rootGit.raw.mock.calls.filter(
          ([args]) => args[0] === 'worktree' && args[1] === 'add',
        )).toHaveLength(5);
      });
      expect(dirtySyncStatusCalls).toBe(5);

      releaseDirtySync.resolve();
      const paths = await Promise.all(creates);
      expect(paths).toEqual(runIds.map((runId) => join(
        crewHome,
        'runs',
        runId,
        'worktree',
      )));
    });

    it('mergeRunWorktree waits for an in-progress fresh dispatch host snapshot copy', async () => {
      mockRandomUUID.mockReturnValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const { crewHome, manager, rootGit } = createManager();
      const mergePath = await manager.createRunWorktree('merge-run');
      const mergeGit = getGitClient(mergePath);
      installHostCheckoutState(rootGit);
      mergeGit.revparse.mockImplementation(async (args: string[]) => (
        args[0] === 'HEAD' ? 'work-head' : 'crew-run/merge-run-aaaaaaaa'
      ));
      rootGit.raw.mockClear();
      rootGit.status.mockClear();
      mergeGit.status.mockClear();

      const releaseDispatchSync = deferred<void>();
      rootGit.status.mockImplementation(async () => {
        await releaseDispatchSync.promise;
        return {
          modified: [],
          created: [],
          not_added: [],
          deleted: [],
          renamed: [],
        };
      });

      const dispatch = manager.createRunWorktree('dispatch-run');
      await vi.waitFor(() => {
        expect(rootGit.status).toHaveBeenCalledTimes(1);
      });

      const merge = manager.mergeRunWorktree('merge-run', { targetBranch: 'main' });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(mergeGit.status).not.toHaveBeenCalled();

      releaseDispatchSync.resolve();
      const [dispatchPath, mergeResult] = await Promise.all([dispatch, merge]);
      expect(dispatchPath).toBe(join(crewHome, 'runs', 'dispatch-run', 'worktree'));
      expect(mergeResult).toMatchObject({ status: 'merged' });
      expect(mergeGit.status).toHaveBeenCalled();
    });

    it('fresh dispatch waits while mergeRunWorktree is between ref advance and host reset', async () => {
      mockRandomUUID.mockReturnValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const { crewHome, manager, rootGit } = createManager();
      const mergePath = await manager.createRunWorktree('merge-run');
      const mergeGit = getGitClient(mergePath);
      installHostCheckoutState(rootGit, { branch: 'main', head: 'target-head', targetHead: 'target-head' });
      mergeGit.revparse.mockImplementation(async (args: string[]) => (
        args[0] === 'HEAD' ? 'work-head' : 'crew-run/merge-run-aaaaaaaa'
      ));
      const releaseReset = deferred<void>();
      rootGit.reset.mockImplementation(async () => {
        await releaseReset.promise;
      });

      const merge = manager.mergeRunWorktree('merge-run', { targetBranch: 'main' });
      await vi.waitFor(() => {
        expect(rootGit.reset).toHaveBeenCalledTimes(1);
      });
      const addCallsBeforeDispatch = rootGit.raw.mock.calls.filter(
        ([args]) => args[0] === 'worktree' && args[1] === 'add',
      ).length;

      const dispatch = manager.createRunWorktree('dispatch-during-merge');
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(rootGit.raw.mock.calls.filter(
        ([args]) => args[0] === 'worktree' && args[1] === 'add',
      )).toHaveLength(addCallsBeforeDispatch);

      releaseReset.resolve();
      const [mergeResult, dispatchPath] = await Promise.all([merge, dispatch]);
      expect(mergeResult).toMatchObject({ status: 'merged' });
      expect(dispatchPath).toBe(join(crewHome, 'runs', 'dispatch-during-merge', 'worktree'));
    });

    it('source snapshots hold the source run lock while signing and copying', async () => {
      mockRandomUUID.mockReturnValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const { crewHome, manager, rootGit } = createManager();
      const sourcePath = await manager.createRunWorktree('source-run');
      const sourceGit = getGitClient(sourcePath);
      installHostCheckoutState(rootGit);
      sourceGit.revparse.mockImplementation(async (args: string[]) => (
        args[0] === 'HEAD' ? 'source-head' : 'crew-run/source-run-aaaaaaaa'
      ));
      rootGit.raw.mockClear();
      const firstSnapshotAssertEntered = deferred<void>();
      const releaseSnapshotAssert = deferred<void>();
      let assertCalls = 0;

      const snapshot = manager.createRunWorktreeFromSource('review-run', {
        sourcePath,
        sourceRunId: 'source-run',
        assertSourceStableAfterSync: async () => {
          assertCalls += 1;
          if (assertCalls === 1) {
            firstSnapshotAssertEntered.resolve();
          }
          await releaseSnapshotAssert.promise;
        },
      });
      await firstSnapshotAssertEntered.promise;

      const merge = manager.mergeRunWorktree('source-run', { targetBranch: 'main' });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(rootGit.raw.mock.calls.some(([args]) => args[0] === 'commit-tree')).toBe(false);

      releaseSnapshotAssert.resolve();
      const [snapshotPath, mergeResult] = await Promise.all([snapshot, merge]);
      expect(snapshotPath).toBe(join(crewHome, 'runs', 'review-run', 'worktree'));
      expect(mergeResult).toMatchObject({ status: 'merged' });
      expect(rootGit.raw.mock.calls.some(([args]) => args[0] === 'commit-tree')).toBe(true);
    });

    it('retries git lock contention while allocating a run worktree', async () => {
      mockRandomUUID
        .mockReturnValueOnce('owner-run-1')
        .mockReturnValueOnce('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

      const { crewHome, manager, rootGit } = createManager();
      const defaultRaw = rootGit.raw.getMockImplementation();
      let addAttempts = 0;
      rootGit.raw.mockImplementation(async (args: string[]) => {
        if (args[0] === 'worktree' && args[1] === 'add') {
          addAttempts += 1;
          if (addAttempts === 1) {
            throw new Error("fatal: Unable to create '.git/packed-refs.lock': File exists");
          }
        }
        return defaultRaw?.(args);
      });

      await expect(manager.createRunWorktree('run-1')).resolves.toBe(
        join(crewHome, 'runs', 'run-1', 'worktree'),
      );
      expect(addAttempts).toBe(2);
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

    it('reclaims a stale repository worktree-add lock whose owner process is gone', async () => {
      mockRandomUUID.mockReturnValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

      const { crewHome, manager, root } = createManager();
      const commonDirRealpath = realpathSync(join(root, '.git'));
      const lockName = createHash('sha256')
        .update(commonDirRealpath)
        .digest('hex')
        .slice(0, 32);
      const lockDir = join(commonDirRealpath, 'crew-merge-lock', lockName);
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(
        join(lockDir, 'owner.json'),
        JSON.stringify({
          ownerId: 'old-repo-owner',
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

    it('syncs uncommitted symlinks as symlinks and preserves regular file mode', async () => {
      mockRandomUUID.mockReturnValueOnce('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

      const { root, manager, rootGit } = createManager();
      writeFileSync(join(root, 'script.sh'), '#!/bin/sh\necho hi\n', 'utf-8');
      chmodSync(join(root, 'script.sh'), 0o755);
      writeFileSync(join(root, 'target.txt'), 'target\n', 'utf-8');
      symlinkSync('target.txt', join(root, 'link.txt'));
      rootGit.status.mockResolvedValueOnce({
        modified: [],
        created: [],
        not_added: ['script.sh', 'link.txt'],
        deleted: [],
        renamed: [],
      });

      const worktreePath = await manager.createRunWorktree('run-1');

      const copiedScript = join(worktreePath, 'script.sh');
      expect(statSync(copiedScript).mode & 0o777).toBe(0o755);
      const copiedLink = join(worktreePath, 'link.txt');
      expect(lstatSync(copiedLink).isSymbolicLink()).toBe(true);
      expect(readlinkSync(copiedLink)).toBe('target.txt');
    });

    it('sync re-copies every dirty path even when destination metadata matches', async () => {
      // Pins the withdrawn P2.5 optimization OUT: size+mtime+mode cannot
      // prove content identity (timestamp-restoring tools defeat it), so a
      // metadata-identical destination with different bytes must still be
      // overwritten by the sync.
      mockRandomUUID.mockReturnValueOnce('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const { manager } = createManager();

      const srcRoot = mkdtempSync(join(tmpdir(), 'crew-sync-src-'));
      const dstRoot = mkdtempSync(join(tmpdir(), 'crew-sync-dst-'));
      try {
        // Same byte length, same mtime, same mode — different content.
        writeFileSync(join(srcRoot, 'f.txt'), 'dirty content\n', 'utf-8');
        writeFileSync(join(dstRoot, 'f.txt'), 'stale content\n', 'utf-8');
        const stamp = new Date('2026-07-01T00:00:00.000Z');
        utimesSync(join(srcRoot, 'f.txt'), stamp, stamp);
        utimesSync(join(dstRoot, 'f.txt'), stamp, stamp);
        chmodSync(join(srcRoot, 'f.txt'), 0o644);
        chmodSync(join(dstRoot, 'f.txt'), 0o644);

        const srcGit = getGitClient(srcRoot);
        srcGit.status.mockResolvedValueOnce({
          modified: ['f.txt'],
          created: [],
          not_added: [],
          deleted: [],
          renamed: [],
        });

        const result = await manager.syncUncommittedFromPathToWorktree(srcRoot, dstRoot);
        expect(result.copied).toBe(1);
        expect(readFileSync(join(dstRoot, 'f.txt'), 'utf-8')).toBe('dirty content\n');
      } finally {
        rmSync(srcRoot, { recursive: true, force: true });
        rmSync(dstRoot, { recursive: true, force: true });
      }
    });

    it('skips uncommitted symlinks that point outside the project root', async () => {
      mockRandomUUID.mockReturnValueOnce('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const { root, manager, rootGit } = createManager();
      const outsideAbsolute = join(tmpdir(), `crew-outside-${Date.now()}`);
      const outsideRelative = '../crew-relative-outside';
      writeFileSync(join(root, 'target.txt'), 'target\n', 'utf-8');
      symlinkSync('target.txt', join(root, 'in-repo-link.txt'));
      symlinkSync(outsideAbsolute, join(root, 'absolute-outside-link.txt'));
      symlinkSync(outsideRelative, join(root, 'relative-outside-link.txt'));
      rootGit.status.mockResolvedValueOnce({
        modified: [],
        created: [],
        not_added: [
          'in-repo-link.txt',
          'absolute-outside-link.txt',
          'relative-outside-link.txt',
        ],
        deleted: [],
        renamed: [],
      });

      const worktreePath = await manager.createRunWorktree('run-1');

      const copiedLink = join(worktreePath, 'in-repo-link.txt');
      expect(lstatSync(copiedLink).isSymbolicLink()).toBe(true);
      expect(readlinkSync(copiedLink)).toBe('target.txt');
      expect(existsSync(join(worktreePath, 'absolute-outside-link.txt'))).toBe(false);
      expect(existsSync(join(worktreePath, 'relative-outside-link.txt'))).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('skipped unsafe symlink absolute-outside-link.txt'),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('skipped unsafe symlink relative-outside-link.txt'),
      );
    });

    it('skips chained symlinks that resolve outside the project root and preserves in-repo chains', async () => {
      mockRandomUUID.mockReturnValueOnce('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const { root, manager, rootGit } = createManager();
      const outsideDir = mkdtempSync(join(tmpdir(), 'crew-outside-chain-'));
      tempDirs.push(outsideDir);
      writeFileSync(join(outsideDir, 'outside.txt'), 'outside\n', 'utf-8');
      writeFileSync(join(root, 'safe-target.txt'), 'safe\n', 'utf-8');
      symlinkSync(join(outsideDir, 'outside.txt'), join(root, 'unsafe-intermediate.txt'));
      symlinkSync('unsafe-intermediate.txt', join(root, 'unsafe-chain-link.txt'));
      symlinkSync('safe-target.txt', join(root, 'safe-intermediate.txt'));
      symlinkSync('safe-intermediate.txt', join(root, 'safe-chain-link.txt'));
      rootGit.status.mockResolvedValueOnce({
        modified: [],
        created: [],
        not_added: [
          'safe-target.txt',
          'unsafe-intermediate.txt',
          'unsafe-chain-link.txt',
          'safe-intermediate.txt',
          'safe-chain-link.txt',
        ],
        deleted: [],
        renamed: [],
      });

      const worktreePath = await manager.createRunWorktree('run-1');

      expect(existsSync(join(worktreePath, 'unsafe-intermediate.txt'))).toBe(false);
      expect(existsSync(join(worktreePath, 'unsafe-chain-link.txt'))).toBe(false);
      const copiedSafeIntermediate = join(worktreePath, 'safe-intermediate.txt');
      expect(lstatSync(copiedSafeIntermediate).isSymbolicLink()).toBe(true);
      expect(readlinkSync(copiedSafeIntermediate)).toBe('safe-target.txt');
      const copiedSafeLink = join(worktreePath, 'safe-chain-link.txt');
      expect(lstatSync(copiedSafeLink).isSymbolicLink()).toBe(true);
      expect(readlinkSync(copiedSafeLink)).toBe('safe-intermediate.txt');
      expect(readFileSync(copiedSafeLink, 'utf-8')).toBe('safe\n');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('skipped unsafe symlink unsafe-chain-link.txt'),
      );
    });

    it('times out instead of reclaiming a run lock held by a live process', async () => {
      mockRandomUUID.mockReturnValueOnce('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

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
        .mockResolvedValueOnce('main')          // capture original branch (also default target)
        .mockResolvedValueOnce('pre-merge-sha') // capture original HEAD
        .mockResolvedValueOnce('target-sha')    // no-changes check: revparse([target])
        .mockResolvedValueOnce('merged-sha');   // post-landing probe

      const result = await manager.mergeRunWorktree('run-1');

      expect(result).toMatchObject({ status: 'merged', commitSha: 'merged-sha' });
      expect(rootGit.merge).not.toHaveBeenCalled();
      expect(rootGit.raw).toHaveBeenCalledWith(['merge-tree', '--write-tree', 'target-sha', 'worktree-sha']);
      expect(rootGit.raw).toHaveBeenCalledWith(['commit-tree', MERGED_TREE_SHA, '-p', 'target-sha', '-m', 'crew run run-1']);
      expect(rootGit.raw).toHaveBeenCalledWith(['update-ref', 'refs/heads/main', 'merged-sha', 'target-sha']);
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
      expect(rootGit.raw).toHaveBeenCalledWith(['merge-tree', '--write-tree', 'target-sha', 'worktree-sha']);
      expect(rootGit.raw).toHaveBeenCalledWith(['commit-tree', MERGED_TREE_SHA, '-p', 'target-sha', '-m', 'crew run run-1']);
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
        .mockResolvedValueOnce('main')          // capture original branch (also default target)
        .mockResolvedValueOnce('pre-merge-sha') // capture original HEAD
        .mockResolvedValueOnce('target-sha')    // no-changes check
        .mockResolvedValueOnce('merged-sha');

      const result = await manager.mergeRunWorktree('run-1', {
        commitTitle: 'fix(parser): handle empty-line input correctly',
        commitBody: 'Adds the empty-line guard to parseLine() with a regression test.',
      });

      expect(result).toMatchObject({ status: 'merged', commitSha: 'merged-sha' });
      expect(rootGit.raw).toHaveBeenCalledWith([
        'commit-tree',
        MERGED_TREE_SHA,
        '-p',
        'target-sha',
        '-m',
        [
          'fix(parser): handle empty-line input correctly',
          '',
          'Adds the empty-line guard to parseLine() with a regression test.',
        ].join('\n'),
      ]);
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
        .mockResolvedValueOnce('main')          // capture original branch (also default target)
        .mockResolvedValueOnce('pre-merge-sha') // capture original HEAD
        .mockResolvedValueOnce('target-sha')    // no-changes check
        .mockResolvedValueOnce('merged-sha');

      await manager.mergeRunWorktree('run-1', {
        commitTitle: 'docs: update README install steps',
      });

      expect(rootGit.raw).toHaveBeenCalledWith([
        'commit-tree',
        MERGED_TREE_SHA,
        '-p',
        'target-sha',
        '-m',
        'docs: update README install steps',
      ]);
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

    it('mergeRunWorktree treats an empty target_branch as "use the default"', async () => {
      // Regression: `options.targetBranch ?? checkout` would accept "" as an
      // explicit target and feed `git rev-parse ''`; truthiness must keep ""
      // meaning default resolution, as it did in resolveMergeTargetBranch.
      mockRandomUUID
        .mockReturnValueOnce('owner-1')
        .mockReturnValueOnce('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const { manager, rootGit } = createManager();
      const wPath = await manager.createRunWorktree('run-1');
      const wGit = getGitClient(wPath);
      wGit.revparse.mockResolvedValueOnce('worktree-sha');
      rootGit.revparse
        .mockResolvedValueOnce('main')          // capture original branch (becomes target)
        .mockResolvedValueOnce('pre-merge-sha') // capture original HEAD
        .mockResolvedValueOnce('target-sha')    // no-changes check: revparse(['main'])
        .mockResolvedValueOnce('merged-sha');

      const result = await manager.mergeRunWorktree('run-1', { targetBranch: '' });

      expect(result).toMatchObject({ status: 'merged', commitSha: 'merged-sha' });
      expect(rootGit.raw).toHaveBeenCalledWith(['update-ref', 'refs/heads/main', 'merged-sha', 'target-sha']);
      expect(rootGit.revparse).toHaveBeenCalledWith(['main']);
      expect(rootGit.revparse).not.toHaveBeenCalledWith(['']);
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
        .mockResolvedValueOnce('main')      // capture original branch (also default target)
        .mockResolvedValueOnce('host-head') // capture original HEAD
        .mockResolvedValueOnce('same-sha'); // no-changes check: revparse([target])
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
        .mockResolvedValueOnce('main')              // capture original branch (also default target)
        .mockResolvedValueOnce('pre-merge-sha')     // capture original HEAD
        .mockResolvedValueOnce('main-head-sha')     // no-changes check: != actual-work-sha
        .mockResolvedValueOnce('post-merge-sha');   // post-landing probe

      const result = await manager.mergeRunWorktree('run-1');

      expect(result).toMatchObject({ status: 'merged', commitSha: 'merged-sha' });
      // The squash target must be the worktree's actual HEAD SHA — not
      // `record.branchName` ('crew-run/run-1-aaaaaaaa'), which would
      // silently no-op when the agent worked on a different branch.
      expect(rootGit.raw).toHaveBeenCalledWith(['merge-tree', '--write-tree', 'main-head-sha', 'actual-work-sha']);
    });

    it('mergeRunWorktree warn-logs when worktree HEAD is on a different branch than record.branchName', async () => {
      // Captures the orphan-branch case from the merge_run fix: the
      // agent committed on a non-recorded branch (e.g., codex sandbox
      // forced one). Merging by SHA captures the work, but the actual
      // branch ref persists locally after cleanup. Warn so the user
      // knows.
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      mockRandomUUID.mockReturnValueOnce('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
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
      mockRandomUUID.mockReturnValueOnce('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
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
        .mockResolvedValueOnce('main')          // capture original branch (also default target)
        .mockResolvedValueOnce('pre-merge-sha') // capture original HEAD
        .mockResolvedValueOnce('target-head')   // no-changes check (!= work-head)
        .mockResolvedValueOnce('ff-sha');       // final HEAD
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
        .mockResolvedValueOnce('main')          // capture original branch (also default target)
        .mockResolvedValueOnce('pre-merge-sha') // capture original HEAD
        .mockResolvedValueOnce('target-head')   // no-changes check
        .mockResolvedValueOnce('picked-sha');   // final HEAD
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

    it('mergeRunWorktree leaves the original checkout untouched after an off-branch squash result', async () => {
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
        commitSha: 'merged-sha',
        targetBranch: 'main',
        originalBranch: 'feature',
        originalHead: 'feature-head',
        landedOffCurrentBranch: true,
      });
      expect(host.branch()).toBe('feature');
      expect(host.head()).toBe('feature-head');
      expect(rootGit.checkout).not.toHaveBeenCalled();
    });

    it('mergeRunWorktree advances a clean checked-out target branch after plumbing squash', async () => {
      mockRandomUUID.mockReturnValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const { manager, rootGit } = createManager();
      const wPath = await manager.createRunWorktree('run-1');
      const wGit = getGitClient(wPath);
      installHostCheckoutState(rootGit, {
        branch: 'main',
        head: 'target-head',
        targetHead: 'target-head',
      });
      wGit.revparse.mockImplementation(async (args: string[]) => (
        args[0] === 'HEAD' ? 'work-head' : 'crew-run/run-1-aaaaaaaa'
      ));

      const result = await manager.mergeRunWorktree('run-1', { targetBranch: 'main' });

      expect(result).toMatchObject({
        status: 'merged',
        commitSha: 'merged-sha',
        targetBranch: 'main',
        originalBranch: 'main',
        originalHead: 'target-head',
        landedOffCurrentBranch: false,
      });
      expect(rootGit.raw).toHaveBeenCalledWith(['update-ref', 'refs/heads/main', 'merged-sha', 'target-head']);
      expect(rootGit.reset).toHaveBeenCalledWith(['--hard', 'merged-sha']);
      expect(rootGit.checkout).not.toHaveBeenCalled();
    });

    it('mergeRunWorktree reports merged with a warning when the post-landing reset fails', async () => {
      mockRandomUUID.mockReturnValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const { manager, rootGit } = createManager();
      const wPath = await manager.createRunWorktree('run-1');
      const wGit = getGitClient(wPath);
      installHostCheckoutState(rootGit, {
        branch: 'main',
        head: 'target-head',
        targetHead: 'target-head',
      });
      wGit.revparse.mockImplementation(async (args: string[]) => (
        args[0] === 'HEAD' ? 'work-head' : 'crew-run/run-1-aaaaaaaa'
      ));
      rootGit.reset.mockRejectedValueOnce(new Error('EACCES: permission denied'));

      const result = await manager.mergeRunWorktree('run-1', { targetBranch: 'main' });

      // The ref is already landed when the reset runs, so a reset failure
      // must not undo or fail the merge — it degrades to a warning.
      expect(result).toMatchObject({
        status: 'merged',
        commitSha: 'merged-sha',
        targetBranch: 'main',
        restoreFailed: true,
      });
      expect(result.status === 'merged' && result.restoreWarning).toContain(
        "'git reset --hard' failed to advance the checked-out working tree",
      );
      expect(result.status === 'merged' && result.restoreWarning).toContain('EACCES');
      expect(rootGit.raw).toHaveBeenCalledWith(['update-ref', 'refs/heads/main', 'merged-sha', 'target-head']);
    });

    it('mergeRunWorktree leaves the host untouched after a conflict result', async () => {
      mockRandomUUID.mockReturnValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const { manager, rootGit } = createManager();
      const wPath = await manager.createRunWorktree('run-1');
      const wGit = getGitClient(wPath);
      const host = installHostCheckoutState(rootGit);
      wGit.revparse.mockImplementation(async (args: string[]) => (
        args[0] === 'HEAD' ? 'work-head' : 'crew-run/run-1-aaaaaaaa'
      ));
      const defaultRaw = rootGit.raw.getMockImplementation();
      rootGit.raw.mockImplementation(async (args: string[]) => {
        if (args[0] === 'merge-tree') {
          throw new Error(
            'CONFLICT (content): Merge conflict in shared.txt\n'
            + '100644 e484e3b90b47688ab4aae72c82f24ff4d1ef32dd 2\tshared.txt\n',
          );
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
      expect(host.branch()).toBe('feature');
      expect(host.head()).toBe('feature-head');
      expect(rootGit.checkout).not.toHaveBeenCalled();
      expect(wGit.merge).not.toHaveBeenCalled();
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
        commitSha: 'merged-sha',
        targetBranch: 'main',
        originalHead: 'detached-sha',
        landedOffCurrentBranch: true,
      });
      expect(result).not.toHaveProperty('originalBranch');
      expect(host.branch()).toBe('HEAD');
      expect(host.head()).toBe('detached-sha');
      expect(rootGit.checkout).not.toHaveBeenCalled();
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
      let commitTreeCalls = 0;
      const defaultRaw = rootGit.raw.getMockImplementation();
      rootGit.raw.mockImplementation(async (args: string[]) => {
        if (args[0] === 'commit-tree') {
          commitTreeCalls += 1;
          if (commitTreeCalls === 1) {
            await firstMergeMayFinish.promise;
          }
        }
        return defaultRaw?.(args);
      });

      const first = manager.mergeRunWorktree('run-1', { targetBranch: 'main' });
      await vi.waitFor(() => {
        expect(rootGit.raw.mock.calls.filter(([args]) => args[0] === 'commit-tree')).toHaveLength(1);
      });

      const second = manager.mergeRunWorktree('run-2', { targetBranch: 'main' });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(secondGit.status).not.toHaveBeenCalled();

      firstMergeMayFinish.resolve();
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(firstResult).toMatchObject({ status: 'merged' });
      expect(secondResult).toMatchObject({ status: 'merged' });
      expect(rootGit.raw.mock.calls.filter(([args]) => args[0] === 'commit-tree')).toHaveLength(2);
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
      let commitTreeCalls = 0;
      const defaultRaw = first.rootGit.raw.getMockImplementation();
      first.rootGit.raw.mockImplementation(async (args: string[]) => {
        if (args[0] === 'commit-tree') {
          commitTreeCalls += 1;
          if (commitTreeCalls === 1) {
            await firstMergeMayFinish.promise;
          }
        }
        return defaultRaw?.(args);
      });

      const firstMerge = first.manager.mergeRunWorktree('run-1', { targetBranch: 'main' });
      await vi.waitFor(() => {
        expect(first.rootGit.raw.mock.calls.filter(([args]) => args[0] === 'commit-tree')).toHaveLength(1);
      });

      const secondMerge = second.manager.mergeRunWorktree('run-2', { targetBranch: 'main' });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(secondGit.status).not.toHaveBeenCalled();

      firstMergeMayFinish.resolve();
      const [firstResult, secondResult] = await Promise.all([firstMerge, secondMerge]);

      expect(firstResult).toMatchObject({ status: 'merged' });
      expect(secondResult).toMatchObject({ status: 'merged' });
      expect(first.rootGit.raw.mock.calls.filter(([args]) => args[0] === 'commit-tree')).toHaveLength(2);
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
