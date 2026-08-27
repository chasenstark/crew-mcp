import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { PrWatchStatus } from './types.js';

export type PrWatchProcessTraceRecord =
  | {
    readonly event: 'start';
    readonly ts: string;
    readonly watchId: string;
    readonly generation: number;
    readonly watcherActionId: string;
    readonly ownerId: string;
    readonly pid: number;
  }
  | {
    readonly event: 'wake';
    readonly ts: string;
    readonly watchId: string;
    readonly generation: number;
    readonly status: PrWatchStatus;
    readonly transport: 'claude_completion' | 'codex_app_server' | 'codex_queue';
  }
  | {
    readonly event: 'exit';
    readonly ts: string;
    readonly watchId: string;
    readonly generation: number;
    readonly status: PrWatchStatus | 'timeout' | 'lease_lost' | 'error';
  };

export function appendPrWatchProcessTrace(
  crewHome: string,
  record: PrWatchProcessTraceRecord,
): void {
  try {
    const path = join(crewHome, 'pr-watches', '.meta', 'process-trace.jsonl');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fd = openSync(path, 'a', 0o600);
    try {
      writeSync(fd, `${JSON.stringify(record)}\n`, undefined, 'utf-8');
    } finally {
      closeSync(fd);
    }
  } catch {
    // Process tracing is diagnostic only and cannot alter monitor behavior.
  }
}
