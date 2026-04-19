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
    tempDirs.push(root);
    return {
      root,
      manager: new WorktreeManager(root),
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

      const { root, manager } = createManager();
      const [a, b] = await Promise.all([
        manager.createRunWorktree('run-1'),
        manager.createRunWorktree('run-2'),
      ]);
      expect(a).toBe(join(root, '.crew', 'runs', 'run-1', 'worktree'));
      expect(b).toBe(join(root, '.crew', 'runs', 'run-2', 'worktree'));
    });

    it('cleanupByRunId removes the worktree + run dir without touching siblings', async () => {
      mockRandomUUID
        .mockReturnValueOnce('owner-1')
        .mockReturnValueOnce('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
        .mockReturnValueOnce('owner-2')
        .mockReturnValueOnce('bbbbbbbb-cccc-dddd-eeee-ffffffffffff')
        .mockReturnValueOnce('cleanup-owner-1');

      const { root, manager } = createManager();
      await manager.createRunWorktree('run-1');
      await manager.createRunWorktree('run-2');
      expect(existsSync(join(root, '.crew', 'runs', 'run-1'))).toBe(true);
      expect(existsSync(join(root, '.crew', 'runs', 'run-2'))).toBe(true);

      await manager.cleanupByRunId('run-1');

      expect(existsSync(join(root, '.crew', 'runs', 'run-1'))).toBe(false);
      expect(existsSync(join(root, '.crew', 'runs', 'run-2'))).toBe(true);
    });

    it('.meta/<runId>.json is written and removed in lockstep with the worktree', async () => {
      mockRandomUUID
        .mockReturnValueOnce('owner-1')
        .mockReturnValueOnce('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
        .mockReturnValueOnce('cleanup-owner-1');

      const { root, manager } = createManager();
      const metaPath = join(root, '.crew', 'runs', '.meta', 'run-1.json');

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
  });
});
