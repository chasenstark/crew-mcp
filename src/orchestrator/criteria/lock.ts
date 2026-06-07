import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { withFileLock } from '../../utils/file-lock.js';
import { logger } from '../../utils/logger.js';
import { warnOnce } from '../../utils/warn-once.js';

export interface WithCriteriaLockOptions {
  readonly crewHome: string;
  readonly criteriaSetId: string;
}

const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 50;

export async function withCriteriaLock<T>(
  options: WithCriteriaLockOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const lockRoot = join(options.crewHome, 'criteria-locks');
  mkdirSync(lockRoot, { recursive: true });
  const lockDir = join(lockRoot, encodeURIComponent(options.criteriaSetId));
  return withFileLock(
    {
      lockDir,
      timeoutMs: getLockTimeoutMs(),
      staleMs: getLockStaleMs(),
      waitMs: LOCK_WAIT_MS,
      timeoutMessage:
        `criteria.lock_timeout: timed out waiting for criteria lock on ${options.criteriaSetId}`,
      missingRootMessage:
        `criteria.lock_unavailable: criteria lock root is unavailable for ${options.criteriaSetId}`,
    },
    operation,
  );
}

function getLockTimeoutMs(): number {
  return getPositiveIntegerEnv(
    'CREW_CRITERIA_LOCK_TIMEOUT_MS',
    DEFAULT_LOCK_TIMEOUT_MS,
  );
}

function getLockStaleMs(): number {
  return getPositiveIntegerEnv(
    'CREW_CRITERIA_LOCK_STALE_MS',
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
