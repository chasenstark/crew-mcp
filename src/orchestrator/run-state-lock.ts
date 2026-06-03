import { join } from 'node:path';

import { withFileLock } from '../utils/file-lock.js';
import { logger } from '../utils/logger.js';
import { warnOnce } from '../utils/warn-once.js';

export interface WithStateLockOptions {
  readonly crewHome: string;
  readonly runId: string;
}

const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 50;

export async function withStateLock<T>(
  options: WithStateLockOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const lockDir = join(options.crewHome, 'state-locks', encodeURIComponent(options.runId));
  return withFileLock(
    {
      lockDir,
      timeoutMs: getLockTimeoutMs(),
      staleMs: getLockStaleMs(),
      waitMs: LOCK_WAIT_MS,
      timeoutMessage:
        `peer_messages.state_lock_timeout: timed out waiting for state lock on ${options.runId}`,
      missingRootMessage:
        `peer_messages.state_lock_unavailable: state lock root is unavailable for ${options.runId}`,
    },
    operation,
  );
}

function getLockTimeoutMs(): number {
  return getPositiveIntegerEnv(
    'CREW_STATE_LOCK_TIMEOUT_MS',
    DEFAULT_LOCK_TIMEOUT_MS,
  );
}

function getLockStaleMs(): number {
  return getPositiveIntegerEnv(
    'CREW_STATE_LOCK_STALE_MS',
    DEFAULT_LOCK_STALE_MS,
  );
}

function getPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    warnOnce(`env:${name}`, () => {
      logger.warn(`${name} is present but is not a positive integer; using ${fallback}`);
    });
    return fallback;
  }
  return Math.floor(parsed);
}
