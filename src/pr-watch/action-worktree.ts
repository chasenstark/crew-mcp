import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { WorktreeManager } from '../git/worktree.js';
import { parsePrWatchId } from './id.js';
import type {
  PrWatchPreparedWorktreeLeaseV1,
  PrWatchStateV1,
  PrWatchWorktreeLeaseV1,
} from './types.js';

const LOCAL_GIT_TIMEOUT_MS = 10_000;
const NETWORK_GIT_TIMEOUT_MS = 60_000;

export class PrWatchWorktreeManager {
  readonly hostWorktrees: WorktreeManager;

  constructor(
    readonly crewHome: string,
    readonly repoRoot: string,
  ) {
    this.hostWorktrees = new WorktreeManager({ projectRoot: repoRoot, crewHome });
  }

  async withHostMutationExclusion<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    outerSignal?: AbortSignal,
  ): Promise<T> {
    return this.hostWorktrees.withHostMutationExclusion(async () => {
      const budget = new AbortController();
      const abortFromOuter = (): void => budget.abort(outerSignal?.reason);
      if (outerSignal?.aborted) abortFromOuter();
      else outerSignal?.addEventListener('abort', abortFromOuter, { once: true });
      const timer = setTimeout(
        () => budget.abort(new Error('pr_watch.host_writer_budget_exhausted')),
        LOCAL_GIT_TIMEOUT_MS,
      );
      try {
        return await operation(budget.signal);
      } finally {
        clearTimeout(timer);
        outerSignal?.removeEventListener('abort', abortFromOuter);
      }
    });
  }

  async prepareLeaseInsideHostLock(args: {
    readonly state: PrWatchStateV1;
    readonly branch: string;
    readonly headSha: string;
    readonly signal?: AbortSignal;
    readonly now?: Date;
  }): Promise<PrWatchPreparedWorktreeLeaseV1> {
    parsePrWatchId(args.state.watchId);
    if (args.state.repoRoot !== realpathSync(this.repoRoot)) {
      throw new Error('pr_watch.worktree_repo_mismatch');
    }
    await git(this.repoRoot, ['check-ref-format', '--branch', args.branch], args.signal);
    const path = join(this.crewHome, 'pr-watches', args.state.watchId, 'worktree');
    const commonRaw = await git(this.repoRoot, ['rev-parse', '--git-common-dir'], args.signal);
    const upstream = await resolveUpstream(this.repoRoot, args.branch, args.signal);
    const expected = args.state.preparedWorktreeLease;
    if (expected !== undefined) {
      if (
        expected.worktreePath !== path
        || expected.remote !== upstream.remote
        || expected.branch !== args.branch
        || expected.expectedHeadSha !== args.headSha
        || expected.gitCommonDir !== realpathSync(resolve(this.repoRoot, commonRaw.trim()))
      ) {
        throw new Error('pr_watch.prepared_worktree_lease_conflict');
      }
      return expected;
    }
    return {
      leaseId: randomUUID(),
      worktreePath: path,
      remote: upstream.remote,
      branch: args.branch,
      expectedHeadSha: args.headSha,
      gitCommonDir: realpathSync(resolve(this.repoRoot, commonRaw.trim())),
      createdAt: (args.now ?? new Date()).toISOString(),
    };
  }

  async ensureLeaseInsideHostLock(args: {
    readonly state: PrWatchStateV1;
    readonly branch: string;
    readonly headSha: string;
    readonly signal?: AbortSignal;
    readonly now?: Date;
  }): Promise<PrWatchWorktreeLeaseV1> {
    parsePrWatchId(args.state.watchId);
    if (args.state.repoRoot !== realpathSync(this.repoRoot)) {
      throw new Error('pr_watch.worktree_repo_mismatch');
    }
    if (args.state.worktreeLease) {
      await this.assertLease(args.state.worktreeLease, args.signal, args.state.repository);
      return args.state.worktreeLease;
    }
    const prepared = args.state.preparedWorktreeLease;
    if (!prepared) throw new Error('pr_watch.prepared_worktree_lease_required');
    const path = prepared.worktreePath;

    const inventory = await git(this.repoRoot, ['worktree', 'list', '--porcelain'], args.signal);
    const canonicalTargetPath = existsSync(path) ? realpathSync(path) : resolve(path);
    const conflicts = parseWorktreeInventory(inventory).filter((entry) => (
      entry.branch === `refs/heads/${args.branch}`
      && (existsSync(entry.path) ? realpathSync(entry.path) : resolve(entry.path)) !== canonicalTargetPath
    ));
    if (conflicts.length > 0) {
      throw new Error(
        `pr_watch.watched_branch_checked_out: ${args.branch} at ${conflicts.map((entry) => entry.path).join(', ')}`,
      );
    }
    if (!existsSync(path)) {
      let localHead: string;
      try {
        localHead = (await git(
          this.repoRoot,
          ['rev-parse', '--verify', `refs/heads/${args.branch}`],
          args.signal,
        )).trim();
      } catch {
        throw new Error(`pr_watch.watched_branch_missing: ${args.branch}`);
      }
      if (localHead !== args.headSha) throw new Error('pr_watch.local_branch_head_changed');
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      await git(this.repoRoot, ['worktree', 'add', '--', path, args.branch], args.signal);
    }
    const lease: PrWatchWorktreeLeaseV1 = {
      ...prepared,
      worktreePath: path,
      finalizedAt: (args.now ?? new Date()).toISOString(),
    };
    await this.assertLease(lease, args.signal, args.state.repository);
    return lease;
  }

  async assertLease(
    lease: PrWatchWorktreeLeaseV1,
    signal?: AbortSignal,
    repository?: string,
  ): Promise<void> {
    if (!existsSync(lease.worktreePath)) throw new Error('pr_watch.worktree_lease_missing');
    const branch = (await git(lease.worktreePath, ['symbolic-ref', '--short', 'HEAD'], signal)).trim();
    if (branch !== lease.branch) throw new Error('pr_watch.worktree_lease_branch_changed');
    const head = (await git(lease.worktreePath, ['rev-parse', 'HEAD'], signal)).trim();
    if (head !== lease.expectedHeadSha) throw new Error('pr_watch.worktree_lease_head_changed');
    const status = await git(lease.worktreePath, ['status', '--porcelain=v2'], signal);
    if (status.trim().length > 0) throw new Error('pr_watch.worktree_lease_dirty');
    const commonRaw = await git(lease.worktreePath, ['rev-parse', '--git-common-dir'], signal);
    const common = realpathSync(resolve(lease.worktreePath, commonRaw.trim()));
    if (common !== lease.gitCommonDir) throw new Error('pr_watch.worktree_lease_common_dir_changed');
    const upstream = await resolveUpstream(lease.worktreePath, lease.branch, signal);
    if (upstream.remote !== lease.remote || upstream.branch !== lease.branch) {
      throw new Error('pr_watch.worktree_lease_upstream_changed');
    }
    if (repository !== undefined) {
      const remoteUrl = (await git(
        lease.worktreePath,
        ['remote', 'get-url', lease.remote],
        signal,
      )).trim();
      if (!remoteMatchesRepository(remoteUrl, repository)) {
        throw new Error('pr_watch.worktree_lease_remote_changed');
      }
    }
  }

  async removeLeaseInsideHostLock(
    state: PrWatchStateV1,
    signal?: AbortSignal,
  ): Promise<void> {
    parsePrWatchId(state.watchId);
    if (state.repoRoot !== realpathSync(this.repoRoot)) {
      throw new Error('pr_watch.worktree_repo_mismatch');
    }
    const lease = state.worktreeLease ?? state.preparedWorktreeLease;
    if (!lease) return;
    const expectedPath = join(this.crewHome, 'pr-watches', state.watchId, 'worktree');
    if (lease.worktreePath !== expectedPath) {
      throw new Error('pr_watch.worktree_teardown_path_mismatch');
    }
    const commonRaw = await git(this.repoRoot, ['rev-parse', '--git-common-dir'], signal);
    const common = realpathSync(resolve(this.repoRoot, commonRaw.trim()));
    if (common !== lease.gitCommonDir) {
      throw new Error('pr_watch.worktree_teardown_common_dir_mismatch');
    }
    const canonicalTarget = existsSync(expectedPath) ? realpathSync(expectedPath) : resolve(expectedPath);
    const inventory = parseWorktreeInventory(
      await git(this.repoRoot, ['worktree', 'list', '--porcelain'], signal),
    );
    const registered = inventory.some((entry) => (
      (existsSync(entry.path) ? realpathSync(entry.path) : resolve(entry.path)) === canonicalTarget
    ));
    if (registered) {
      try {
        await runGit(
          this.repoRoot,
          ['worktree', 'remove', expectedPath, '--force'],
          signal,
        );
      } catch (error) {
        if (existsSync(expectedPath)) throw error;
      }
    } else if (existsSync(expectedPath)) {
      throw new Error('pr_watch.worktree_teardown_unregistered_path');
    }
    await git(this.repoRoot, ['worktree', 'prune'], signal);
    const remaining = parseWorktreeInventory(
      await git(this.repoRoot, ['worktree', 'list', '--porcelain'], signal),
    ).some((entry) => (
      (existsSync(entry.path) ? realpathSync(entry.path) : resolve(entry.path)) === canonicalTarget
    ));
    if (remaining || existsSync(expectedPath)) {
      throw new Error('pr_watch.worktree_teardown_incomplete');
    }
  }
}

async function resolveUpstream(
  cwd: string,
  branch: string,
  signal?: AbortSignal,
): Promise<{ readonly remote: string; readonly branch: string }> {
  const raw = await git(cwd, [
    'for-each-ref',
    '--format=%(upstream:remotename)%00%(upstream:remoteref)',
    `refs/heads/${branch}`,
  ], signal);
  const [remote, remoteRef] = raw.trim().split('\0');
  const prefix = 'refs/heads/';
  if (!remote || !remoteRef?.startsWith(prefix) || remoteRef.length === prefix.length) {
    throw new Error(`pr_watch.watched_branch_upstream_missing: ${branch}`);
  }
  return { remote, branch: remoteRef.slice(prefix.length) };
}

function remoteMatchesRepository(remoteUrl: string, repository: string): boolean {
  const normalized = remoteUrl.replace(/\.git$/, '');
  return normalized.endsWith(`/${repository}`) || normalized.endsWith(`:${repository}`);
}

interface WorktreeInventoryEntry {
  readonly path: string;
  readonly branch?: string;
}

function parseWorktreeInventory(raw: string): readonly WorktreeInventoryEntry[] {
  return raw.trim().split(/\n\n+/).filter(Boolean).map((record) => {
    const fields = Object.fromEntries(record.split('\n').map((line) => {
      const space = line.indexOf(' ');
      return space < 0 ? [line, ''] : [line.slice(0, space), line.slice(space + 1)];
    }));
    return { path: fields.worktree, ...(fields.branch ? { branch: fields.branch } : {}) };
  }).filter((entry) => typeof entry.path === 'string' && entry.path.length > 0);
}

export async function git(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  if (args.some((arg) => ['--force', '--force-with-lease', '--mirror', '--delete'].includes(arg))) {
    throw new Error('pr_watch.forbidden_git_mutation_flag');
  }
  return runGit(cwd, args, signal);
}

export async function pushSingleBranchOutsideHostLock(args: {
  readonly cwd: string;
  readonly remoteUrl: string;
  readonly branch: string;
  readonly intendedSha: string;
  readonly signal?: AbortSignal;
}): Promise<void> {
  if (!/^[0-9a-f]{40}$/.test(args.intendedSha)) {
    throw new Error('pr_watch.invalid_push_sha');
  }
  if (
    args.remoteUrl.length === 0
    || args.remoteUrl.startsWith('-')
    || args.remoteUrl.includes('\0')
    || args.branch.length === 0
    || args.branch.startsWith('-')
    || args.branch.includes(':')
    || args.branch.includes('\0')
  ) {
    throw new Error('pr_watch.invalid_push_target');
  }
  await runGit(
    args.cwd,
    ['push', '--', args.remoteUrl, `${args.intendedSha}:refs/heads/${args.branch}`],
    args.signal,
    NETWORK_GIT_TIMEOUT_MS,
  );
}

async function runGit(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
  timeoutMs = LOCAL_GIT_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', [...args], {
      cwd,
      encoding: 'utf-8',
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      ...(signal ? { signal } : {}),
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = `${error.message}${stderr ? `: ${stderr.trim()}` : ''}`;
        const code = (error as NodeJS.ErrnoException).code;
        const killed = (error as NodeJS.ErrnoException & { readonly killed?: boolean }).killed === true;
        const abortReason = signal?.aborted
          ? signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? '')
          : '';
        if (killed || code === 'ETIMEDOUT' || abortReason.includes('host_writer_budget_exhausted')) {
          reject(new Error(`pr_watch.git_timeout: ${detail}`));
        } else if (code === 'ABORT_ERR' || signal?.aborted) {
          reject(new Error(`pr_watch.git_cancelled: ${detail}`));
        } else {
          reject(new Error(`pr_watch.git_failed: ${detail}`));
        }
      } else {
        resolvePromise(stdout);
      }
    });
  });
}
