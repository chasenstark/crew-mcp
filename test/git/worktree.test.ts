import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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
      expect(rootGit.merge).toHaveBeenCalledWith([
        'crew-run/run-1-aaaaaaaa',
        '--no-ff',
        '-m',
        'Merge crew run run-1',
      ]);
      expect(existsSync(join(crewHome, 'runs', '.meta', 'run-1.json'))).toBe(true);
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
