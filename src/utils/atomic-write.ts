import { mkdirSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';

export function atomicWrite(filePath: string, data: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tempPath, data, 'utf-8');
  renameSync(tempPath, filePath);
}
