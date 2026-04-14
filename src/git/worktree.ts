import simpleGit, { type SimpleGit } from 'simple-git';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger.js';

export class WorktreeManager {
  private git: SimpleGit;
  private basePath: string;

  constructor(projectRoot: string) {
    this.git = simpleGit(projectRoot);
    this.basePath = join(projectRoot, '.orchestra', 'worktrees');
    mkdirSync(this.basePath, { recursive: true });
  }

  async createWorktree(taskId: string): Promise<string> {
    const branchName = `orchestra/${taskId}`;
    const worktreePath = join(this.basePath, taskId);
    if (existsSync(worktreePath)) {
      // Validate the worktree is healthy
      try {
        const wGit = simpleGit(worktreePath);
        await wGit.status(); // Throws if not a valid git repo
        return worktreePath;
      } catch {
        // Stale or broken worktree — remove and recreate
        await this.cleanupWorktree(taskId);
      }
    }
    await this.git.raw(['worktree', 'add', '-b', branchName, worktreePath]);
    return worktreePath;
  }

  getWorktreePath(taskId: string): string {
    return join(this.basePath, taskId);
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
    const branchName = `orchestra/${taskId}`;
    const target = await this.resolveMergeTargetBranch(targetBranch);

    // First, commit any uncommitted changes in the worktree
    const worktreePath = this.getWorktreePath(taskId);
    const worktreeGit = simpleGit(worktreePath);
    const worktreeStatus = await worktreeGit.status();
    if (worktreeStatus.modified.length > 0 || worktreeStatus.created.length > 0 || worktreeStatus.not_added.length > 0) {
      await worktreeGit.add('.');
      await worktreeGit.commit('orchestra: auto-commit before merge');
    }

    // Refuse to merge if the user's working directory has uncommitted changes
    const mainStatus = await this.git.status();
    if (mainStatus.modified.length > 0 || mainStatus.not_added.length > 0 || mainStatus.created.length > 0) {
      throw new Error(
        `Cannot merge orchestra/${taskId}: working directory has uncommitted changes. ` +
        'Please commit or stash your changes first.'
      );
    }

    const currentBranch = (await this.git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    if (currentBranch !== target) {
      await this.git.checkout(target);
    }
    await this.git.merge([branchName, '--no-ff', '-m', `Merge orchestra/${taskId}`]);
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
    const worktreePath = this.getWorktreePath(taskId);
    const branchName = `orchestra/${taskId}`;
    try {
      await this.git.raw(['worktree', 'remove', worktreePath, '--force']);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to remove worktree ${worktreePath}: ${msg}`);
    }
    try {
      await this.git.deleteLocalBranch(branchName, true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to delete branch ${branchName}: ${msg}`);
    }
  }

  async cleanupAll(): Promise<void> {
    const raw = await this.git.raw(['worktree', 'list', '--porcelain']);
    const worktreeBlocks = raw.split('\n\n')
      .filter(block => block.includes('.orchestra/worktrees/'));

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
}
