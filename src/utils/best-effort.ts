import { rmSync } from 'node:fs';

import { logger } from './logger.js';

const cleanupPaths = new Set<string>();
let cleanupRegistered = false;

export function logBestEffortFailure(op: string, err: unknown): void {
  logger.debug('best-effort failure', { op, err });
}

export function registerTempDirForCleanup(path: string): void {
  cleanupPaths.add(path);
  ensureCleanupRegistered();
}

export function unregisterTempDirForCleanup(path: string): void {
  cleanupPaths.delete(path);
}

function ensureCleanupRegistered(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.once('exit', cleanupRegisteredTempDirs);
  process.once('beforeExit', cleanupRegisteredTempDirs);
}

function cleanupRegisteredTempDirs(): void {
  for (const path of Array.from(cleanupPaths)) {
    try {
      rmSync(path, { recursive: true, force: true });
      cleanupPaths.delete(path);
    } catch (err) {
      logBestEffortFailure('temp-dir-cleanup', err);
    }
  }
}
