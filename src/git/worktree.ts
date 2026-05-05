import simpleGit, { type SimpleGit, type StatusResult } from 'simple-git';
import { randomUUID } from 'crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
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

export type MergeRunResult =
  | { status: 'merged'; commitSha: string }
  | { status: 'conflict'; conflicts: string[] }
  | { status: 'no-changes' };

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
  private legacyDirsInitialized = false;
  private runBasePath: string;
  private runMetadataPath: string;
  private runLockPath: string;
  /**
   * Absolute path of the host repo this manager was constructed against.
   * Exposed via `getProjectRoot()` so callers (e.g., run-agent's
   * read-only path) can default working_directory to the host repo
   * without threading a separate parameter.
   */
  private readonly projectRoot: string;

  constructor(options: { projectRoot: string; crewHome: string }) {
    const { projectRoot, crewHome } = options;
    this.projectRoot = projectRoot;
    this.git = simpleGit(projectRoot);
    // Legacy task-keyed layout still rooted at <projectRoot>/.crew/worktrees/.
    // Only reached by v0.1 merge.ts paths the v2 server doesn't use; will
    // be deleted alongside the rest of the v0.1 leftovers in a future sweep.
    // Lazy-init: paths are computed but mkdir is deferred to ensureLegacyDirs()
    // so the host repo's working tree stays clean unless those legacy methods
    // are actually invoked. M3.5 invariant: v2 callers never touch <projectRoot>/.crew/.
    this.basePath = join(projectRoot, '.crew', 'worktrees');
    this.metadataPath = join(this.basePath, '.meta');
    this.lockPath = join(this.basePath, '.locks');
    // Run-scoped layout lives under <crewHome>/runs/<runId>/worktree/ (M3.5).
    // Metadata + locks sit alongside at <crewHome>/runs/.meta and
    // <crewHome>/runs/.locks so a single run dir deletion cleans its
    // worktree without needing the shared metadata store touched. Storing
    // these out of the host repo means git status stays clean and we don't
    // need a gitignore-guard (Finding 7 + M3.5 plan).
    this.runBasePath = join(crewHome, 'runs');
    mkdirSync(this.runBasePath, { recursive: true });
    this.runMetadataPath = join(this.runBasePath, '.meta');
    mkdirSync(this.runMetadataPath, { recursive: true });
    this.runLockPath = join(this.runBasePath, '.locks');
    mkdirSync(this.runLockPath, { recursive: true });
  }

  getProjectRoot(): string {
    return this.projectRoot;
  }

  private ensureLegacyDirs(): void {
    if (this.legacyDirsInitialized) return;
    mkdirSync(this.basePath, { recursive: true });
    mkdirSync(this.metadataPath, { recursive: true });
    mkdirSync(this.lockPath, { recursive: true });
    this.legacyDirsInitialized = true;
  }

  async createWorktree(taskId: string): Promise<string> {
    this.ensureLegacyDirs();
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
    return this.statusChangedFiles(status);
  }

  async mergeWorktree(taskId: string, targetBranch?: string): Promise<void> {
    const record = this.requireWorktreeRecord(taskId);
    const branchName = record.branchName;
    const target = await this.resolveMergeTargetBranch(targetBranch);

    // First, commit any uncommitted changes in the worktree
    const worktreeGit = simpleGit(record.worktreePath);
    const worktreeStatus = await worktreeGit.status();
    if (this.statusChangedFiles(worktreeStatus).length > 0) {
      await worktreeGit.add('.');
      await worktreeGit.commit('crew: auto-commit before merge');
    }

    // Refuse to merge if the user's working directory has uncommitted changes.
    // Pre-M3.5 this filtered out `.crew/...` runtime state living inside the
    // host repo; with run state moved to ~/.crew/runs/ there is nothing to
    // filter — any modified file is a real user change.
    const mainStatus = await this.git.status();
    if (this.statusChangedFiles(mainStatus).length > 0) {
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
    this.ensureLegacyDirs();
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
    this.ensureLegacyDirs();
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
  // The task-keyed API above is preserved for `git/merge.ts` post-run merges
  // (and legacy callers outside the M3 captain loop). Safe to narrow further
  // if/when merge.ts migrates to the run-scoped API.
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
          // Mirror the host repo's uncommitted state into the fresh worktree
          // so the dispatched agent sees the same in-progress files the
          // user does (see syncUncommittedToWorktree). Best-effort: a sync
          // failure is logged but doesn't fail the dispatch — the agent
          // will just operate on committed state in that case.
          try {
            await this.syncUncommittedToWorktree(record.worktreePath);
          } catch (syncErr) {
            logger.warn(
              `Run ${runId}: failed to sync uncommitted state into worktree: ${syncErr instanceof Error ? syncErr.message : String(syncErr)}`,
            );
          }
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

  /**
   * Mirror the host repo's uncommitted state into a run worktree.
   * Untracked-non-gitignored + tracked-modified files get copied;
   * tracked-deleted files (`git rm` or working-tree deletion) get
   * removed in the worktree. Renames apply both: copy `.to`, remove
   * `.from`. Gitignored paths are excluded automatically because
   * simple-git's `status.not_added` honors `.gitignore`.
   *
   * Called once on `createRunWorktree` (so the dispatched agent sees
   * the user's working state) and again on every `continue_run` turn
   * (so changes the user made between turns flow through). Skipped
   * for `read_only` runs — they don't allocate a worktree.
   *
   * Best-effort: per-file failures are warn-logged and don't abort
   * the sync. Returns counts so callers can surface diagnostics.
   */
  async syncUncommittedToRunWorktree(runId: string): Promise<{
    readonly copied: number;
    readonly removed: number;
  }> {
    const record = this.requireRunWorktreeRecord(runId);
    return this.syncUncommittedToWorktree(record.worktreePath);
  }

  /**
   * Internal — called by createRunWorktree + syncUncommittedToRunWorktree.
   * Reads `git status` against the host repo and applies the deltas to
   * `worktreePath`. See the public-method docblock for semantics.
   */
  private async syncUncommittedToWorktree(worktreePath: string): Promise<{
    readonly copied: number;
    readonly removed: number;
  }> {
    const status = await this.git.status();
    const renames = (status.renamed ?? []) as ReadonlyArray<{ from: string; to: string }>;
    const toCopy = new Set<string>([
      ...status.modified,
      ...status.created,
      ...status.not_added,
      ...renames.map((r) => r.to),
    ]);
    const toRemove = new Set<string>([
      ...(status.deleted ?? []),
      ...renames.map((r) => r.from),
    ]);
    let copied = 0;
    let removed = 0;
    for (const relPath of toCopy) {
      const src = join(this.projectRoot, relPath);
      const dst = join(worktreePath, relPath);
      try {
        if (!existsSync(src)) continue;
        const st = statSync(src);
        if (!st.isFile()) continue;
        mkdirSync(dirname(dst), { recursive: true });
        copyFileSync(src, dst);
        copied++;
      } catch (err) {
        logger.warn(
          `syncUncommitted: failed to copy ${relPath} into worktree: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    for (const relPath of toRemove) {
      if (toCopy.has(relPath)) continue;
      const dst = join(worktreePath, relPath);
      try {
        if (existsSync(dst)) {
          rmSync(dst, { force: true });
          removed++;
        }
      } catch (err) {
        logger.warn(
          `syncUncommitted: failed to remove ${relPath} from worktree: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { copied, removed };
  }

  async getModifiedFilesByRun(runId: string): Promise<string[]> {
    const path = this.getRunWorktreePath(runId);
    const wGit = simpleGit(path);
    const status = await wGit.status();
    return this.statusChangedFiles(status);
  }

  async mergeRunWorktree(
    runId: string,
    options: { targetBranch?: string; force?: boolean } = {},
  ): Promise<MergeRunResult> {
    const record = this.requireRunWorktreeRecord(runId);
    const target = await this.resolveMergeTargetBranch(options.targetBranch);

    const wGit = simpleGit(record.worktreePath);
    const worktreeStatus = await wGit.status();
    if (this.statusChangedFiles(worktreeStatus).length > 0) {
      await wGit.add('.');
      await wGit.commit('crew: auto-commit before merge');
    }

    const mainStatus = await this.git.status();
    if (
      !options.force
      && this.statusChangedFiles(mainStatus).length > 0
    ) {
      throw new Error(
        `Cannot merge run ${runId}: working directory has uncommitted changes. `
        + 'Please commit or stash your changes first, or pass force=true.',
      );
    }

    // If the worktree has the same HEAD as the target, there's nothing to
    // merge. Surface that explicitly so the host CLI doesn't generate an
    // empty merge commit.
    const worktreeHead = (await wGit.revparse(['HEAD'])).trim();
    const targetHead = (await this.git.revparse([target])).trim();
    if (worktreeHead === targetHead) {
      return { status: 'no-changes' };
    }

    const currentBranch = (await this.git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    if (currentBranch !== target) {
      await this.git.checkout(target);
    }
    try {
      await this.git.merge([record.branchName, '--no-ff', '-m', `Merge crew run ${runId}`]);
    } catch (err) {
      // simple-git throws on merge conflicts. Capture the conflicting
      // paths and leave the merge in-progress for the user to resolve
      // (this matches `git merge`'s natural behavior).
      const conflicts = await this.detectConflicts();
      if (conflicts.length > 0) {
        return { status: 'conflict', conflicts };
      }
      throw err;
    }
    const commitSha = (await this.git.revparse(['HEAD'])).trim();
    return { status: 'merged', commitSha };
  }

  private async detectConflicts(): Promise<string[]> {
    try {
      const out = await this.git.raw(['diff', '--name-only', '--diff-filter=U']);
      return out
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } catch {
      return [];
    }
  }

  async cleanupByRunId(runId: string): Promise<void> {
    await this.withRunLock(runId, async () => {
      const record = this.readRunWorktreeRecord(runId);
      if (!record) return;
      const cleanup = await this.cleanupRunRecordedWorktree(record);
      if (cleanup.success) {
        this.deleteRunWorktreeRecord(runId);
        // Remove the run directory ONLY if it's empty after the worktree
        // is gone. v2 keeps state.json + events.log alongside the worktree
        // (so get_run_status can still report on a discarded run); we
        // mustn't recursively nuke them. rmdirSync throws on a non-empty
        // dir, which is exactly the signal we want — fall through and
        // leave the dir intact in that case.
        const runDir = join(this.runBasePath, this.toRunToken(runId));
        if (existsSync(runDir)) {
          try {
            rmdirSync(runDir);
          } catch {
            // Non-empty (state.json, events.log present) → keep it.
          }
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

  private statusChangedFiles(status: StatusResult): string[] {
    return [
      ...status.modified,
      ...status.created,
      ...status.not_added,
      ...(status.deleted ?? []),
      ...(status.renamed ?? []).map((r) => r.to),
    ];
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
