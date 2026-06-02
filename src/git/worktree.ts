import simpleGit, { type SimpleGit, type StatusResult } from 'simple-git';
import { randomUUID } from 'crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { logger } from '../utils/logger.js';

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

export interface RunGitCommitWritablePaths {
  readonly worktreeGitDir: string;
  readonly objectsDir: string;
  readonly branchRefsDir: string;
  readonly branchLogsDir: string;
  readonly paths: readonly string[];
}

interface RunLockRecord {
  ownerId: string;
  pid: number;
  acquiredAt: string;
}

export class WorktreeManager {
  private static readonly LOCK_TIMEOUT_MS = 20_000;
  private static readonly LOCK_STALE_MS = 15_000;
  private static readonly prunedProjectRoots = new Set<string>();

  private git: SimpleGit;
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
    this.pruneRunWorktreesOnce(projectRoot);
  }

  getProjectRoot(): string {
    return this.projectRoot;
  }

  getRunGitCommitWritablePaths(runId: string): RunGitCommitWritablePaths {
    const record = this.requireRunWorktreeRecord(runId);
    const worktreeGitDir = this.resolveWorktreeGitDir(record.worktreePath);
    const commonGitDir = this.resolveCommonGitDir(worktreeGitDir);
    const branchParentSegments = record.branchName.split('/').slice(0, -1);
    const branchRefsDir = join(commonGitDir, 'refs', 'heads', ...branchParentSegments);
    const branchLogsDir = join(commonGitDir, 'logs', 'refs', 'heads', ...branchParentSegments);
    const paths = Array.from(new Set([
      worktreeGitDir,
      join(commonGitDir, 'objects'),
      branchRefsDir,
      branchLogsDir,
    ]));

    return {
      worktreeGitDir,
      objectsDir: join(commonGitDir, 'objects'),
      branchRefsDir,
      branchLogsDir,
      paths,
    };
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

  // -------------------------------------------------------------------------
  // Run-scoped worktree API
  //
  // A "run" is a captain-invoked subagent execution keyed by a runId.
  // Concurrent run_agent tool calls get independent runIds and therefore
  // independent worktrees.
  // -------------------------------------------------------------------------

  async createRunWorktree(runId: string): Promise<string> {
    return this.withRunLock(runId, async () => {
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
    options: {
      targetBranch?: string;
      force?: boolean;
      /**
       * How to land the run. `squash` (default) collapses the run into a
       * single commit titled by commitTitle/commitBody. `preserve` keeps
       * the run's individual commits linearly — fast-forward when the
       * target hasn't diverged, else cherry-pick the run's commit range.
       */
      mergeStrategy?: 'squash' | 'preserve';
      /**
       * Subject line for the squashed commit (squash strategy only).
       * Captain-supplied, falls back to `crew run <runId>` if absent.
       */
      commitTitle?: string;
      /**
       * Extra body paragraphs for the squashed commit (squash only).
       */
      commitBody?: string;
    } = {},
  ): Promise<MergeRunResult> {
    const record = this.requireRunWorktreeRecord(runId);
    const target = await this.resolveMergeTargetBranch(options.targetBranch);

    const wGit = simpleGit(record.worktreePath);
    const [worktreeStatus, mainStatus] = await Promise.all([
      wGit.status(),
      this.git.status(),
    ]);
    if (this.statusChangedFiles(worktreeStatus).length > 0) {
      await wGit.add('.');
      // Reuse the commit_title for the pre-merge auto-commit so the
      // linear log stays readable — without this the agent's tail
      // edits land as "crew: auto-commit before merge" even when the
      // captain provided a meaningful title for the merge.
      const autoCommitMsg = options.commitTitle ?? 'crew: auto-commit before merge';
      await wGit.commit(autoCommitMsg);
    }

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
    const [worktreeHeadRaw, targetHeadRaw] = await Promise.all([
      wGit.revparse(['HEAD']),
      this.git.revparse([target]),
    ]);
    const worktreeHead = worktreeHeadRaw.trim();
    const targetHead = targetHeadRaw.trim();
    if (worktreeHead === targetHead) {
      return { status: 'no-changes' };
    }

    const currentBranch = (await this.git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    if (currentBranch !== target) {
      await this.git.checkout(target);
    }
    // Merge by the worktree's actual HEAD SHA, not record.branchName.
    // If the agent switched branches inside the worktree (e.g., a sandbox
    // forced a non-standard branch name), the recorded branch ref is stuck
    // at the initial commit and merging it would silently no-op while the
    // real work survives on a different ref. `worktreeHead` (read above
    // for the no-changes check) is canonical regardless of branch state.
    //
    // Side effect: if the agent committed on a different branch, that
    // branch ref persists locally after `cleanupRunRecordedWorktree`
    // deletes only `record.branchName`. Detected and warn-logged below.
    let actualBranch: string | undefined;
    try {
      const raw = (await wGit.revparse(['--abbrev-ref', 'HEAD'])).trim();
      // 'HEAD' here means detached — leave actualBranch undefined.
      if (raw && raw !== 'HEAD') actualBranch = raw;
    } catch {
      // Best-effort; non-fatal.
    }
    if (actualBranch && actualBranch !== record.branchName) {
      logger.warn(
        `merge_run ${runId}: worktree HEAD is on branch '${actualBranch}', `
        + `but the run was created on '${record.branchName}'. Merging the actual `
        + `commit graph (${worktreeHead}) — '${actualBranch}' will remain as an `
        + `orphan local ref after cleanup. Delete with `
        + `\`git branch -D ${actualBranch}\` if you don't need it.`,
      );
    }
    // `preserve` keeps the run's individual commits linearly; `squash`
    // (default) collapses them into one. Both land without a `--no-ff`
    // merge commit. The run branch is force-deleted at cleanup, so
    // leaving it "unmerged" in git's eyes is fine for either path.
    if ((options.mergeStrategy ?? 'squash') === 'preserve') {
      return await this.preserveRunCommits(target, targetHead, worktreeHead);
    }

    // Squash: `--squash` stages the combined diff without committing and
    // without recording a second parent, so the run lands as one clean
    // commit carrying the captain's title/body.
    const mergeMessage = buildMergeCommitMessage({
      runId,
      title: options.commitTitle,
      body: options.commitBody,
    });
    try {
      await this.git.merge([worktreeHead, '--squash']);
    } catch (err) {
      // simple-git throws on conflicts. Capture the conflicting paths and
      // leave the staged squash in-progress for the user to resolve
      // (matches `git merge --squash`'s natural behavior).
      const conflicts = await this.detectConflicts();
      if (conflicts.length > 0) {
        return { status: 'conflict', conflicts };
      }
      throw err;
    }
    // Defensive: if the run's commits net to no change against the
    // target (e.g. a change and its revert), nothing is staged and a
    // commit would fail. Reset the staged squash and report no-changes.
    const stagedAfterSquash = (await this.git.diff(['--cached', '--name-only'])).trim();
    if (stagedAfterSquash.length === 0) {
      await this.git.reset(['--hard', target]);
      return { status: 'no-changes' };
    }
    await this.git.commit(mergeMessage);
    const commitSha = (await this.git.revparse(['HEAD'])).trim();
    return { status: 'merged', commitSha };
  }

  /**
   * `preserve` merge strategy: land the run's individual commits
   * linearly. Fast-forward when the target is an ancestor of the run
   * head (exact commits + SHAs kept); otherwise cherry-pick the run's
   * unique commit range onto the target tip (rewritten, but each commit
   * + message preserved). Never creates a merge commit. Assumes the
   * target branch is already checked out and worktreeHead !== targetHead.
   */
  private async preserveRunCommits(
    target: string,
    targetHead: string,
    worktreeHead: string,
  ): Promise<MergeRunResult> {
    const base = (await this.git.raw(['merge-base', target, worktreeHead])).trim();
    if (base === worktreeHead) {
      // The run head is an ancestor of the target — the target already
      // has everything the run does. Nothing to land.
      return { status: 'no-changes' };
    }
    if (base === targetHead) {
      // Target hasn't diverged: a fast-forward keeps the exact commits.
      await this.git.merge([worktreeHead, '--ff-only']);
    } else {
      // Diverged: replay the run's unique commits onto the target tip.
      try {
        await this.git.raw(['cherry-pick', `${base}..${worktreeHead}`]);
      } catch (err) {
        // cherry-pick leaves CHERRY_PICK_HEAD on conflict; recovery is
        // `git cherry-pick --abort`. Capture the conflicting paths and
        // leave it in-progress for the user to resolve.
        const conflicts = await this.detectConflicts();
        if (conflicts.length > 0) {
          return { status: 'conflict', conflicts };
        }
        throw err;
      }
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

  /**
   * Remove a run's worktree and metadata record. By default the run's
   * branch is deleted too (the `discard_run` / merged-cleanup contract).
   * Pass `{ keepBranch: true }` to remove only the working tree + record
   * while preserving the branch ref — used by the run GC so reclaiming a
   * stale worktree never drops unmerged commits (they survive as a
   * recoverable `crew-run/*` branch).
   */
  async cleanupByRunId(
    runId: string,
    options: { keepBranch?: boolean } = {},
  ): Promise<void> {
    await this.withRunLock(runId, async () => {
      const record = this.readRunWorktreeRecord(runId);
      if (!record) return;
      const cleanup = await this.cleanupRunRecordedWorktree(record, options);
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

  private pruneRunWorktreesOnce(projectRoot: string): void {
    if (WorktreeManager.prunedProjectRoots.has(projectRoot)) return;
    WorktreeManager.prunedProjectRoots.add(projectRoot);
    void this.git.raw(['worktree', 'prune']).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      // Host CLIs (e.g. Conductor) launch crew-mcp from their own app bin
      // directory, which isn't a git repo. The prune has nothing to prune
      // in that case — log at debug so the noise doesn't show up in
      // routine `info` output. Any other prune failure stays a warn.
      if (/not a git repository/i.test(message)) {
        logger.debug(
          `Skipping worktree prune; ${projectRoot} is not a git repository`,
        );
        return;
      }
      logger.warn(
        `Failed to prune stale git worktrees for ${projectRoot}: ${message}`,
      );
    });
  }

  private isRecoverableCreateCollision(message: string): boolean {
    return (
      message.includes('already exists')
      || message.includes('already checked out')
      || message.includes('is a missing but already registered worktree')
    );
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

  private resolveWorktreeGitDir(worktreePath: string): string {
    const dotGitPath = join(worktreePath, '.git');
    const dotGitStat = statSync(dotGitPath);
    if (dotGitStat.isDirectory()) return dotGitPath;

    const dotGitContents = readFileSync(dotGitPath, 'utf-8');
    const match = dotGitContents.match(/^gitdir:\s*(.+)\s*$/m);
    if (!match?.[1]) {
      throw new Error(`Unable to resolve gitdir from ${dotGitPath}.`);
    }
    return resolve(dirname(dotGitPath), match[1]);
  }

  private resolveCommonGitDir(worktreeGitDir: string): string {
    const commonDirPath = join(worktreeGitDir, 'commondir');
    if (!existsSync(commonDirPath)) return worktreeGitDir;
    const commonDir = readFileSync(commonDirPath, 'utf-8').trim();
    if (commonDir.length === 0) return worktreeGitDir;
    return resolve(worktreeGitDir, commonDir);
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

  private writeRunLockRecord(lockDir: string, record: RunLockRecord): void {
    const targetPath = join(lockDir, 'owner.json');
    const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tempPath, JSON.stringify(record, null, 2), 'utf-8');
    renameSync(tempPath, targetPath);
  }

  private readRunLockRecord(lockDir: string): RunLockRecord | undefined {
    const ownerPath = join(lockDir, 'owner.json');
    if (!existsSync(ownerPath)) {
      return undefined;
    }

    try {
      return JSON.parse(readFileSync(ownerPath, 'utf-8')) as RunLockRecord;
    } catch {
      return undefined;
    }
  }

  private canReclaimRunLock(lockDir: string): boolean {
    const record = this.readRunLockRecord(lockDir);
    if (record?.pid && this.isProcessAlive(record.pid)) {
      return false;
    }
    return this.isStaleLock(lockDir);
  }

  private releaseRunLock(lockDir: string, ownerId: string): void {
    const record = this.readRunLockRecord(lockDir);
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
    options: { keepBranch?: boolean } = {},
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
    if (!options.keepBranch) {
      try {
        await this.git.deleteLocalBranch(record.branchName, true);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!this.isMissingBranchError(msg)) {
          logger.warn(`Failed to delete branch ${record.branchName}: ${msg}`);
          errors.push(`delete branch: ${msg}`);
        }
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
    const lockRecord: RunLockRecord = {
      ownerId,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    };
    const timeoutAt = Date.now() + WorktreeManager.LOCK_TIMEOUT_MS;

    while (true) {
      try {
        mkdirSync(lockDir);
        try {
          this.writeRunLockRecord(lockDir, lockRecord);
        } catch (err) {
          rmSync(lockDir, { recursive: true, force: true });
          throw err;
        }
        break;
      } catch (err) {
        if (!this.isLockAlreadyHeldError(err)) {
          throw err;
        }
        if (this.canReclaimRunLock(lockDir)) {
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
      this.releaseRunLock(lockDir, ownerId);
    }
  }
}

/**
 * Compose the squashed-commit message from the captain-supplied title +
 * body. Falls back to a generic title when the captain didn't pass one
 * (deliberately plain, since human git history is the audience).
 *
 * Format:
 *
 *   <title or fallback>
 *
 *   <body, when supplied>
 *
 * No machine trailer is appended: merge_run squashes the run into a
 * single ordinary commit, and the previous `Crew-Run: <runId>` trailer
 * had no reader anywhere in the codebase — it only forced an empty
 * `--no-ff` wrapper commit to carry it.
 */
export function buildMergeCommitMessage(args: {
  runId: string;
  title?: string;
  body?: string;
}): string {
  const subject = args.title?.trim() || `crew run ${args.runId}`;
  const parts = [subject];
  const body = args.body?.trim();
  if (body) parts.push('', body);
  return parts.join('\n');
}
