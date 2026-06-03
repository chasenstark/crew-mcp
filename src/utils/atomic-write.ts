import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface AtomicWriteOptions {
  readonly makeDirs?: boolean;
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
  try {
    writeFileSync(tempPath, data, 'utf-8');
    renameSync(tempPath, filePath);
  } catch (err) {
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
