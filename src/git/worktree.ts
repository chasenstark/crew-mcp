import simpleGit, { type SimpleGit, type StatusResult } from 'simple-git';
import { createHash, randomUUID } from 'crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'fs';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { atomicWrite } from '../utils/atomic-write.js';
import { logBestEffortFailure } from '../utils/best-effort.js';
import { withFileLock } from '../utils/file-lock.js';
import { logger } from '../utils/logger.js';

interface RunWorktreeRecord {
  runId: string;
  branchName: string;
  worktreePath: string;
  createdAt: string;
}

/**
 * Source description for an ephemeral-review snapshot worktree
 * (`createRunWorktreeFromSource`). The snapshot mirrors what an in-place
 * reviewer bound to `sourcePath` would see: the source worktree's HEAD
 * (committed run work) plus its uncommitted state copied on top.
 */
export interface EphemeralSnapshotSource {
  /** Absolute path of the worktree to snapshot (e.g. an implementer run's worktree). */
  readonly sourcePath: string;
  /**
   * Invoked after the snapshot copy completes, before the source is
   * re-signed and the worktree is handed out. Throw to fail the snapshot —
   * e.g. when the implementer run's state (status / prompts / completedAt)
   * moved while the copy ran. The snapshot worktree is discarded on throw.
   */
  readonly assertSourceStableAfterSync?: () => void | Promise<void>;
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

interface HostCheckout {
  readonly branchName?: string;
  readonly headSha: string;
}

type PreLandingRecovery = 'none' | 'squash' | 'cherry-pick';
type MergeRecoveryState = PreLandingRecovery | 'post-landing';

export class WorktreeManager {
  private static readonly LOCK_TIMEOUT_MS = 20_000;
  private static readonly LOCK_STALE_MS = 15_000;
  private static readonly prunedProjectRootRealpaths = new Set<string>();

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

  /**
   * True when `candidate` is a path Crew controls and can therefore safely
   * auto-trust for a headless dispatch: the host repo root itself, or anything
   * under the run-worktree base (`<crewHome>/runs`). Both hold the user's own
   * code (the host checkout, or a worktree checkout of it). A caller-supplied
   * working directory outside both is NOT crew-controlled — crew must not force
   * a CLI's folder-trust gate open on it, because trusting a directory loads
   * its project config (`.gemini/settings.json`, MCP servers, hooks, `.env`),
   * which would execute untrusted third-party config outside a read-only tool
   * policy. Consumed by the read-only dispatch path to scope Gemini's
   * `GEMINI_CLI_TRUST_WORKSPACE` injection.
   */
  isCrewControlledPath(candidate: string): boolean {
    if (!candidate) return false;
    // Resolve symlinks on BOTH sides before the containment check. A lexical
    // check (resolve only) would auto-trust a link planted inside the repo /
    // run base that points OUTSIDE — e.g. `<repo>/vendor/link -> /tmp/untrusted`
    // — letting Gemini load the external tree's `.gemini` config outside the
    // policy. realpathSync collapses the link to its real target so the escape
    // is rejected (mirrors isSafeSymlinkTarget below). A path that can't
    // be resolved (nonexistent / broken link) fails closed to false — it isn't
    // a usable working directory anyway.
    let realTarget: string;
    try {
      realTarget = realpathSync(resolve(candidate));
    } catch {
      return false;
    }
    // Crew-controlled = the host repo root or any descendant (the user's own
    // checkout), or the run-worktree base or any descendant (crew-owned
    // checkouts of that repo). Anything else is an external dir we must not
    // auto-trust. `relative()` is '' for the base itself and a non-`..`,
    // non-absolute path for descendants.
    for (const base of [this.projectRoot, this.runBasePath]) {
      let realBase: string;
      try {
        realBase = realpathSync(resolve(base));
      } catch {
        continue;
      }
      const rel = relative(realBase, realTarget);
      if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return true;
    }
    return false;
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

  /**
   * Create a run worktree that snapshots ANOTHER worktree instead of the
   * host repo: checked out at the source's current HEAD (so committed run
   * work is included — a dirty-only copy would silently drop it), then the
   * source's uncommitted state is copied on top. Used by run_panel to give
   * an ephemeral-review reviewer (agy) its own disposable copy of the
   * implementer's worktree.
   *
   * Source-mutation guard: the source is signed (HEAD sha + content hashes
   * of its dirty set) before the worktree is created and again after the
   * copy. If the signature moved — a concurrent continue_run, merge_run, or
   * manual edit landed mid-copy — the snapshot is torn: the worktree is
   * discarded and the call throws. `assertSourceStableAfterSync` runs TWICE
   * in the same window — once right after the copy (early fail) and again
   * after the signature comparison as the final gate — so a caller's drift
   * check (e.g. re-reading the implementer's run state) is the last thing
   * that can veto the snapshot before it is recorded.
   *
   * The guard DETECTS mid-copy mutation; it does not prevent it. The copy
   * itself is file-by-file, so it assumes no concurrent writer is racing
   * the window (the plan's trusted-diff threat model) — a writer that
   * mutates and reverts a file around its individual copy read can evade
   * the bracketing signatures. Do not lean on this as a hostile-race
   * defense.
   *
   * Unlike `createRunWorktree`, a failed uncommitted-state sync here is
   * FATAL, not best-effort: a reviewer must see exactly what an in-place
   * reviewer would, so a partial snapshot (failed copies/removals, skipped
   * unsafe symlinks) is discarded rather than handed out.
   */
  async createRunWorktreeFromSource(
    runId: string,
    source: EphemeralSnapshotSource,
  ): Promise<string> {
    return this.withRunLock(runId, async () => {
      const existing = await this.resolveExistingRunWorktree(runId);
      if (existing) {
        return existing.worktreePath;
      }

      const sourceGit = simpleGit(source.sourcePath);
      const before = await this.captureSourceSnapshotSignature(sourceGit, source.sourcePath);

      for (let attempt = 0; attempt < 5; attempt++) {
        const record = this.buildRunWorktreeRecord(runId);
        try {
          mkdirSync(join(this.runBasePath, this.toRunToken(runId)), { recursive: true });
          await this.git.raw([
            'worktree', 'add', '-b', record.branchName, record.worktreePath, before.headSha,
          ]);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!this.isRecoverableCreateCollision(message)) {
            throw err;
          }
          logger.warn(`Run worktree name collision for ${runId}; retrying with a new suffix.`);
          continue;
        }
        // The worktree exists from here on; any failure below must discard
        // it — a torn snapshot must never be handed to a reviewer.
        try {
          await this.syncUncommittedFromTo(
            source.sourcePath,
            sourceGit,
            record.worktreePath,
            { strict: true },
          );
          await source.assertSourceStableAfterSync?.();
          const after = await this.captureSourceSnapshotSignature(sourceGit, source.sourcePath);
          if (after.signature !== before.signature) {
            throw new Error(
              `ephemeral_snapshot.source_mutated: ${source.sourcePath} changed while its `
              + 'snapshot was being copied (HEAD moved or the dirty state changed). The '
              + 'snapshot worktree was discarded; re-dispatch once the source is stable.',
            );
          }
          // Final gate: drift that moved the caller's state WITHOUT touching
          // worktree content yet (e.g. a continue_run accepted after the
          // first assert but before it writes) still vetoes the snapshot.
          await source.assertSourceStableAfterSync?.();
          this.writeRunWorktreeRecord(record);
          return record.worktreePath;
        } catch (err) {
          const cleanup = await this.cleanupRunRecordedWorktree(record);
          const message = err instanceof Error ? err.message : String(err);
          if (!cleanup.success) {
            throw new Error(`${message}; snapshot worktree rollback failed: ${cleanup.errors.join('; ')}`);
          }
          throw err;
        }
      }

      throw new Error(`Failed to create a unique run worktree for ${runId} after multiple attempts.`);
    });
  }

  /**
   * Sign a source worktree for the snapshot-copy guard: its HEAD sha plus a
   * content signature per dirty path (tracked modifications, untracked
   * non-ignored files, deletions, renames). Content hashes — not just the
   * path set — so mutating an already-dirty file mid-copy is still caught.
   */
  private async captureSourceSnapshotSignature(
    sourceGit: SimpleGit,
    sourcePath: string,
  ): Promise<{ readonly headSha: string; readonly signature: string }> {
    const headSha = (await sourceGit.revparse(['HEAD'])).trim();
    const status = await sourceGit.status();
    // status.files-based collection (see collectStatusCandidatePaths) so
    // compound index/worktree states (e.g. `MD`) are signed too, in
    // lockstep with what syncUncommittedFromTo mirrors.
    const entries = collectStatusCandidatePaths(status).map((relPath) =>
      `${relPath} ${dirtyFileSignature(join(sourcePath, relPath))}`);
    return { headSha, signature: [headSha, ...entries].join('\n') };
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
   * Mirror an arbitrary SOURCE worktree's uncommitted state into a target
   * worktree — the generalized form of the host-repo sync above, used by
   * ephemeral-review snapshots (run_panel routes agy reviewers to a
   * disposable copy of the implementer's worktree). Same semantics:
   * tracked-modified + untracked-non-ignored copied, deletions applied,
   * renames both, gitignored excluded, symlink targets confined to the
   * source root.
   */
  async syncUncommittedFromPathToWorktree(
    sourcePath: string,
    targetWorktreePath: string,
  ): Promise<{
    readonly copied: number;
    readonly removed: number;
  }> {
    return this.syncUncommittedFromTo(sourcePath, simpleGit(sourcePath), targetWorktreePath);
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
    return this.syncUncommittedFromTo(this.projectRoot, this.git, worktreePath);
  }

  /**
   * Internal core of both sync entry points: read `git status` against
   * `sourceRoot` and apply the deltas to `worktreePath`.
   *
   * `strict` selects the failure posture. Best-effort (default, host-repo
   * sync): per-path copy/remove failures and unsafe-symlink skips are
   * warn-logged and the sync continues — a partially seeded write worktree
   * is still useful. Strict (ephemeral snapshots): those same events are
   * collected and thrown as one error, because a partial snapshot would
   * pass the source-signature guard (the SOURCE didn't change) while
   * silently differing from what an in-place reviewer sees. An ENOENT on
   * a source path stays non-fatal in both modes: it means the source
   * mutated after `git status`, which the snapshot signature guard
   * catches on its own.
   */
  private async syncUncommittedFromTo(
    sourceRoot: string,
    sourceGit: SimpleGit,
    worktreePath: string,
    options: { readonly strict?: boolean } = {},
  ): Promise<{
    readonly copied: number;
    readonly removed: number;
  }> {
    const strict = options.strict === true;
    const failures: string[] = [];
    const status = await sourceGit.status();
    let copied = 0;
    let removed = 0;
    // For every path git reports as differing from HEAD, mirror the SOURCE
    // WORKING TREE state: present → copy, absent → remove. Classifying by
    // lstat instead of by porcelain code matrix is deliberate — simple-git's
    // convenience arrays (modified/deleted/created/not_added) drop compound
    // states entirely (an `MD` staged-modified-then-deleted file appears in
    // NONE of them), which previously left the target holding the stale
    // HEAD version of a file the source deleted.
    for (const relPath of collectStatusCandidatePaths(status)) {
      const src = join(sourceRoot, relPath);
      const dst = join(worktreePath, relPath);
      try {
        let st: ReturnType<typeof lstatSync>;
        try {
          st = lstatSync(src);
        } catch (err) {
          if (!isEnoent(err)) throw err;
          // Deleted in the source working tree (working-tree deletion,
          // staged deletion, or staged-then-deleted) → mirror the deletion.
          if (existsSync(dst)) {
            rmSync(dst, { force: true });
            removed++;
          }
          continue;
        }
        mkdirSync(dirname(dst), { recursive: true });
        if (st.isSymbolicLink()) {
          const target = readlinkSync(src);
          if (!this.isSafeSymlinkTarget(src, target, sourceRoot)) {
            rmSync(dst, { recursive: true, force: true });
            logger.warn(
              `syncUncommitted: skipped unsafe symlink ${relPath} -> ${target}; target escapes the sync source root`,
            );
            if (strict) failures.push(`unsafe symlink skipped: ${relPath} -> ${target}`);
            continue;
          }
          rmSync(dst, { recursive: true, force: true });
          symlinkSync(target, dst);
        } else if (st.isFile()) {
          copyFileSync(src, dst);
          chmodSync(dst, st.mode);
        } else {
          // Git submodules are directories with gitlink index entries; this
          // best-effort file sync does not recurse or materialize them.
          continue;
        }
        copied++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`syncUncommitted: failed to mirror ${relPath} into worktree: ${message}`);
        if (strict) failures.push(`${relPath}: ${message}`);
      }
    }
    if (strict && failures.length > 0) {
      throw new Error(
        `ephemeral_snapshot.sync_incomplete: ${failures.length} path(s) failed to mirror from `
        + `${sourceRoot}: ${failures.join('; ')}`,
      );
    }
    return { copied, removed };
  }

  /**
   * True when a symlink inside a sync source may be replicated into the
   * target worktree: its target must stay inside `sourceRoot` (the host
   * repo for the default sync, the source worktree for a snapshot sync)
   * both lexically and after realpath resolution.
   */
  private isSafeSymlinkTarget(linkPath: string, target: string, sourceRoot: string): boolean {
    const lexicalProjectRoot = resolve(sourceRoot);
    const lexicalRoots = [lexicalProjectRoot];
    let resolvedProjectRoot = lexicalProjectRoot;
    try {
      resolvedProjectRoot = realpathSync(sourceRoot);
      lexicalRoots.push(resolvedProjectRoot);
    } catch {
      // If the root itself disappears, fall back to the normalized path
      // used by the manager; the copy will fail separately if needed.
    }

    const targetPath = isAbsolute(target)
      ? resolve(target)
      : resolve(dirname(linkPath), target);
    const targetIsLexicallyInsideRoot = lexicalRoots.some((root) => isPathInside(root, targetPath));
    if (!targetIsLexicallyInsideRoot) {
      return false;
    }

    try {
      const resolvedTargetPath = realpathSync(targetPath);
      return isPathInside(resolvedProjectRoot, resolvedTargetPath);
    } catch (err) {
      if (isEnoent(err)) {
        return targetIsLexicallyInsideRoot;
      }
      return false;
    }
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
    const pruneKey = this.resolveProjectRootPruneKey(projectRoot);
    if (WorktreeManager.prunedProjectRootRealpaths.has(pruneKey)) return;
    WorktreeManager.prunedProjectRootRealpaths.add(pruneKey);
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

  private resolveProjectRootPruneKey(projectRoot: string): string {
    try {
      return realpathSync(projectRoot);
    } catch {
      return resolve(projectRoot);
    }
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

  private statusChangedFiles(status: StatusResult): string[] {
    return [
      ...status.modified,
      ...status.created,
      ...status.not_added,
      ...(status.deleted ?? []),
      ...(status.renamed ?? []).map((r) => r.to),
    ];
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
    atomicWrite(targetPath, JSON.stringify(record, null, 2));
  }

  private deleteRunWorktreeRecord(runId: string): void {
    try {
      rmSync(this.runMetadataFilePath(runId), { force: true });
    } catch (err) {
      logBestEffortFailure('worktree.delete-run-record', err);
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
    return withFileLock(
      {
        lockDir,
        timeoutMs: WorktreeManager.LOCK_TIMEOUT_MS,
        staleMs: WorktreeManager.LOCK_STALE_MS,
        waitMs: 50,
        timeoutMessage,
        reclaimOwnerless: true,
      },
      operation,
    );
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

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Every path a `git status` reports as differing from HEAD, sorted. The
 * load-bearing source is `status.files` (raw index/working_dir entries):
 * simple-git's convenience arrays silently drop compound states — e.g. an
 * `MD` staged-modified-then-deleted file appears in NONE of
 * modified/deleted/created/not_added. The convenience arrays are still
 * unioned in defensively (they are a subset of files[] on real git, and
 * some callers/tests construct status objects without files[]). Rename
 * entries encode "from -> to" in `path`; both sides come from
 * `status.renamed` instead. Gitignored paths never appear in status
 * output, so they are excluded for free.
 */
function collectStatusCandidatePaths(status: StatusResult): string[] {
  const renames = (status.renamed ?? []) as ReadonlyArray<{ from: string; to: string }>;
  const paths = new Set<string>([
    ...status.modified,
    ...status.created,
    ...status.not_added,
    ...(status.deleted ?? []),
  ]);
  for (const file of status.files ?? []) {
    if (typeof file.path === 'string' && !file.path.includes(' -> ')) {
      paths.add(file.path);
    }
  }
  for (const rename of renames) {
    paths.add(rename.from);
    paths.add(rename.to);
  }
  return Array.from(paths).sort();
}

/**
 * Content signature of one dirty path for the snapshot source-mutation
 * guard. Regular files are ALWAYS content-hashed (streamed in chunks, so a
 * large file neither loads into memory nor degrades to a size+mtime proxy
 * that a same-size in-place edit could evade); a missing path (deletion)
 * signs as 'missing'.
 */
function dirtyFileSignature(absPath: string): string {
  try {
    const st = lstatSync(absPath);
    if (st.isSymbolicLink()) return `symlink:${readlinkSync(absPath)}`;
    if (!st.isFile()) return `non-file:${st.size}:${Math.trunc(st.mtimeMs)}`;
    return `sha256:${hashFileContentSync(absPath)}`;
  } catch (err) {
    if (isEnoent(err)) return 'missing';
    return `error:${err instanceof Error ? err.message : String(err)}`;
  }
}

const HASH_CHUNK_BYTES = 64 * 1024;

function hashFileContentSync(absPath: string): string {
  const hash = createHash('sha256');
  const fd = openSync(absPath, 'r');
  try {
    const buffer = Buffer.alloc(HASH_CHUNK_BYTES);
    let bytesRead: number;
    while ((bytesRead = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}
