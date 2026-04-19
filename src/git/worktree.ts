import simpleGit, { type SimpleGit } from 'simple-git';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger.js';

interface WorktreeRecord {
  taskId: string;
  branchName: string;
  worktreePath: string;
  createdAt: string;
}

interface RunWorktreeRecord {
  runId: string;
  branchName: string;
  worktreePath: string;
  createdAt: string;
}

interface TaskLockRecord {
  ownerId: string;
  pid: number;
  acquiredAt: string;
}

export class WorktreeManager {
  private static readonly LOCK_TIMEOUT_MS = 20_000;
  private static readonly LOCK_STALE_MS = 15_000;

  private git: SimpleGit;
  private basePath: string;
  private metadataPath: string;
  private lockPath: string;
  private runBasePath: string;
  private runMetadataPath: string;
  private runLockPath: string;

  constructor(projectRoot: string) {
    this.git = simpleGit(projectRoot);
    this.basePath = join(projectRoot, '.crew', 'worktrees');
    mkdirSync(this.basePath, { recursive: true });
    this.metadataPath = join(this.basePath, '.meta');
    mkdirSync(this.metadataPath, { recursive: true });
    this.lockPath = join(this.basePath, '.locks');
    mkdirSync(this.lockPath, { recursive: true });
    // Run-scoped layout lives under .crew/runs/<runId>/worktree/ (M1.5-14).
    // Metadata + locks sit alongside at .crew/runs/.meta and .crew/runs/.locks
    // so a single run dir deletion cleans its worktree without needing the
    // shared metadata store touched.
    this.runBasePath = join(projectRoot, '.crew', 'runs');
    mkdirSync(this.runBasePath, { recursive: true });
    this.runMetadataPath = join(this.runBasePath, '.meta');
    mkdirSync(this.runMetadataPath, { recursive: true });
    this.runLockPath = join(this.runBasePath, '.locks');
    mkdirSync(this.runLockPath, { recursive: true });
  }

  async createWorktree(taskId: string): Promise<string> {
    return this.withTaskLock(taskId, async () => {
      await this.git.raw(['worktree', 'prune']);

      const existing = await this.resolveExistingWorktree(taskId);
      if (existing) {
        return existing.worktreePath;
      }

      for (let attempt = 0; attempt < 5; attempt++) {
        const record = this.buildWorktreeRecord(taskId);
        try {
          await this.git.raw(['worktree', 'add', '-b', record.branchName, record.worktreePath]);
          try {
            this.writeWorktreeRecord(record);
          } catch (err) {
            const cleanup = await this.cleanupRecordedWorktree(record);
            const message = err instanceof Error ? err.message : String(err);
            if (!cleanup.success) {
              throw new Error(
                `Failed to persist worktree metadata for ${taskId}: ${message}; rollback failed: ${cleanup.errors.join('; ')}`,
              );
            }
            throw err;
          }
          return record.worktreePath;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!this.isRecoverableCreateCollision(message)) {
            throw err;
          }
          logger.warn(`Worktree name collision for ${taskId}; retrying with a new suffix.`);
        }
      }

      throw new Error(`Failed to create a unique worktree for ${taskId} after multiple attempts.`);
    });
  }

  getWorktreePath(taskId: string): string {
    return this.requireWorktreeRecord(taskId).worktreePath;
  }

  async getModifiedFiles(taskId: string): Promise<string[]> {
    const worktreePath = this.getWorktreePath(taskId);
    const worktreeGit = simpleGit(worktreePath);
    const status = await worktreeGit.status();
    return [
      ...status.modified,
      ...status.created,
      ...status.not_added,
      ...status.renamed.map(r => r.to),
    ];
  }

  async mergeWorktree(taskId: string, targetBranch?: string): Promise<void> {
    const record = this.requireWorktreeRecord(taskId);
    const branchName = record.branchName;
    const target = await this.resolveMergeTargetBranch(targetBranch);

    // First, commit any uncommitted changes in the worktree
    const worktreeGit = simpleGit(record.worktreePath);
    const worktreeStatus = await worktreeGit.status();
    if (worktreeStatus.modified.length > 0 || worktreeStatus.created.length > 0 || worktreeStatus.not_added.length > 0) {
      await worktreeGit.add('.');
      await worktreeGit.commit('crew: auto-commit before merge');
    }

    // Refuse to merge if the user's working directory has uncommitted changes
    const mainStatus = await this.git.status();
    if (mainStatus.modified.length > 0 || mainStatus.not_added.length > 0 || mainStatus.created.length > 0) {
      throw new Error(
        `Cannot merge crew/${taskId}: working directory has uncommitted changes. ` +
        'Please commit or stash your changes first.'
      );
    }

    const currentBranch = (await this.git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    if (currentBranch !== target) {
      await this.git.checkout(target);
    }
    await this.git.merge([branchName, '--no-ff', '-m', `Merge crew/${taskId}`]);
  }

  private async resolveMergeTargetBranch(targetBranch?: string): Promise<string> {
    if (targetBranch) return targetBranch;

    try {
      const branch = (await this.git.revparse(['--abbrev-ref', 'HEAD'])).trim();
      if (branch && branch !== 'HEAD') {
        return branch;
      }
    } catch {
      // continue to remote-head fallback
    }

    try {
      const remoteHead = (await this.git.raw([
        'symbolic-ref',
        '--quiet',
        'refs/remotes/origin/HEAD',
      ])).trim();
      const match = remoteHead.match(/^refs\/remotes\/origin\/(.+)$/);
      if (match?.[1]) {
        return match[1];
      }
    } catch {
      // continue to hard fallback
    }

    return 'main';
  }

  async cleanupWorktree(taskId: string): Promise<void> {
    await this.withTaskLock(taskId, async () => {
      const record = this.readWorktreeRecord(taskId);
      if (!record) {
        return;
      }

      const cleanup = await this.cleanupRecordedWorktree(record);
      if (cleanup.success) {
        this.deleteWorktreeRecord(taskId);
      }
    });
  }

  async cleanupAll(): Promise<void> {
    await this.git.raw(['worktree', 'prune']);

    for (const taskId of this.listRecordedTaskIds()) {
      await this.cleanupWorktree(taskId);
    }

    const raw = await this.git.raw(['worktree', 'list', '--porcelain']);
    const worktreeBlocks = raw.split('\n\n')
      .filter(block => block.includes('.crew/worktrees/'));

    for (const block of worktreeBlocks) {
      const pathMatch = block.match(/worktree (.+)/);
      const branchMatch = block.match(/branch refs\/heads\/(.+)/);
      const path = pathMatch?.[1];
      const branch = branchMatch?.[1];

      if (path) {
        try {
          await this.git.raw(['worktree', 'remove', path, '--force']);
        } catch (err) {
          logger.warn(`Failed to remove worktree ${path}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (branch) {
        try {
          await this.git.deleteLocalBranch(branch, true);
        } catch (err) {
          logger.warn(`Failed to delete branch ${branch}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Run-scoped worktree API (M1.5-14)
  //
  // A "run" is a captain-invoked subagent execution keyed by a runId, not the
  // logical task. Concurrent run_agent tool calls get independent runIds and
  // therefore independent worktrees; task.id is still the semantic identifier
  // in session history.
  //
  // The task-keyed API above is preserved for judgment-mode's fallback loop
  // (executeFallbackLoop, slated for deletion in M4-5) and for `git/merge.ts`
  // post-run merges. Once executeFallbackLoop goes away, the task-keyed API
  // can be narrowed or removed.
  // -------------------------------------------------------------------------

  async createRunWorktree(runId: string): Promise<string> {
    return this.withRunLock(runId, async () => {
      await this.git.raw(['worktree', 'prune']);

      const existing = await this.resolveExistingRunWorktree(runId);
      if (existing) {
        return existing.worktreePath;
      }

      for (let attempt = 0; attempt < 5; attempt++) {
        const record = this.buildRunWorktreeRecord(runId);
        try {
          mkdirSync(join(this.runBasePath, this.toRunToken(runId)), { recursive: true });
          await this.git.raw(['worktree', 'add', '-b', record.branchName, record.worktreePath]);
          try {
            this.writeRunWorktreeRecord(record);
          } catch (err) {
            const cleanup = await this.cleanupRunRecordedWorktree(record);
            const message = err instanceof Error ? err.message : String(err);
            if (!cleanup.success) {
              throw new Error(
                `Failed to persist run worktree metadata for ${runId}: ${message}; rollback failed: ${cleanup.errors.join('; ')}`,
              );
            }
            throw err;
          }
          return record.worktreePath;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!this.isRecoverableCreateCollision(message)) {
            throw err;
          }
          logger.warn(`Run worktree name collision for ${runId}; retrying with a new suffix.`);
        }
      }

      throw new Error(`Failed to create a unique run worktree for ${runId} after multiple attempts.`);
    });
  }

  getRunWorktreePath(runId: string): string {
    return this.requireRunWorktreeRecord(runId).worktreePath;
  }

  async getModifiedFilesByRun(runId: string): Promise<string[]> {
    const path = this.getRunWorktreePath(runId);
    const wGit = simpleGit(path);
    const status = await wGit.status();
    return [
      ...status.modified,
      ...status.created,
      ...status.not_added,
      ...status.renamed.map((r) => r.to),
    ];
  }

  async mergeRunWorktree(runId: string, targetBranch?: string): Promise<void> {
    const record = this.requireRunWorktreeRecord(runId);
    const target = await this.resolveMergeTargetBranch(targetBranch);

    const wGit = simpleGit(record.worktreePath);
    const worktreeStatus = await wGit.status();
    if (
      worktreeStatus.modified.length > 0
      || worktreeStatus.created.length > 0
      || worktreeStatus.not_added.length > 0
    ) {
      await wGit.add('.');
      await wGit.commit('crew: auto-commit before merge');
    }

    const mainStatus = await this.git.status();
    if (
      mainStatus.modified.length > 0
      || mainStatus.not_added.length > 0
      || mainStatus.created.length > 0
    ) {
      throw new Error(
        `Cannot merge run ${runId}: working directory has uncommitted changes. `
        + 'Please commit or stash your changes first.',
      );
    }

    const currentBranch = (await this.git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    if (currentBranch !== target) {
      await this.git.checkout(target);
    }
    await this.git.merge([record.branchName, '--no-ff', '-m', `Merge crew run ${runId}`]);
  }

  async cleanupByRunId(runId: string): Promise<void> {
    await this.withRunLock(runId, async () => {
      const record = this.readRunWorktreeRecord(runId);
      if (!record) return;
      const cleanup = await this.cleanupRunRecordedWorktree(record);
      if (cleanup.success) {
        this.deleteRunWorktreeRecord(runId);
        // Remove the run directory (if empty after worktree removal).
        try {
          const runDir = join(this.runBasePath, this.toRunToken(runId));
          if (existsSync(runDir)) {
            rmSync(runDir, { recursive: true, force: true });
          }
        } catch {
          // best-effort
        }
      }
    });
  }

  private async resolveExistingWorktree(taskId: string): Promise<WorktreeRecord | undefined> {
    const record = this.readWorktreeRecord(taskId);
    if (!record) {
      return undefined;
    }

    try {
      const wGit = simpleGit(record.worktreePath);
      await wGit.status();
      return record;
    } catch {
      const cleanup = await this.cleanupRecordedWorktree(record);
      if (!cleanup.success) {
        throw new Error(
          `Failed to repair stale worktree for ${taskId}: ${cleanup.errors.join('; ')}`,
        );
      }
      this.deleteWorktreeRecord(taskId);
      return undefined;
    }
  }

  private async cleanupRecordedWorktree(
    record: WorktreeRecord,
  ): Promise<{ success: boolean; errors: string[] }> {
    const errors: string[] = [];

    try {
      await this.git.raw(['worktree', 'remove', record.worktreePath, '--force']);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!this.isMissingWorktreeError(msg)) {
        logger.warn(`Failed to remove worktree ${record.worktreePath}: ${msg}`);
        errors.push(`remove worktree: ${msg}`);
      }
    }
    try {
      await this.git.deleteLocalBranch(record.branchName, true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!this.isMissingBranchError(msg)) {
        logger.warn(`Failed to delete branch ${record.branchName}: ${msg}`);
        errors.push(`delete branch: ${msg}`);
      }
    }

    return {
      success: errors.length === 0,
      errors,
    };
  }

  private buildWorktreeRecord(taskId: string): WorktreeRecord {
    const token = this.toTaskToken(taskId);
    const suffix = randomUUID().split('-')[0];
    return {
      taskId,
      branchName: `crew/${token}-${suffix}`,
      worktreePath: join(this.basePath, `${token}-${suffix}`),
      createdAt: new Date().toISOString(),
    };
  }

  private metadataFilePath(taskId: string): string {
    return join(this.metadataPath, `${encodeURIComponent(taskId)}.json`);
  }

  private readWorktreeRecord(taskId: string): WorktreeRecord | undefined {
    const metadataPath = this.metadataFilePath(taskId);
    if (!existsSync(metadataPath)) {
      return undefined;
    }

    try {
      return JSON.parse(readFileSync(metadataPath, 'utf-8')) as WorktreeRecord;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid worktree metadata for ${taskId}: ${message}`);
    }
  }

  private writeWorktreeRecord(record: WorktreeRecord): void {
    const targetPath = this.metadataFilePath(record.taskId);
    const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(
      tempPath,
      JSON.stringify(record, null, 2),
      'utf-8',
    );
    renameSync(tempPath, targetPath);
  }

  private deleteWorktreeRecord(taskId: string): void {
    try {
      rmSync(this.metadataFilePath(taskId), { force: true });
    } catch {
      // ignore metadata cleanup errors
    }
  }

  private requireWorktreeRecord(taskId: string): WorktreeRecord {
    const record = this.readWorktreeRecord(taskId);
    if (!record) {
      throw new Error(`No recorded worktree exists for ${taskId}.`);
    }
    return record;
  }

  private toTaskToken(taskId: string): string {
    const normalized = taskId
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return normalized || 'task';
  }

  private isRecoverableCreateCollision(message: string): boolean {
    return (
      message.includes('already exists')
      || message.includes('already checked out')
      || message.includes('is a missing but already registered worktree')
    );
  }

  private listRecordedTaskIds(): string[] {
    return readdirSync(this.metadataPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => decodeURIComponent(entry.name.replace(/\.json$/, '')));
  }

  private async withTaskLock<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const lockDir = join(this.lockPath, encodeURIComponent(taskId));
    const ownerId = randomUUID();
    const lockRecord: TaskLockRecord = {
      ownerId,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    };
    const timeoutAt = Date.now() + WorktreeManager.LOCK_TIMEOUT_MS;

    while (true) {
      try {
        mkdirSync(lockDir);
        try {
          this.writeTaskLockRecord(lockDir, lockRecord);
        } catch (err) {
          rmSync(lockDir, { recursive: true, force: true });
          throw err;
        }
        break;
      } catch (err) {
        if (!this.isLockAlreadyHeldError(err)) {
          throw err;
        }
        if (this.canReclaimTaskLock(lockDir)) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
        if (Date.now() >= timeoutAt) {
          throw new Error(`Timed out waiting for worktree lock on ${taskId}.`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    try {
      return await operation();
    } finally {
      this.releaseTaskLock(lockDir, ownerId);
    }
  }

  private isMissingWorktreeError(message: string): boolean {
    return (
      message.includes('is not a working tree')
      || message.includes('No such file or directory')
      || message.includes('does not exist')
      || message.includes('not found')
    );
  }

  private isMissingBranchError(message: string): boolean {
    return message.includes('not found') || message.includes('No branch');
  }

  private isLockAlreadyHeldError(error: unknown): boolean {
    return (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && (error as { code?: string }).code === 'EEXIST'
    );
  }

  private writeTaskLockRecord(lockDir: string, record: TaskLockRecord): void {
    const targetPath = join(lockDir, 'owner.json');
    const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tempPath, JSON.stringify(record, null, 2), 'utf-8');
    renameSync(tempPath, targetPath);
  }

  private readTaskLockRecord(lockDir: string): TaskLockRecord | undefined {
    const ownerPath = join(lockDir, 'owner.json');
    if (!existsSync(ownerPath)) {
      return undefined;
    }

    try {
      return JSON.parse(readFileSync(ownerPath, 'utf-8')) as TaskLockRecord;
    } catch {
      return undefined;
    }
  }

  private canReclaimTaskLock(lockDir: string): boolean {
    const record = this.readTaskLockRecord(lockDir);
    if (record?.pid && this.isProcessAlive(record.pid)) {
      return false;
    }
    return this.isStaleLock(lockDir);
  }

  private releaseTaskLock(lockDir: string, ownerId: string): void {
    const record = this.readTaskLockRecord(lockDir);
    if (record?.ownerId !== ownerId) {
      return;
    }
    rmSync(lockDir, { recursive: true, force: true });
  }

  private isStaleLock(lockDir: string): boolean {
    try {
      const stats = statSync(lockDir);
      return (Date.now() - stats.mtimeMs) >= WorktreeManager.LOCK_STALE_MS;
    } catch {
      return false;
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (
        typeof err === 'object'
        && err !== null
        && 'code' in err
        && (err as { code?: string }).code === 'EPERM'
      );
    }
  }

  // -------------------------------------------------------------------------
  // Run-scoped worktree internals (M1.5-14)
  // -------------------------------------------------------------------------

  private async resolveExistingRunWorktree(runId: string): Promise<RunWorktreeRecord | undefined> {
    const record = this.readRunWorktreeRecord(runId);
    if (!record) return undefined;
    try {
      const wGit = simpleGit(record.worktreePath);
      await wGit.status();
      return record;
    } catch {
      const cleanup = await this.cleanupRunRecordedWorktree(record);
      if (!cleanup.success) {
        throw new Error(
          `Failed to repair stale run worktree for ${runId}: ${cleanup.errors.join('; ')}`,
        );
      }
      this.deleteRunWorktreeRecord(runId);
      return undefined;
    }
  }

  private async cleanupRunRecordedWorktree(
    record: RunWorktreeRecord,
  ): Promise<{ success: boolean; errors: string[] }> {
    const errors: string[] = [];

    try {
      await this.git.raw(['worktree', 'remove', record.worktreePath, '--force']);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!this.isMissingWorktreeError(msg)) {
        logger.warn(`Failed to remove run worktree ${record.worktreePath}: ${msg}`);
        errors.push(`remove worktree: ${msg}`);
      }
    }
    try {
      await this.git.deleteLocalBranch(record.branchName, true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!this.isMissingBranchError(msg)) {
        logger.warn(`Failed to delete branch ${record.branchName}: ${msg}`);
        errors.push(`delete branch: ${msg}`);
      }
    }

    return {
      success: errors.length === 0,
      errors,
    };
  }

  private buildRunWorktreeRecord(runId: string): RunWorktreeRecord {
    const token = this.toRunToken(runId);
    const suffix = randomUUID().split('-')[0];
    return {
      runId,
      branchName: `crew-run/${token}-${suffix}`,
      worktreePath: join(this.runBasePath, token, 'worktree'),
      createdAt: new Date().toISOString(),
    };
  }

  private runMetadataFilePath(runId: string): string {
    return join(this.runMetadataPath, `${encodeURIComponent(runId)}.json`);
  }

  private readRunWorktreeRecord(runId: string): RunWorktreeRecord | undefined {
    const metadataPath = this.runMetadataFilePath(runId);
    if (!existsSync(metadataPath)) return undefined;
    try {
      return JSON.parse(readFileSync(metadataPath, 'utf-8')) as RunWorktreeRecord;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid run worktree metadata for ${runId}: ${message}`);
    }
  }

  private writeRunWorktreeRecord(record: RunWorktreeRecord): void {
    const targetPath = this.runMetadataFilePath(record.runId);
    const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tempPath, JSON.stringify(record, null, 2), 'utf-8');
    renameSync(tempPath, targetPath);
  }

  private deleteRunWorktreeRecord(runId: string): void {
    try {
      rmSync(this.runMetadataFilePath(runId), { force: true });
    } catch {
      // ignore
    }
  }

  private requireRunWorktreeRecord(runId: string): RunWorktreeRecord {
    const record = this.readRunWorktreeRecord(runId);
    if (!record) {
      throw new Error(`No recorded run worktree exists for ${runId}.`);
    }
    return record;
  }

  private toRunToken(runId: string): string {
    const normalized = runId
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return normalized || 'run';
  }

  private async withRunLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const lockDir = join(this.runLockPath, encodeURIComponent(runId));
    const ownerId = randomUUID();
    const lockRecord: TaskLockRecord = {
      ownerId,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    };
    const timeoutAt = Date.now() + WorktreeManager.LOCK_TIMEOUT_MS;

    while (true) {
      try {
        mkdirSync(lockDir);
        try {
          this.writeTaskLockRecord(lockDir, lockRecord);
        } catch (err) {
          rmSync(lockDir, { recursive: true, force: true });
          throw err;
        }
        break;
      } catch (err) {
        if (!this.isLockAlreadyHeldError(err)) {
          throw err;
        }
        if (this.canReclaimTaskLock(lockDir)) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
        if (Date.now() >= timeoutAt) {
          throw new Error(`Timed out waiting for run worktree lock on ${runId}.`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    try {
      return await operation();
    } finally {
      this.releaseTaskLock(lockDir, ownerId);
    }
  }
}
