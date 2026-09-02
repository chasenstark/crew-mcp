/**
 * Worktree dependency provisioning — gives a write-mode run worktree a
 * ready `node_modules` without ever sharing mutable state with the host
 * tree (docs/proposals/worktree-deps-provisioning-2026-09-01.md).
 *
 * Two paths, both fail-closed:
 * - clonefile: a forced APFS copy-on-write copy of the host repo's
 *   `node_modules`, staged and atomically renamed into place. Forced
 *   (`COPYFILE_FICLONE_FORCE`) so an environment where cloning silently
 *   degrades to a full copy fails instead of lying about being cheap.
 * - install: `npm ci --ignore-scripts` in the worktree. Scripts are
 *   skipped because they are repository-controlled code and this install
 *   executes in the MCP server's environment, not the worker adapter's
 *   sandbox; native packages may need a worker-side `npm rebuild`.
 *
 * All functions here are lock-free; WorktreeManager.provisionRunDeps owns
 * the lock composition.
 */

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { logBestEffortFailure } from '../utils/best-effort.js';

const execFileAsync = promisify(execFile);

export const DEPS_PROVISION_POLICIES = ['skip', 'clone-only', 'clone-or-install'] as const;
export type DepsProvisionPolicy = (typeof DEPS_PROVISION_POLICIES)[number];

export type DepsProvisionMethod = 'clonefile' | 'install' | 'skipped' | 'failed';

/** Persisted on RunStateV1 and surfaced (snake_cased) in dispatch/status envelopes. */
export interface DepsProvisionRecord {
  readonly method: DepsProvisionMethod;
  readonly ms: number;
  /** Policy the LATEST attempt executed under (a re-provision is clone-only). */
  readonly policy: DepsProvisionPolicy;
  /**
   * Policy the dispatch originally requested. Preserved across staleness
   * re-provisions so a clone-only repair attempt does not erase the
   * install-capable intent for the next staleness decision. Absent on
   * records written before this field existed; readers fall back to
   * `policy`.
   */
  readonly requestedPolicy?: DepsProvisionPolicy;
  /** Install-provenance fingerprint of the provisioned worktree (see computeDepsFingerprint). */
  readonly fingerprint?: string;
  /** True when the install path ran with --ignore-scripts (always, in phase 1). */
  readonly scriptsSkipped?: boolean;
  readonly detail?: string;
}

export type DepsStalenessAction = 'none' | 'warn' | 'reprovision';

/**
 * Decide what a continue_run dirty-sync owes the provisioned deps: nothing
 * (no record / no fingerprint / unchanged), a warning (manifests moved but
 * the run never asked for install-capable provisioning), or a clone-only
 * re-provision (the ORIGINAL dispatch asked for `clone-or-install`).
 * Reads `requestedPolicy` with a `policy` fallback so pre-field records
 * and re-provisioned records both resolve to the dispatch intent.
 */
export function resolveDepsStalenessAction(
  deps: DepsProvisionRecord | undefined,
  freshFingerprint: string | undefined,
): DepsStalenessAction {
  if (deps?.fingerprint === undefined) return 'none';
  if (freshFingerprint === deps.fingerprint) return 'none';
  return (deps.requestedPolicy ?? deps.policy) === 'clone-or-install' ? 'reprovision' : 'warn';
}

export interface DepsEligibility {
  readonly eligible: boolean;
  readonly reason?: string;
  readonly fingerprint?: string;
}

const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60_000;
/** Directories walked concurrently during the symlink scan. */
const SYMLINK_SCAN_CONCURRENCY = 32;

async function readFileOrUndefined(path: string): Promise<Buffer | undefined> {
  try {
    return await fsp.readFile(path);
  } catch {
    return undefined;
  }
}

/**
 * Install-provenance fingerprint: manifests + npm config that shape an
 * install, plus platform/arch/node-major (native builds differ across
 * them). Lockfile-hash equality alone is NOT enough — the dirty-file sync
 * can put a modified lockfile in the worktree while the host
 * `node_modules` still embodies the old one — which is why clone
 * eligibility also requires `hostCloneSourceReady`.
 */
export async function computeDepsFingerprint(rootDir: string): Promise<string | undefined> {
  const pkg = await readFileOrUndefined(join(rootDir, 'package.json'));
  const lock = await readFileOrUndefined(join(rootDir, 'package-lock.json'));
  if (pkg === undefined || lock === undefined) return undefined;
  const hash = createHash('sha256');
  hash.update(pkg);
  hash.update(lock);
  const projectNpmrc = await readFileOrUndefined(join(rootDir, '.npmrc'));
  if (projectNpmrc !== undefined) hash.update(projectNpmrc);
  const userNpmrc = await readFileOrUndefined(join(homedir(), '.npmrc'));
  if (userNpmrc !== undefined) hash.update(userNpmrc);
  hash.update(`${process.platform}/${process.arch}/node${process.versions.node.split('.')[0]}`);
  return hash.digest('hex');
}

export async function evaluateDepsEligibility(rootDir: string): Promise<DepsEligibility> {
  const pkgRaw = await readFileOrUndefined(join(rootDir, 'package.json'));
  if (pkgRaw === undefined) return { eligible: false, reason: 'no package.json' };
  const lock = await readFileOrUndefined(join(rootDir, 'package-lock.json'));
  if (lock === undefined) {
    return { eligible: false, reason: 'no package-lock.json (npm-only in phase 1)' };
  }
  let pkg: unknown;
  try {
    pkg = JSON.parse(pkgRaw.toString('utf-8'));
  } catch {
    return { eligible: false, reason: 'unparseable package.json' };
  }
  const fingerprint = await computeDepsFingerprint(rootDir);
  if (
    pkg !== null && typeof pkg === 'object'
    && 'workspaces' in (pkg as Record<string, unknown>)
  ) {
    // Workspaces mean multiple install roots with unhoisted local
    // node_modules and repo-internal links; refuse rather than
    // half-provision.
    return { eligible: false, reason: 'workspace layout unsupported in phase 1', fingerprint };
  }
  return { eligible: true, fingerprint };
}

/**
 * Sorted per-package hash of a lockfile-shaped `packages` map. Used to
 * compare the host lockfile against npm's hidden
 * `node_modules/.package-lock.json` — npm's own ground truth for what is
 * actually installed — without depending on byte-level equality between
 * the two files. Includes the install-relevant identity fields
 * (version + integrity + resolved + link) so same-version drift in the
 * fetched artifact or a re-pointed resolution cannot pass as current.
 */
function packagesMapSignature(raw: Buffer): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf-8'));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const packages = (parsed as Record<string, unknown>).packages;
  if (packages === null || typeof packages !== 'object') return undefined;
  const lines: string[] = [];
  for (const [key, value] of Object.entries(packages as Record<string, unknown>)) {
    if (key === '') continue;
    const record = value !== null && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
    const field = (name: string): string =>
      typeof record[name] === 'string' ? (record[name] as string) : '?';
    lines.push(
      `${key}@${field('version')}#${field('integrity')}#${field('resolved')}#${record.link === true ? 'link' : ''}`,
    );
  }
  lines.sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/**
 * Is the host `node_modules` a valid clone source? Requires the hidden
 * lockfile npm maintains inside it to agree with the host lockfile, so a
 * stale or partial host install is never cloned.
 */
export async function hostCloneSourceReady(
  hostRoot: string,
): Promise<{ readonly ok: boolean; readonly reason?: string }> {
  const lock = await readFileOrUndefined(join(hostRoot, 'package-lock.json'));
  if (lock === undefined) return { ok: false, reason: 'host has no package-lock.json' };
  const hidden = await readFileOrUndefined(
    join(hostRoot, 'node_modules', '.package-lock.json'),
  );
  if (hidden === undefined) {
    return { ok: false, reason: 'host node_modules has no .package-lock.json install record' };
  }
  const lockSig = packagesMapSignature(lock);
  const hiddenSig = packagesMapSignature(hidden);
  if (lockSig === undefined || hiddenSig === undefined) {
    return { ok: false, reason: 'lockfile packages map unreadable (lockfileVersion 1?)' };
  }
  if (lockSig !== hiddenSig) {
    return { ok: false, reason: 'host node_modules is stale relative to its lockfile' };
  }
  return { ok: true };
}

/**
 * Torn-copy stamp: content hash of the host lockfile + hidden install
 * record. Captured immediately before and after the clone; a mismatch
 * means a host `npm install` raced the copy and the staging tree must be
 * discarded.
 */
export async function captureCloneSourceStamp(hostRoot: string): Promise<string | undefined> {
  const lock = await readFileOrUndefined(join(hostRoot, 'package-lock.json'));
  const hidden = await readFileOrUndefined(
    join(hostRoot, 'node_modules', '.package-lock.json'),
  );
  if (lock === undefined || hidden === undefined) return undefined;
  return createHash('sha256').update(lock).update(hidden).digest('hex');
}

function escapesRoot(resolvedPath: string, containRoot: string): boolean {
  const rel = relative(containRoot, resolvedPath);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/**
 * Real path of the deepest existing ancestor of `path` (the path itself
 * when it exists). Where a dangling symlink's file WOULD be created if
 * something wrote through it. Undefined only if nothing up to the
 * filesystem root exists; ENOENT walks up, every other error propagates.
 */
async function realpathNearestExistingAncestor(path: string): Promise<string | undefined> {
  let current = path;
  while (true) {
    try {
      return await fsp.realpath(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

/**
 * Scan EVERY symlink under `nodeModulesDir` (top-level, scoped, nested
 * node_modules, .bin) and return the first unsafe one: an absolute target,
 * a relative target that lexically escapes `containRoot`, or one whose
 * REAL resolution escapes it (an intermediate path component that is
 * itself a symlink pointing outside — lexical checks alone miss that).
 * Relative links whose real target stays inside the root are safe — they
 * resolve to the equivalent path after the tree is copied. A dangling
 * lexically-contained link is also safe: it cannot write through to
 * anything. Symlinks with absolute or escaping targets would point back
 * into the host (`npm link`-style) and re-open the write-through
 * corruption the clone path exists to prevent.
 *
 * Fail-closed: filesystem errors during the walk PROPAGATE — the caller
 * treats a failed scan as clone-ineligible rather than assuming an
 * unreadable directory holds no links.
 */
export async function findUnsafeSymlink(
  nodeModulesDir: string,
  containRoot: string,
): Promise<string | undefined> {
  const realRoot = await fsp.realpath(containRoot);
  const queue: string[] = [nodeModulesDir];
  while (queue.length > 0) {
    const batch = queue.splice(0, SYMLINK_SCAN_CONCURRENCY);
    const results = await Promise.all(batch.map(async (dir) => {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      const subdirs: string[] = [];
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          const target = await fsp.readlink(full);
          if (isAbsolute(target) || escapesRoot(resolve(dirname(full), target), containRoot)) {
            return { subdirs: [], unsafe: full };
          }
          let real: string | undefined;
          try {
            real = await fsp.realpath(full);
          } catch (err) {
            // Only a missing target is tolerable — and even then the
            // EXISTING part of the target path can route through an
            // intermediate symlink to the outside, where a later-created
            // file would land. Resolve the nearest existing ancestor and
            // contain that. Every other error (EACCES, ELOOP, ENOTDIR)
            // propagates so the clone gate stays fail-closed.
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
            real = await realpathNearestExistingAncestor(resolve(dirname(full), target));
          }
          if (real !== undefined && escapesRoot(real, realRoot)) {
            return { subdirs: [], unsafe: full };
          }
        } else if (entry.isDirectory()) {
          subdirs.push(full);
        }
      }
      return { subdirs, unsafe: undefined };
    }));
    for (const result of results) {
      if (result.unsafe !== undefined) return result.unsafe;
      queue.push(...result.subdirs);
    }
  }
  return undefined;
}

export type CloneAttemptOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: 'ineligible' | 'failed'; readonly reason: string };

/**
 * Copy-on-write clone of the host `node_modules` into the worktree:
 * staging dir on the same volume, pre/post source stamps against a racing
 * host install, then one atomic rename. Staging is removed on every
 * failure path.
 *
 * Clone enforcement, per platform:
 * - Linux: `cp -a --reflink=always` — genuinely fail-closed (errors
 *   instead of degrading to a full copy).
 * - Darwin: libuv does not implement `COPYFILE_FICLONE_FORCE` (ENOSYS),
 *   so a syscall-level force-clone is unreachable from Node. `cp -Rc`
 *   uses clonefile(2), which is guaranteed on a same-volume APFS pair —
 *   and the same-device gate below refuses everything else. The one
 *   residual is a same-device non-APFS volume (e.g. an HFS+ disk hosting
 *   both the repo and crew home), where `cp -c` silently degrades to a
 *   full copy; `ms` in the record keeps that visible.
 */
export async function cloneNodeModules(args: {
  readonly hostRoot: string;
  readonly worktreeRoot: string;
  /** Test seam: runs after the copy, before the post-copy stamp check. */
  readonly afterCopyForTest?: () => Promise<void>;
}): Promise<CloneAttemptOutcome> {
  const src = join(args.hostRoot, 'node_modules');
  const dest = join(args.worktreeRoot, 'node_modules');
  const staging = join(args.worktreeRoot, `node_modules.provisioning-${randomUUID().slice(0, 8)}`);
  const stampBefore = await captureCloneSourceStamp(args.hostRoot);
  if (stampBefore === undefined) {
    return { ok: false, kind: 'ineligible', reason: 'clone source stamp unavailable' };
  }
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    return { ok: false, kind: 'ineligible', reason: `no CoW clone path on ${process.platform}` };
  }
  try {
    const [srcStat, destParentStat] = await Promise.all([
      fsp.stat(src),
      fsp.stat(args.worktreeRoot),
    ]);
    if (srcStat.dev !== destParentStat.dev) {
      return { ok: false, kind: 'ineligible', reason: 'host and worktree are on different volumes' };
    }
    const cloneArgs = process.platform === 'darwin'
      ? ['-Rc', src, staging]
      : ['-a', '--reflink=always', src, staging];
    await execFileAsync('cp', cloneArgs, { maxBuffer: 1024 * 1024 });
    await args.afterCopyForTest?.();
    const stampAfter = await captureCloneSourceStamp(args.hostRoot);
    if (stampAfter !== stampBefore) {
      return { ok: false, kind: 'failed', reason: 'host install raced the clone; staging discarded' };
    }
    await fsp.rename(staging, dest);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      kind: 'failed',
      reason: `clone failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch((err: unknown) => {
      logBestEffortFailure('deps-provision staging cleanup', err);
    });
  }
}

/**
 * `npm ci` in the worktree, `--ignore-scripts` always: lifecycle scripts
 * are repo-controlled code and this process is the MCP server, not the
 * worker sandbox. The result's `scriptsSkipped` tells the captain that
 * native packages may need a worker-side `npm rebuild`.
 */
export async function installNodeModules(
  worktreeRoot: string,
  timeoutMs: number = DEFAULT_INSTALL_TIMEOUT_MS,
): Promise<{ readonly ok: boolean; readonly reason?: string }> {
  try {
    await execFileAsync(
      'npm',
      ['ci', '--prefer-offline', '--ignore-scripts', '--no-audit', '--no-fund'],
      { cwd: worktreeRoot, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
    );
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: `npm ci failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Clone phase: everything that must happen under the host snapshot read
 * lock (host reads + the copy itself). Returns a terminal record, or
 * undefined when the caller should fall through to the install phase
 * (clone-or-install policy only).
 */
export async function attemptClonePhase(args: {
  readonly worktreeRoot: string;
  readonly hostRoot: string;
  readonly policy: Exclude<DepsProvisionPolicy, 'skip'>;
  readonly startedAt: number;
}): Promise<DepsProvisionRecord | undefined> {
  const { worktreeRoot, hostRoot, policy, startedAt } = args;
  const finish = (
    method: DepsProvisionMethod,
    extra: Partial<DepsProvisionRecord>,
  ): DepsProvisionRecord => ({
    method,
    ms: Date.now() - startedAt,
    policy,
    requestedPolicy: policy,
    ...extra,
  });

  try {
    await fsp.access(join(worktreeRoot, 'node_modules'));
    return finish('skipped', { detail: 'node_modules already present in worktree' });
  } catch {
    // absent — the normal case for a fresh worktree
  }

  const worktreeEligibility = await evaluateDepsEligibility(worktreeRoot);
  if (!worktreeEligibility.eligible) {
    return finish('skipped', { detail: worktreeEligibility.reason });
  }
  const fingerprint = worktreeEligibility.fingerprint;

  const skipOrFallThrough = (reason: string): DepsProvisionRecord | undefined =>
    policy === 'clone-only'
      ? finish('skipped', { detail: `clone ineligible: ${reason}`, fingerprint })
      : undefined;

  const hostEligibility = await evaluateDepsEligibility(hostRoot);
  if (hostEligibility.fingerprint === undefined
    || hostEligibility.fingerprint !== fingerprint) {
    return skipOrFallThrough('host fingerprint differs from worktree');
  }
  const sourceReady = await hostCloneSourceReady(hostRoot);
  if (!sourceReady.ok) {
    return skipOrFallThrough(sourceReady.reason ?? 'host clone source not ready');
  }
  let unsafeLink: string | undefined;
  try {
    unsafeLink = await findUnsafeSymlink(join(hostRoot, 'node_modules'), hostRoot);
  } catch (err) {
    return skipOrFallThrough(
      `symlink scan failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (unsafeLink !== undefined) {
    return skipOrFallThrough(
      `unsafe symlink in host node_modules: ${relative(hostRoot, unsafeLink)}`,
    );
  }

  const clone = await cloneNodeModules({ hostRoot, worktreeRoot });
  if (clone.ok) return finish('clonefile', { fingerprint });
  if (clone.kind === 'failed' && policy === 'clone-only') {
    return finish('failed', { detail: clone.reason, fingerprint });
  }
  return policy === 'clone-only'
    ? finish('skipped', { detail: `clone ineligible: ${clone.reason}`, fingerprint })
    : undefined;
}

/** Install phase: run OUTSIDE the host snapshot lock (only the run lock). */
export async function attemptInstallPhase(args: {
  readonly worktreeRoot: string;
  readonly startedAt: number;
  readonly installTimeoutMs?: number;
}): Promise<DepsProvisionRecord> {
  const fingerprint = await computeDepsFingerprint(args.worktreeRoot);
  const install = await installNodeModules(args.worktreeRoot, args.installTimeoutMs);
  const base = {
    ms: Date.now() - args.startedAt,
    policy: 'clone-or-install' as const,
    requestedPolicy: 'clone-or-install' as const,
    ...(fingerprint !== undefined ? { fingerprint } : {}),
  };
  if (install.ok) {
    return { method: 'install', scriptsSkipped: true, ...base };
  }
  return { method: 'failed', detail: install.reason, ...base };
}
