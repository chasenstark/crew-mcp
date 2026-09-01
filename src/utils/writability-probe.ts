import { randomUUID } from 'node:crypto';
import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DirWritabilityFailure {
  readonly path: string;
  readonly code: string;
}

/**
 * Prove a directory accepts new files by creating and removing a probe
 * dotfile. Sandboxed waiters (an unescalated Codex launch) can read state
 * under the Crew home but get EPERM on any write, so their durable claims
 * and leases silently never land; callers use this to fail fast at launch
 * instead of at delivery time. Returns the offending directory and errno
 * code on denial, undefined on success.
 */
export function probeDirWritability(dir: string): DirWritabilityFailure | undefined {
  const probePath = join(dir, `.crew-write-probe-${process.pid}-${randomUUID()}`);
  try {
    writeFileSync(probePath, '', { flag: 'wx', mode: 0o600 });
  } catch (err) {
    return { path: dir, code: errorCode(err) };
  }
  try {
    unlinkSync(probePath);
  } catch {
    // The write proved writability; a leaked zero-byte dotfile is harmless.
  }
  return undefined;
}

function errorCode(err: unknown): string {
  return err instanceof Error && 'code' in err && typeof (err as NodeJS.ErrnoException).code === 'string'
    ? (err as NodeJS.ErrnoException).code!
    : 'UNKNOWN';
}
