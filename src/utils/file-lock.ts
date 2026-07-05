import { randomUUID } from 'crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';

import { atomicWrite } from './atomic-write.js';

export interface FileLockRecord {
  readonly ownerId: string;
  readonly pid: number;
  readonly acquiredAt: string;
}

export class FileLockTimeoutError extends Error {
  readonly lockDir: string;
  readonly holder?: FileLockRecord;

  constructor(message: string, args: { lockDir: string; holder?: FileLockRecord }) {
    super(message);
    this.name = 'FileLockTimeoutError';
    this.lockDir = args.lockDir;
    this.holder = args.holder;
  }
}

export interface WithFileLockOptions {
  readonly lockDir: string;
  readonly timeoutMs: number;
  readonly staleMs: number;
  readonly waitMs?: number;
  readonly timeoutMessage: string;
  readonly missingRootMessage?: string;
  /**
   * Preserves the historical worktree-lock recovery path for stale lock
   * dirs that predate owner.json. State locks keep the stricter owner-only
   * behavior by leaving this false.
   */
  readonly reclaimOwnerless?: boolean;
}

const DEFAULT_WAIT_MS = 50;

export async function withFileLock<T>(
  options: WithFileLockOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const ownerId = tempRandomUUID();
  const lockRecord: FileLockRecord = {
    ownerId,
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  };
  const timeoutAt = Date.now() + options.timeoutMs;

  while (true) {
    try {
      mkdirSync(options.lockDir);
      try {
        writeFileLockRecord(options.lockDir, lockRecord);
      } catch (err) {
        rmSync(options.lockDir, { recursive: true, force: true });
        throw err;
      }
      break;
    } catch (err) {
      if (isMissingLockRootError(err) && options.missingRootMessage) {
        throw new Error(options.missingRootMessage);
      }
      if (!isLockAlreadyHeldError(err)) {
        throw err;
      }
      if (tryReclaimFileLock(options.lockDir, options)) {
        continue;
      }
      if (Date.now() >= timeoutAt) {
        const holder = readFileLockRecord(options.lockDir);
        throw new FileLockTimeoutError(
          holder
            ? `${options.timeoutMessage} Holder pid=${holder.pid}, owner=${holder.ownerId}, acquiredAt=${holder.acquiredAt}.`
            : options.timeoutMessage,
          {
            lockDir: options.lockDir,
            ...(holder !== undefined ? { holder } : {}),
          },
        );
      }
      await sleep(options.waitMs ?? DEFAULT_WAIT_MS);
    }
  }

  try {
    return await operation();
  } finally {
    releaseFileLock(options.lockDir, ownerId);
  }
}

export function writeFileLockRecord(lockDir: string, record: FileLockRecord): void {
  atomicWrite(join(lockDir, 'owner.json'), JSON.stringify(record, null, 2));
}

export function readFileLockRecord(lockDir: string): FileLockRecord | undefined {
  const ownerPath = join(lockDir, 'owner.json');
  if (!existsSync(ownerPath)) {
    return undefined;
  }

  try {
    return JSON.parse(readFileSync(ownerPath, 'utf-8')) as FileLockRecord;
  } catch {
    return undefined;
  }
}

function tryReclaimFileLock(
  lockDir: string,
  options: Pick<WithFileLockOptions, 'staleMs' | 'reclaimOwnerless'>,
): boolean {
  const record = readFileLockRecord(lockDir);
  if (!record?.pid && !options.reclaimOwnerless) {
    return false;
  }
  if (record?.pid && getProcessStatus(record.pid) !== 'dead') {
    return false;
  }
  if (!isStaleLock(lockDir, options.staleMs)) {
    return false;
  }

  const staleDir = `${lockDir}.${tempRandomUUID()}.stale`;
  try {
    renameSync(lockDir, staleDir);
  } catch (err) {
    if (isEnoent(err)) return false;
    throw err;
  }

  const renamedRecord = readFileLockRecord(staleDir);
  if (
    isStaleLock(staleDir, options.staleMs)
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

function releaseFileLock(lockDir: string, ownerId: string): void {
  const record = readFileLockRecord(lockDir);
  if (record?.ownerId !== ownerId) {
    return;
  }
  rmSync(lockDir, { recursive: true, force: true });
}

function isStaleLock(lockDir: string, staleMs: number): boolean {
  try {
    const stats = statSync(lockDir);
    return (Date.now() - stats.mtimeMs) >= staleMs;
  } catch {
    return false;
  }
}

function getProcessStatus(pid: number): 'alive' | 'dead' | 'unknown' {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (err) {
    if (
      typeof err === 'object'
      && err !== null
      && 'code' in err
    ) {
      const code = (err as { code?: string }).code;
      if (code === 'EPERM') return 'alive';
      if (code === 'ESRCH') return 'dead';
    }
    return 'unknown';
  }
}

function isLockAlreadyHeldError(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: string }).code === 'EEXIST'
  );
}

function isMissingLockRootError(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: string }).code === 'ENOENT'
  );
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: string }).code === 'ENOENT'
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tempRandomUUID(): string {
  return globalThis.crypto?.randomUUID?.() ?? randomUUID();
}
