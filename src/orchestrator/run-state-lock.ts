import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export interface WithStateLockOptions {
  readonly crewHome: string;
  readonly runId: string;
}

interface StateLockRecord {
  readonly ownerId: string;
  readonly pid: number;
  readonly acquiredAt: string;
}

const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 50;

export async function withStateLock<T>(
  options: WithStateLockOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const lockDir = join(options.crewHome, 'state-locks', encodeURIComponent(options.runId));
  const ownerId = randomUUID();
  const lockRecord: StateLockRecord = {
    ownerId,
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  };
  const timeoutAt = Date.now() + getLockTimeoutMs();

  while (true) {
    try {
      mkdirSync(lockDir);
      try {
        writeStateLockRecord(lockDir, lockRecord);
      } catch (err) {
        rmSync(lockDir, { recursive: true, force: true });
        throw err;
      }
      break;
    } catch (err) {
      if (isMissingLockRootError(err)) {
        throw new Error(
          `peer_messages.state_lock_unavailable: state lock root is unavailable for ${options.runId}`,
        );
      }
      if (!isLockAlreadyHeldError(err)) {
        throw err;
      }
      if (canReclaimStateLock(lockDir)) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= timeoutAt) {
        throw new Error(
          `peer_messages.state_lock_timeout: timed out waiting for state lock on ${options.runId}`,
        );
      }
      await sleep(LOCK_WAIT_MS);
    }
  }

  try {
    return await operation();
  } finally {
    releaseStateLock(lockDir, ownerId);
  }
}

function writeStateLockRecord(lockDir: string, record: StateLockRecord): void {
  const targetPath = join(lockDir, 'owner.json');
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, JSON.stringify(record, null, 2), 'utf-8');
  renameSync(tempPath, targetPath);
}

function readStateLockRecord(lockDir: string): StateLockRecord | undefined {
  const ownerPath = join(lockDir, 'owner.json');
  if (!existsSync(ownerPath)) {
    return undefined;
  }

  try {
    return JSON.parse(readFileSync(ownerPath, 'utf-8')) as StateLockRecord;
  } catch {
    return undefined;
  }
}

function canReclaimStateLock(lockDir: string): boolean {
  const record = readStateLockRecord(lockDir);
  if (!record?.pid) {
    return false;
  }
  const status = getProcessStatus(record.pid);
  if (status !== 'dead') {
    return false;
  }
  return isStaleLock(lockDir);
}

function releaseStateLock(lockDir: string, ownerId: string): void {
  const record = readStateLockRecord(lockDir);
  if (record?.ownerId !== ownerId) {
    return;
  }
  rmSync(lockDir, { recursive: true, force: true });
}

function isStaleLock(lockDir: string): boolean {
  try {
    const stats = statSync(lockDir);
    return (Date.now() - stats.mtimeMs) >= getLockStaleMs();
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

function getLockTimeoutMs(): number {
  return getPositiveIntegerEnv('CREW_STATE_LOCK_TIMEOUT_MS', DEFAULT_LOCK_TIMEOUT_MS);
}

function getLockStaleMs(): number {
  return getPositiveIntegerEnv('CREW_STATE_LOCK_STALE_MS', DEFAULT_LOCK_STALE_MS);
}

function getPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
