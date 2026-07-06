import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export interface AtomicWriteOptions {
  readonly makeDirs?: boolean;
  /**
   * fsync the temp file before the rename (default true). Durable state
   * (state.json, receipts, panel/criteria records) must keep this on so a
   * crash can't land the rename with unflushed bytes. Ephemeral records
   * that a crash is ALLOWED to lose — lock owner.json files, whose stale
   * entries are reclaimed by timeout anyway — pass false to skip the
   * ms-scale fsync on every acquisition.
   */
  readonly fsync?: boolean;
}

export function atomicWrite(
  filePath: string,
  data: string,
  options: AtomicWriteOptions = {},
): void {
  if (options.makeDirs ?? true) {
    mkdirSync(dirname(filePath), { recursive: true });
  }
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${tempRandomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tempPath, 'w', 0o666);
    writeSync(fd, data, undefined, 'utf-8');
    if (options.fsync ?? true) {
      fsyncSync(fd);
    }
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, filePath);
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Caller sees the original write/fsync/rename error.
      }
    }
    try {
      unlinkSync(tempPath);
    } catch {
      // Caller sees the original write/rename error.
    }
    throw err;
  }
}

function tempRandomUUID(): string {
  return globalThis.crypto?.randomUUID?.() ?? randomUUID();
}
