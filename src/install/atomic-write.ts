/**
 * Atomic-write + install-lock helpers for `crew-mcp install`.
 *
 * The plan (`docs/plans/active/crew-iterate-skill.md` §"Atomicity &
 * locking requirements") mandates two properties for the install
 * pipeline:
 *
 *   1. All file writes are atomic — a crash mid-write leaves either
 *      the old file or the complete new file, never a partial. We
 *      achieve this with the classic write-tmp + rename pattern.
 *      Rename is atomic on POSIX when source and destination are on
 *      the same filesystem; we ensure that by writing the tmp file
 *      next to the destination.
 *
 *   2. Concurrent installs targeting the same `home` serialize. The
 *      plan calls for POSIX `flock(2)` because the kernel
 *      auto-releases on process exit (including SIGKILL / OOM),
 *      avoiding the stale-lock deadlock that PID-in-lockfile schemes
 *      hit. Node's core API doesn't expose `flock(2)` directly, so we
 *      use the documented fallback: `open(path, 'wx')` (O_EXCL create,
 *      atomic per POSIX) with a PID inside and a staleness check
 *      (`process.kill(pid, 0)`) to recover after a crash. This isn't
 *      kernel-auto-released but `process.kill(pid, 0)` reliably
 *      detects a dead holder before retrying. Trade-off accepted.
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Write `content` to `path` atomically: write to a sibling tmp file,
 * then rename into place. A crash mid-call leaves either the old file
 * (rename hasn't happened yet) or the complete new file; readers never
 * observe a partial write.
 *
 * Same semantics as the existing `writeInstallManifest` helper, but
 * usable for skill / config / permissions writes too.
 */
export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  // Use process PID + a small counter so concurrent writes inside the
  // same process can't collide on the tmp path. The counter is
  // process-local; concurrent processes are serialized by the install
  // lock above, but the PID alone is sufficient for that case.
  const tmpPath = `${path}.${process.pid}.${nextTmpId()}.tmp`;
  try {
    writeFileSync(tmpPath, content, 'utf-8');
    renameSync(tmpPath, path);
  } catch (err) {
    // Best-effort cleanup of the orphan tmp file if rename failed.
    try {
      unlinkSync(tmpPath);
    } catch {
      // Ignore — caller will see the original error.
    }
    throw err;
  }
}

let tmpCounter = 0;
function nextTmpId(): number {
  tmpCounter = (tmpCounter + 1) % 0x7fffffff;
  return tmpCounter;
}

/**
 * Lock file path. One per `home`. Lives next to the install manifest
 * so a single rm of `~/.crew` cleans everything up if the user wants
 * a clean slate.
 */
export function installLockPath(home: string): string {
  return join(home, '.crew', '.install-lock');
}

/**
 * Acquire the per-home install lock. Returns a handle whose `release()`
 * MUST be called in a finally block. If the lock is held by a running
 * process, retry with backoff up to `timeoutMs`; if the holding process
 * is dead (per `process.kill(pid, 0)`), the stale lock is removed and
 * acquisition proceeds.
 *
 * Throws on timeout with a message that names the lock path and the
 * holder PID, so the user can intervene.
 */
export interface InstallLockHandle {
  readonly path: string;
  release(): void;
}

export interface AcquireOptions {
  /** Total wait budget before throwing. Defaults to 30s. */
  readonly timeoutMs?: number;
  /** Polling interval while waiting on a live holder. Defaults to 250ms. */
  readonly pollMs?: number;
}

export async function acquireInstallLock(
  home: string,
  options: AcquireOptions = {},
): Promise<InstallLockHandle> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 250;
  const lockPath = installLockPath(home);

  mkdirSync(dirname(lockPath), { recursive: true });

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (tryAcquire(lockPath)) {
      return { path: lockPath, release: () => releaseLock(lockPath) };
    }
    // Existing lock — check if the holder is dead, then wait or fail.
    const holderPid = readHolderPid(lockPath);
    if (holderPid !== null && !isProcessAlive(holderPid)) {
      // Stale: holder is gone. Remove and retry immediately.
      try {
        unlinkSync(lockPath);
      } catch {
        // Race with another reaper — that's fine; the next tryAcquire
        // will either succeed or surface the new holder.
      }
      continue;
    }
    if (Date.now() >= deadline) {
      const holderNote = holderPid !== null
        ? ` (held by pid ${holderPid})`
        : '';
      throw new Error(
        `crew install: install lock held by another process${holderNote}; `
        + `lock path is ${lockPath}. Retry after the other install completes, `
        + 'or remove the lock file manually if you are certain no install is running.',
      );
    }
    await sleep(pollMs);
  }
}

/**
 * Convenience: acquire the lock, run `fn`, release in finally even if
 * `fn` throws.
 */
export async function withInstallLock<T>(
  home: string,
  fn: () => Promise<T>,
  options: AcquireOptions = {},
): Promise<T> {
  const handle = await acquireInstallLock(home, options);
  try {
    return await fn();
  } finally {
    handle.release();
  }
}

function tryAcquire(lockPath: string): boolean {
  try {
    // 'wx' = O_WRONLY | O_CREAT | O_EXCL — fails atomically if the
    // file already exists. POSIX-safe single-call create-or-fail.
    const fd = openSync(lockPath, 'wx');
    try {
      writeSync(fd, `${process.pid}\n`);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    throw err;
  }
}

function readHolderPid(lockPath: string): number | null {
  try {
    const raw = readFileSync(lockPath, 'utf-8').trim();
    if (raw.length === 0) return null;
    const pid = Number.parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return pid;
  } catch {
    // ENOENT (lock just released) or unreadable — let caller retry.
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    // Signal 0 is the standard "does this process exist?" probe — it
    // performs the permission check but doesn't deliver a signal.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we can't signal it — still
    // alive, so don't treat as stale.
    if (code === 'EPERM') return true;
    // ESRCH = no such process; anything else, be conservative and
    // treat as alive (better to wait than to break a real install).
    return code !== 'ESRCH';
  }
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      // Surface unexpected errors; ENOENT means someone already
      // cleaned up (or the lock was never created), which is fine.
      throw err;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
