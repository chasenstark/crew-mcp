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
    tempDirs.push(root, crewHome);
    return {
      root,
      crewHome,
      manager: new WorktreeManager({ projectRoot: root, crewHome }),
      rootGit: getGitClient(root),
    };
  }

  function createManagerForRoot(root: string, crewHome: string) {
    tempDirs.push(root, crewHome);
    return {
      root,
      crewHome,
      manager: new WorktreeManager({ projectRoot: root, crewHome }),
      rootGit: getGitClient(root),
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

  it('serializes concurrent creates for the same task and reuses the recorded path', async () => {
    mockRandomUUID.mockReturnValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

    const { root, manager, rootGit } = createManager();
    const defaultRaw = rootGit.raw.getMockImplementation();
    rootGit.raw.mockImplementation(async (args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'add') {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return defaultRaw?.(args);
    });

    const [firstPath, secondPath] = await Promise.all([
      manager.createWorktree('Task 1'),
      manager.createWorktree('Task 1'),
    ]);

    expect(firstPath).toBe(join(root, '.crew', 'worktrees', 'task-1-aaaaaaaa'));
    expect(secondPath).toBe(firstPath);
    expect(
      rootGit.raw.mock.calls.filter(([args]) => args[0] === 'worktree' && args[1] === 'add'),
    ).toHaveLength(1);

    const metadata = JSON.parse(
      readFileSync(join(root, '.crew', 'worktrees', '.meta', 'Task%201.json'), 'utf-8'),
    );
    expect(metadata).toMatchObject({
      taskId: 'Task 1',
      branchName: 'crew/task-1-aaaaaaaa',
      worktreePath: firstPath,
    });
  });

  it('retries with a fresh random suffix when git reports a collision', async () => {
    mockRandomUUID
      .mockReturnValueOnce('lock-owner-1')
      .mockReturnValueOnce('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
      .mockReturnValueOnce('bbbbbbbb-cccc-dddd-eeee-ffffffffffff');

    const { root, manager, rootGit } = createManager();
    const defaultRaw = rootGit.raw.getMockImplementation();
    rootGit.raw.mockImplementation(async (args: string[]) => {
      if (
        args[0] === 'worktree'
        && args[1] === 'add'
        && args[3] === 'crew/task-1-aaaaaaaa'
      ) {
        throw new Error("fatal: a branch named 'crew/task-1-aaaaaaaa' already exists");
      }
      return defaultRaw?.(args);
    });

    const worktreePath = await manager.createWorktree('task-1');

    expect(worktreePath).toBe(join(root, '.crew', 'worktrees', 'task-1-bbbbbbbb'));
    expect(
      rootGit.raw.mock.calls.filter(([args]) => args[0] === 'worktree' && args[1] === 'add'),
    ).toHaveLength(2);
  });

  it('reclaims stale per-task locks left behind by crashed processes', async () => {
    mockRandomUUID.mockReturnValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

    const { root, manager, rootGit } = createManager();
    const lockDir = join(root, '.crew', 'worktrees', '.locks', 'task-1');
    mkdirSync(lockDir, { recursive: true });
    utimesSync(lockDir, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

    const worktreePath = await manager.createWorktree('task-1');

    expect(worktreePath).toBe(join(root, '.crew', 'worktrees', 'task-1-aaaaaaaa'));
    expect(
      rootGit.raw.mock.calls.filter(([args]) => args[0] === 'worktree' && args[1] === 'add'),
    ).toHaveLength(1);
  });

  it('does not reclaim an old lock that still belongs to a live process', async () => {
    mockRandomUUID.mockReturnValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

    const { root, manager, rootGit } = createManager();
    const lockDir = join(root, '.crew', 'worktrees', '.locks', 'task-1');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, 'owner.json'),
      JSON.stringify({
        ownerId: 'existing-owner',
        pid: process.pid,
        acquiredAt: new Date(Date.now() - 60_000).toISOString(),
      }),
      'utf-8',
    );
    utimesSync(lockDir, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

    const worktreeManagerClass = WorktreeManager as unknown as {
      LOCK_TIMEOUT_MS: number;
    };
    const originalTimeout = worktreeManagerClass.LOCK_TIMEOUT_MS;
    worktreeManagerClass.LOCK_TIMEOUT_MS = 100;

    try {
      await expect(manager.createWorktree('task-1')).rejects.toThrow(
        'Timed out waiting for worktree lock on task-1.',
      );
    } finally {
      worktreeManagerClass.LOCK_TIMEOUT_MS = originalTimeout;
    }

    expect(
      rootGit.raw.mock.calls.filter(([args]) => args[0] === 'worktree' && args[1] === 'add'),
    ).toHaveLength(0);
  });

  it('releases the lock directory when recording lock ownership fails', async () => {
    mockRandomUUID.mockReturnValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

    const { root, manager, rootGit } = createManager();
    const writeTaskLockRecord = vi
      .spyOn(manager as any, 'writeTaskLockRecord')
      .mockImplementationOnce(() => {
        throw new Error('lock write failed');
      });

    await expect(manager.createWorktree('task-1')).rejects.toThrow('lock write failed');
    writeTaskLockRecord.mockRestore();

    const worktreePath = await manager.createWorktree('task-1');

    expect(worktreePath).toBe(join(root, '.crew', 'worktrees', 'task-1-aaaaaaaa'));
    expect(
      rootGit.raw.mock.calls.filter(([args]) => args[0] === 'worktree' && args[1] === 'add'),
    ).toHaveLength(1);
  });

  it('merges using the randomized branch recorded in metadata', async () => {
    mockRandomUUID.mockReturnValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

    const { manager, rootGit } = createManager();
    await manager.createWorktree('task-1');

    await manager.mergeWorktree('task-1');

    expect(rootGit.merge).toHaveBeenCalledWith([
      'crew/task-1-aaaaaaaa',
      '--no-ff',
      '-m',
      'Merge crew/task-1',
    ]);
  });

  it('cleans up the randomized worktree and removes its metadata', async () => {
    mockRandomUUID.mockReturnValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

    const { root, manager, rootGit } = createManager();
    const worktreePath = await manager.createWorktree('task-1');

    await manager.cleanupWorktree('task-1');

    expect(rootGit.raw).toHaveBeenCalledWith(['worktree', 'remove', worktreePath, '--force']);
    expect(rootGit.deleteLocalBranch).toHaveBeenCalledWith('crew/task-1-aaaaaaaa', true);
    expect(existsSync(join(root, '.crew', 'worktrees', '.meta', 'task-1.json'))).toBe(false);
  });

  it('preserves metadata when cleanup cannot fully remove the recorded worktree', async () => {
    mockRandomUUID.mockReturnValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

    const { root, manager, rootGit } = createManager();
    await manager.createWorktree('task-1');

    const defaultRaw = rootGit.raw.getMockImplementation();
    rootGit.raw.mockImplementation(async (args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        throw new Error('permission denied');
      }
      return defaultRaw?.(args);
    });

    await manager.cleanupWorktree('task-1');

    expect(existsSync(join(root, '.crew', 'worktrees', '.meta', 'task-1.json'))).toBe(true);
  });

  it('rolls back the created worktree when metadata persistence fails', async () => {
    mockRandomUUID.mockReturnValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

    const { root, manager, rootGit } = createManager();
    vi.spyOn(manager as never, 'writeWorktreeRecord').mockImplementation(() => {
      throw new Error('disk full');
    });

    await expect(manager.createWorktree('task-1')).rejects.toThrow('disk full');

    expect(rootGit.raw).toHaveBeenCalledWith([
      'worktree',
      'remove',
      join(root, '.crew', 'worktrees', 'task-1-aaaaaaaa'),
      '--force',
    ]);
    expect(rootGit.deleteLocalBranch).toHaveBeenCalledWith('crew/task-1-aaaaaaaa', true);
    expect(existsSync(join(root, '.crew', 'worktrees', '.meta', 'task-1.json'))).toBe(false);
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

    it('withRunLock does not block withTaskLock operations on the same id', async () => {
      mockRandomUUID
        .mockReturnValueOnce('run-owner-1')
        .mockReturnValueOnce('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
        .mockReturnValueOnce('task-owner-1')
        .mockReturnValueOnce('bbbbbbbb-cccc-dddd-eeee-ffffffffffff');

      const { manager } = createManager();
      // Both operate concurrently on the same id but different lock spaces.
      const [runPath, taskPath] = await Promise.all([
        manager.createRunWorktree('shared'),
        manager.createWorktree('shared'),
      ]);
      expect(runPath).not.toBe(taskPath);
    });

    it('existing task-keyed tests are unaffected: task-keyed API path lives at .crew/worktrees/', async () => {
      mockRandomUUID
        .mockReturnValueOnce('owner-task')
        .mockReturnValueOnce('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const { root, manager } = createManager();
      const path = await manager.createWorktree('task-1');
      expect(path).toBe(join(root, '.crew', 'worktrees', 'task-1-aaaaaaaa'));
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
        .mockResolvedValueOnce('main')        // current-branch check
        .mockResolvedValueOnce('merged-sha'); // post-merge commitSha

      const result = await manager.mergeRunWorktree('run-1');

      expect(result).toEqual({ status: 'merged', commitSha: 'merged-sha' });
      // Fallback message when no commit_title is supplied:
      // generic subject + Crew-Run trailer. Merge target is the
      // worktree's actual HEAD SHA, not the recorded branch ref —
      // see the bug fix in mergeRunWorktree() for rationale.
      expect(rootGit.merge).toHaveBeenCalledWith([
        'worktree-sha',
        '--no-ff',
        '-m',
        'Merge crew run run-1\n\nCrew-Run: run-1',
      ]);
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

      await expect(merge).resolves.toEqual({ status: 'merged', commitSha: 'merged-sha' });
      expect(rootGit.merge).toHaveBeenCalledWith([
        'worktree-sha',
        '--no-ff',
        '-m',
        'Merge crew run run-1\n\nCrew-Run: run-1',
      ]);
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
        .mockResolvedValueOnce('merged-sha');

      const result = await manager.mergeRunWorktree('run-1', {
        commitTitle: 'fix(parser): handle empty-line input correctly',
        commitBody: 'Adds the empty-line guard to parseLine() with a regression test.',
      });

      expect(result).toEqual({ status: 'merged', commitSha: 'merged-sha' });
      expect(rootGit.merge).toHaveBeenCalledWith([
        'worktree-sha',
        '--no-ff',
        '-m',
        [
          'fix(parser): handle empty-line input correctly',
          '',
          'Adds the empty-line guard to parseLine() with a regression test.',
          '',
          'Crew-Run: run-1',
        ].join('\n'),
      ]);
    });

    it('mergeRunWorktree commit_title without commit_body still appends the Crew-Run trailer', async () => {
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

      expect(rootGit.merge).toHaveBeenCalledWith([
        'worktree-sha',
        '--no-ff',
        '-m',
        'docs: update README install steps\n\nCrew-Run: run-1',
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
      expect(result).toEqual({ status: 'no-changes' });
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
        .mockResolvedValueOnce('main')              // current-branch check
        .mockResolvedValueOnce('post-merge-sha');   // commitSha after merge

      const result = await manager.mergeRunWorktree('run-1');

      expect(result).toEqual({ status: 'merged', commitSha: 'post-merge-sha' });
      // The merge target must be the worktree's actual HEAD SHA — not
      // `record.branchName` ('crew-run/run-1-aaaaaaaa'), which would
      // silently no-op when the agent worked on a different branch.
      expect(rootGit.merge).toHaveBeenCalledWith([
        'actual-work-sha',
        '--no-ff',
        '-m',
        'Merge crew run run-1\n\nCrew-Run: run-1',
      ]);
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
