import simpleGit, { type SimpleGit, type StatusResult } from 'simple-git';
import { createHash, randomUUID } from 'crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { logger } from '../utils/logger.js';

interface RunWorktreeRecord {
  runId: string;
  branchName: string;
  worktreePath: string;
  createdAt: string;
}

export interface WorktreeCleanupResult {
  readonly success: boolean;
  readonly errors: string[];
  readonly hadRecord: boolean;
  readonly worktreeRemoved: boolean;
  readonly branchDeleted: boolean;
  readonly recordDeleted: boolean;
}

export type MergeRunResult =
  | ({ status: 'merged'; commitSha: string } & MergeRunCheckoutInfo)
  | ({ status: 'conflict'; conflicts: string[] } & MergeRunCheckoutInfo)
  | ({ status: 'no-changes' } & MergeRunCheckoutInfo);

interface MergeRunWarningInfo {
  readonly restoreFailed?: boolean;
  readonly restoreWarning?: string;
}

type MergeRunCoreResult =
  | ({ status: 'merged'; commitSha: string } & MergeRunWarningInfo)
  | ({ status: 'conflict'; conflicts: string[] } & MergeRunWarningInfo)
  | ({ status: 'no-changes' } & MergeRunWarningInfo);

interface MergeRunCoreOutcome {
  readonly result: MergeRunCoreResult;
  readonly leaveHostOnTarget?: boolean;
}

export interface MergeRunCheckoutInfo {
  readonly targetBranch: string;
  readonly originalBranch?: string;
  readonly originalHead: string;
  readonly landedOffCurrentBranch: boolean;
  readonly restoreFailed?: boolean;
  readonly restoreWarning?: string;
}

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

interface HostCheckout {
  readonly branchName?: string;
  readonly headSha: string;
}

type PreLandingRecovery = 'none' | 'squash' | 'cherry-pick';
type MergeRecoveryState = PreLandingRecovery | 'post-landing';

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

  hasOwnedRunWorktreeRecord(runId: string): boolean {
    return this.readRunWorktreeRecord(runId) !== undefined;
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
    const base = await this.resolveRunBranchPoint(wGit);
    const diffOutput = await wGit.raw(['diff', '--name-only', base, '--']);
    const status = await wGit.status();
    return Array.from(new Set([
      ...diffOutput.split('\n').map((line) => line.trim()).filter(Boolean),
      ...status.not_added,
    ]));
  }

  private async resolveRunBranchPoint(wGit: SimpleGit): Promise<string> {
    const [runHeadRaw, hostHeadRaw] = await Promise.all([
      wGit.revparse(['HEAD']),
      this.git.revparse(['HEAD']),
    ]);
    const runHead = runHeadRaw.trim();
    const hostHead = hostHeadRaw.trim();
    try {
      const base = (await wGit.raw(['merge-base', runHead, hostHead])).trim();
      return base || runHead;
    } catch {
      return runHead;
    }
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
    return this.withRepoLock(async () => (
      this.withRunLock(runId, async () => this.mergeRunWorktreeLocked(runId, options))
    ));
  }

  private async mergeRunWorktreeLocked(
    runId: string,
    options: {
      targetBranch?: string;
      force?: boolean;
      mergeStrategy?: 'squash' | 'preserve';
      commitTitle?: string;
      commitBody?: string;
    },
  ): Promise<MergeRunResult> {
    await this.assertHostRepoReadyForMerge(runId);

    const record = this.requireRunWorktreeRecord(runId);
    const target = await this.resolveMergeTargetBranch(options.targetBranch);

    const wGit = simpleGit(record.worktreePath);
    const [worktreeStatus, mainStatus] = await Promise.all([
      wGit.status(),
      this.git.status(),
    ]);
    const hostChangedFilesAtMergeStart = this.statusChangedFiles(mainStatus);
    const hostDirtyAtMergeStart = hostChangedFilesAtMergeStart.length > 0;
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
      && hostDirtyAtMergeStart
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
    const originalCheckout = await this.captureHostCheckout();
    if (worktreeHead === targetHead) {
      return this.withMergeCheckoutInfo({ status: 'no-changes' }, target, originalCheckout);
    }

    let checkedOutTarget = false;
    let leaveHostOnTarget = false;
    let recovery: MergeRecoveryState = 'none';
    try {
      if (originalCheckout.branchName !== target) {
        await this.git.checkout(target);
        checkedOutTarget = true;
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
        const outcome = await this.preserveRunCommits(
          runId,
          target,
          targetHead,
          worktreeHead,
          (mode) => { recovery = mode; },
        );
        const { result } = outcome;
        if (result.status === 'conflict' || outcome.leaveHostOnTarget) {
          leaveHostOnTarget = true;
        }
        if (result.status !== 'conflict') {
          recovery = 'none';
        }
        return await this.restoreCheckoutAfterResult(
          runId,
          this.withMergeCheckoutInfo(result, target, originalCheckout),
          {
            checkedOutTarget,
            leaveHostOnTarget,
            originalCheckout,
            targetBranch: target,
          },
        );
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
          leaveHostOnTarget = true;
          return this.withMergeCheckoutInfo({ status: 'conflict', conflicts }, target, originalCheckout);
        }
        throw err;
      }
      recovery = 'squash';
      // Defensive: if the run's commits net to no change against the
      // target (e.g. a change and its revert), nothing is staged and a
      // commit would fail. Reset the staged squash and report no-changes.
      const stagedAfterSquash = (await this.git.diff(['--cached', '--name-only'])).trim();
      if (stagedAfterSquash.length === 0) {
        if (hostDirtyAtMergeStart) {
          recovery = 'none';
          leaveHostOnTarget = true;
          return this.withMergeCheckoutInfo(
            {
              status: 'no-changes',
              restoreFailed: true,
              restoreWarning: this.buildDirtyHostHardResetSkippedWarning({
                runId,
                targetBranch: target,
                targetHead,
                originalCheckout,
                reason: 'the squash merge produced no staged changes',
              }),
            },
            target,
            originalCheckout,
          );
        }
        await this.git.reset(['--hard', targetHead]);
        recovery = 'none';
        return await this.restoreCheckoutAfterResult(
          runId,
          this.withMergeCheckoutInfo({ status: 'no-changes' }, target, originalCheckout),
          {
            checkedOutTarget,
            leaveHostOnTarget,
            originalCheckout,
            targetBranch: target,
          },
        );
      }
      const commitResult = await this.git.commit(mergeMessage);
      recovery = 'post-landing';
      const outcome = await this.resolveLandedCommitResult({
        runId,
        targetBranch: target,
        shaHint: this.commitShaFromCommitResult(commitResult),
        shaSource: 'git commit',
      });
      if (outcome.leaveHostOnTarget) {
        leaveHostOnTarget = true;
      }
      recovery = 'none';
      return await this.restoreCheckoutAfterResult(
        runId,
        this.withMergeCheckoutInfo(outcome.result, target, originalCheckout),
        {
          checkedOutTarget,
          leaveHostOnTarget,
          originalCheckout,
          targetBranch: target,
        },
      );
    } catch (err) {
      if ((checkedOutTarget || recovery !== 'none') && !leaveHostOnTarget && recovery !== 'post-landing') {
        await this.recoverAndRestoreAfterPreLandingError({
          runId,
          recovery,
          targetBranch: target,
          targetHead,
          originalCheckout,
          hostDirtyAtMergeStart,
          operationError: err,
        });
      }
      throw err;
    }
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
    runId: string,
    target: string,
    targetHead: string,
    worktreeHead: string,
    markRecovery: (mode: MergeRecoveryState) => void,
  ): Promise<MergeRunCoreOutcome> {
    const base = (await this.git.raw(['merge-base', target, worktreeHead])).trim();
    if (base === worktreeHead) {
      // The run head is an ancestor of the target — the target already
      // has everything the run does. Nothing to land.
      return { result: { status: 'no-changes' } };
    }
    if (base === targetHead) {
      // Target hasn't diverged: a fast-forward keeps the exact commits.
      await this.git.merge([worktreeHead, '--ff-only']);
      markRecovery('post-landing');
      return this.resolveLandedCommitResult({
        runId,
        targetBranch: target,
        shaHint: worktreeHead,
        shaSource: 'the fast-forward target',
      });
    } else {
      // Diverged: replay the run's unique commits onto the target tip.
      try {
        markRecovery('cherry-pick');
        await this.git.raw(['cherry-pick', `${base}..${worktreeHead}`]);
        markRecovery('post-landing');
      } catch (err) {
        // cherry-pick leaves CHERRY_PICK_HEAD on conflict; recovery is
        // `git cherry-pick --abort`. Capture the conflicting paths and
        // leave it in-progress for the user to resolve.
        const conflicts = await this.detectConflicts();
        if (conflicts.length > 0) {
          return { result: { status: 'conflict', conflicts } };
        }
        throw err;
      }
    }
    return this.resolveLandedCommitResult({
      runId,
      targetBranch: target,
      shaSource: 'the completed cherry-pick',
    });
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

  private async assertHostRepoReadyForMerge(runId: string): Promise<void> {
    const [unmergedPaths, operations] = await Promise.all([
      this.detectConflicts(),
      this.detectHostGitOperationsInProgress(),
    ]);
    if (unmergedPaths.length === 0 && operations.length === 0) {
      return;
    }

    const details: string[] = [];
    if (unmergedPaths.length > 0) {
      details.push(`unmerged index paths: ${unmergedPaths.join(', ')}`);
    }
    if (operations.length > 0) {
      details.push(`in-progress git operation markers: ${operations.join(', ')}`);
    }

    throw new Error(
      `Cannot merge run ${runId}: host repository has an unfinished git operation `
      + `(${details.join('; ')}). Resolve or abort it before calling merge_run.`,
    );
  }

  private async detectHostGitOperationsInProgress(): Promise<string[]> {
    const markers = [
      'MERGE_HEAD',
      'CHERRY_PICK_HEAD',
      'REVERT_HEAD',
      'rebase-merge',
      'rebase-apply',
      'sequencer',
    ];
    const checks = await Promise.all(markers.map(async (marker) => {
      const markerPath = await this.resolveHostGitPath(marker);
      return existsSync(markerPath) ? marker : undefined;
    }));
    return checks.filter((marker): marker is string => marker !== undefined);
  }

  private async resolveHostGitPath(path: string): Promise<string> {
    const raw = (await this.git.raw(['rev-parse', '--git-path', path])).trim();
    return resolve(this.projectRoot, raw.length > 0 ? raw : join('.git', path));
  }

  private async captureHostCheckout(): Promise<HostCheckout> {
    const [branchRaw, headRaw] = await Promise.all([
      this.git.revparse(['--abbrev-ref', 'HEAD']),
      this.git.revparse(['HEAD']),
    ]);
    const branch = branchRaw.trim();
    const headSha = headRaw.trim();
    return {
      ...(branch && branch !== 'HEAD' ? { branchName: branch } : {}),
      headSha,
    };
  }

  private async restoreHostCheckout(checkout: HostCheckout): Promise<void> {
    await this.git.checkout(checkout.branchName ?? checkout.headSha);
  }

  private async restoreCheckoutAfterResult<T extends MergeRunResult>(
    runId: string,
    result: T,
    context: {
      checkedOutTarget: boolean;
      leaveHostOnTarget: boolean;
      originalCheckout: HostCheckout;
      targetBranch: string;
    },
  ): Promise<T> {
    if (!context.checkedOutTarget || context.leaveHostOnTarget) {
      return result;
    }
    try {
      await this.restoreHostCheckout(context.originalCheckout);
      return result;
    } catch (err) {
      const warning = this.buildRestoreWarning(
        context.originalCheckout,
        context.targetBranch,
        err,
      );
      logger.warn(`merge_run ${runId}: ${warning}`);
      return {
        ...result,
        restoreFailed: true,
        restoreWarning: warning,
      };
    }
  }

  private commitShaFromCommitResult(result: unknown): string | undefined {
    if (
      result
      && typeof result === 'object'
      && 'commit' in result
      && typeof result.commit === 'string'
      && result.commit.trim().length > 0
    ) {
      return result.commit.trim();
    }
    return undefined;
  }

  private async resolveLandedCommitResult(args: {
    runId: string;
    targetBranch: string;
    shaHint?: string;
    shaSource: string;
  }): Promise<MergeRunCoreOutcome> {
    try {
      const commitSha = (await this.git.revparse(['HEAD'])).trim();
      return { result: { status: 'merged', commitSha } };
    } catch (err) {
      const commitSha = args.shaHint?.trim() || 'unknown';
      const hintText = args.shaHint
        ? `Using ${commitSha} from ${args.shaSource}.`
        : 'Reporting commitSha as "unknown".';
      const warning = `Merge landed on ${args.targetBranch}, but crew could not `
        + `resolve the landed commit SHA with git rev-parse HEAD. ${hintText} `
        + `The host repo was left on ${args.targetBranch}; inspect git log -1 `
        + `before continuing. SHA resolution failed: ${this.errorMessage(err)}`;
      logger.warn(`merge_run ${args.runId}: ${warning}`);
      return {
        leaveHostOnTarget: true,
        result: {
          status: 'merged',
          commitSha,
          restoreFailed: true,
          restoreWarning: warning,
        },
      };
    }
  }

  private async recoverAndRestoreAfterPreLandingError(args: {
    runId: string;
    recovery: PreLandingRecovery;
    targetBranch: string;
    targetHead: string;
    originalCheckout: HostCheckout;
    hostDirtyAtMergeStart: boolean;
    operationError: unknown;
  }): Promise<void> {
    if (args.recovery === 'squash') {
      if (args.hostDirtyAtMergeStart) {
        throw this.destructiveRecoveryBlockedError(
          args,
          'git reset --hard',
          'the squash merge had modified the index/worktree before the commit failed',
        );
      }
      try {
        await this.git.reset(['--hard', args.targetHead]);
      } catch (recoveryErr) {
        throw this.recoveryFailedError(args, recoveryErr, 'reset --hard');
      }
      await this.assertCleanBeforeRestore(args, 'reset --hard');
    } else if (args.recovery === 'cherry-pick') {
      if (args.hostDirtyAtMergeStart) {
        throw this.destructiveRecoveryBlockedError(
          args,
          'git cherry-pick --abort',
          'the cherry-pick had modified the index/worktree before failing',
        );
      }
      try {
        await this.git.raw(['cherry-pick', '--abort']);
      } catch (recoveryErr) {
        if (await this.isHostIndexAndWorktreeClean()) {
          logger.warn(
            `merge_run ${args.runId}: cherry-pick --abort failed after a `
            + `pre-landing error, but the host repo is clean: `
            + `${this.errorMessage(recoveryErr)}`,
          );
        } else {
          throw this.recoveryFailedError(args, recoveryErr, 'cherry-pick --abort');
        }
      }
      await this.assertCleanBeforeRestore(args, 'cherry-pick --abort');
    }

    try {
      await this.restoreHostCheckout(args.originalCheckout);
    } catch (restoreErr) {
      throw new Error(
        `merge_run ${args.runId} failed before landing and recovered the host repo `
        + `to ${args.targetBranch} (${args.targetHead}), but could not restore `
        + `${this.describeHostCheckout(args.originalCheckout)}. You are on `
        + `${args.targetBranch}. Original error: ${this.errorMessage(args.operationError)}. `
        + `Restore failed: ${this.errorMessage(restoreErr)}`,
      );
    }
  }

  private buildDirtyHostHardResetSkippedWarning(args: {
    runId: string;
    targetBranch: string;
    targetHead: string;
    originalCheckout: HostCheckout;
    reason: string;
  }): string {
    return `merge_run ${args.runId}: ${args.reason}, but the host repo was `
      + `dirty when merge_run started with force=true. Crew did not run `
      + `git reset --hard ${args.targetHead} because that could delete `
      + `pre-existing tracked or staged changes. The host repo is left on `
      + `${args.targetBranch}; inspect git status, preserve your changes, `
      + `then commit, stash, or reset them before checking out `
      + `${this.describeHostCheckout(args.originalCheckout)}.`;
  }

  private destructiveRecoveryBlockedError(
    args: {
      runId: string;
      targetBranch: string;
      originalCheckout: HostCheckout;
      operationError: unknown;
    },
    recoveryCommand: string,
    recoveryReason: string,
  ): Error {
    return new Error(
      `merge_run ${args.runId} failed before landing after ${recoveryReason}. `
      + `Crew did not run ${recoveryCommand} because the host repo was dirty `
      + `when merge_run started with force=true, and that could delete `
      + `pre-existing tracked or staged changes. The host repo is left on `
      + `${args.targetBranch}; inspect git status, preserve your changes, `
      + `then resolve the in-progress merge/cherry-pick state manually before `
      + `checking out ${this.describeHostCheckout(args.originalCheckout)}. `
      + `Original error: ${this.errorMessage(args.operationError)}`,
    );
  }

  private async assertCleanBeforeRestore(
    args: {
      runId: string;
      targetBranch: string;
      operationError: unknown;
    },
    recoveryCommand: string,
  ): Promise<void> {
    if (await this.isHostIndexAndWorktreeClean()) {
      return;
    }
    throw new Error(
      `merge_run ${args.runId} failed before landing. ${recoveryCommand} ran, `
      + `but the host repo is still dirty, so crew left it on ${args.targetBranch} `
      + `instead of checking out the original branch over staged changes. `
      + `Original error: ${this.errorMessage(args.operationError)}`,
    );
  }

  private recoveryFailedError(
    args: {
      runId: string;
      targetBranch: string;
      operationError: unknown;
    },
    recoveryErr: unknown,
    recoveryCommand: string,
  ): Error {
    return new Error(
      `merge_run ${args.runId} failed before landing after git had modified `
      + `the index/worktree. ${recoveryCommand} failed, so crew left the host `
      + `repo on ${args.targetBranch} instead of checking out the original branch `
      + `over staged changes. Original error: ${this.errorMessage(args.operationError)}. `
      + `Recovery failed: ${this.errorMessage(recoveryErr)}`,
    );
  }

  private async isHostIndexAndWorktreeClean(): Promise<boolean> {
    const status = await this.git.raw(['status', '--porcelain']);
    return status.trim().length === 0;
  }

  private describeHostCheckout(checkout: HostCheckout): string {
    return checkout.branchName ?? checkout.headSha;
  }

  private buildRestoreWarning(
    originalCheckout: HostCheckout,
    targetBranch: string,
    err: unknown,
  ): string {
    return `Merge landed but I couldn't return you to `
      + `${this.describeHostCheckout(originalCheckout)}; you're on ${targetBranch}. `
      + `Restore failed: ${this.errorMessage(err)}`;
  }

  private errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  private withMergeCheckoutInfo<T extends MergeRunCoreResult>(
    result: T,
    targetBranch: string,
    originalCheckout: HostCheckout,
  ): T & MergeRunCheckoutInfo {
    return {
      ...result,
      targetBranch,
      ...(originalCheckout.branchName ? { originalBranch: originalCheckout.branchName } : {}),
      originalHead: originalCheckout.headSha,
      landedOffCurrentBranch:
        result.status === 'merged' && originalCheckout.branchName !== targetBranch,
    };
  }

  /**
   * Remove a run's worktree and metadata record. By default the run's
   * branch is deleted too (the `discard_run` / merged-cleanup contract).
   * Pass `{ keepBranch: true }` to remove only the working tree + record
   * while preserving the branch ref — used by the run GC so reclaiming a
   * stale worktree never drops unmerged commits (they survive as a
   * recoverable `crew-run/*` branch).
   *
   * Returns a best-effort cleanup outcome. `success: false` means the caller
   * must assume the git worktree registration and/or branch still exists.
   */
  async cleanupByRunId(
    runId: string,
    options: { keepBranch?: boolean } = {},
  ): Promise<WorktreeCleanupResult> {
    let result: WorktreeCleanupResult = {
      success: true,
      errors: [],
      hadRecord: false,
      worktreeRemoved: false,
      branchDeleted: false,
      recordDeleted: false,
    };
    await this.withRunLock(runId, async () => {
      const record = this.readRunWorktreeRecord(runId);
      if (!record) return;
      const cleanup = await this.cleanupRunRecordedWorktree(record, options);
      result = { ...cleanup, hadRecord: true };
      if (cleanup.success) {
        this.deleteRunWorktreeRecord(runId);
        result = { ...result, recordDeleted: !existsSync(this.runMetadataFilePath(runId)) };
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
    return result;
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
    const tempPath = `${targetPath}.${process.pid}.${Date.now()}.${tempRandomUUID()}.tmp`;
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

  private tryReclaimRunLock(lockDir: string): boolean {
    const record = this.readRunLockRecord(lockDir);
    if (record?.pid && this.isProcessAlive(record.pid)) {
      return false;
    }
    if (!this.isStaleLock(lockDir)) {
      return false;
    }

    const staleDir = `${lockDir}.${tempRandomUUID()}.stale`;
    try {
      renameSync(lockDir, staleDir);
    } catch (err) {
      if (this.isEnoent(err)) return false;
      throw err;
    }

    const renamedRecord = this.readRunLockRecord(staleDir);
    if (
      this.isStaleLock(staleDir)
      && (
        record
          ? renamedRecord?.ownerId === record.ownerId && renamedRecord.pid === record.pid
          : renamedRecord === undefined
      )
    ) {
      rmSync(staleDir, { recursive: true, force: true });
      return true;
    }

    try {
      renameSync(staleDir, lockDir);
    } catch {
      // Best effort: never delete a lock that failed post-rename validation.
    }
    return false;
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

  private isEnoent(error: unknown): boolean {
    return (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && (error as { code?: string }).code === 'ENOENT'
    );
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
  ): Promise<WorktreeCleanupResult> {
    const errors: string[] = [];
    let worktreeRemoved = false;
    let branchDeleted = false;

    try {
      await this.git.raw(['worktree', 'remove', record.worktreePath, '--force']);
      worktreeRemoved = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.isMissingWorktreeError(msg)) {
        worktreeRemoved = true;
      } else {
        logger.warn(`Failed to remove run worktree ${record.worktreePath}: ${msg}`);
        errors.push(`remove worktree: ${msg}`);
      }
    }
    if (!options.keepBranch) {
      try {
        await this.git.deleteLocalBranch(record.branchName, true);
        branchDeleted = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (this.isMissingBranchError(msg)) {
          branchDeleted = true;
        } else {
          logger.warn(`Failed to delete branch ${record.branchName}: ${msg}`);
          errors.push(`delete branch: ${msg}`);
        }
      }
    }

    const branchHandled = options.keepBranch === true || branchDeleted;
    return {
      success: errors.length === 0 && worktreeRemoved && branchHandled,
      errors,
      hadRecord: true,
      worktreeRemoved,
      branchDeleted,
      recordDeleted: false,
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
    const tempPath = `${targetPath}.${process.pid}.${Date.now()}.${tempRandomUUID()}.tmp`;
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
    return this.withLock(lockDir, `Timed out waiting for run worktree lock on ${runId}.`, operation);
  }

  private async withRepoLock<T>(operation: () => Promise<T>): Promise<T> {
    const commonDirRealpath = await this.resolveRepoCommonDirRealpath();
    const lockRoot = join(commonDirRealpath, 'crew-merge-lock');
    mkdirSync(lockRoot, { recursive: true });
    const lockName = createHash('sha256')
      .update(commonDirRealpath)
      .digest('hex')
      .slice(0, 32);
    const lockDir = join(lockRoot, lockName);
    return this.withLock(
      lockDir,
      `Timed out waiting for repository lock on ${commonDirRealpath}.`,
      operation,
    );
  }

  private async resolveRepoCommonDirRealpath(): Promise<string> {
    const raw = (await this.git.raw(['rev-parse', '--git-common-dir'])).trim();
    const commonDir = raw.length > 0 ? raw : '.git';
    return realpathSync(resolve(this.projectRoot, commonDir));
  }

  private async withLock<T>(
    lockDir: string,
    timeoutMessage: string,
    operation: () => Promise<T>,
  ): Promise<T> {
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
        if (this.tryReclaimRunLock(lockDir)) {
          continue;
        }
        if (Date.now() >= timeoutAt) {
          throw new Error(timeoutMessage);
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

function tempRandomUUID(): string {
  return globalThis.crypto?.randomUUID?.() ?? randomUUID();
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
