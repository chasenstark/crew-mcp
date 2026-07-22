import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import type { ClientKind } from '../orchestrator/tools/shared.js';
import { withFileLock } from './file-lock.js';

export const TOOL_JOURNAL_MAX_BYTES = 10 * 1024 * 1024;
const ROTATION_LOCK_TIMEOUT_MS = 25;
const ROTATION_LOCK_STALE_MS = 30_000;

const SAFE_SCALAR_FIELDS = new Set([
  'agent_id',
  'run_id',
  'panel_id',
  'criteria_set_id',
  'run_mode',
  'read_only',
  'wait_for_change_ms',
  'wait_for_terminal_only',
  'user_requested_wait',
  'dispatch_anyway',
  'confirmed',
  'force',
  'merge_strategy',
  'status',
  'action',
]);

const DIGEST_FIELDS = new Set([
  'prompt',
  'peer_messages',
  'commit_body',
  'commit_title',
  'body',
]);

export interface JournalDigest {
  readonly present: true;
  readonly sha256_12: string;
  readonly length: number;
}

export interface ToolJournalRecord {
  readonly ts: string;
  readonly tool: string;
  readonly run_id?: string;
  readonly panel_id?: string;
  readonly args_digest: Readonly<Record<string, unknown>>;
  readonly wait_params?: Readonly<Record<string, number | boolean>>;
  readonly isError: boolean;
  readonly duration_ms: number;
  readonly clientKind: ClientKind;
  readonly captainServeInstance: string;
}

export interface AppendToolJournalOptions {
  readonly crewHome: string;
  readonly record: ToolJournalRecord;
  readonly maxBytes?: number;
}

export function toolJournalPath(crewHome: string): string {
  return join(crewHome, 'runs', '.meta', 'tool-journal.jsonl');
}

/**
 * Reduce tool arguments to an explicit safe allowlist. User-authored text is
 * represented only by a short digest and byte length; unknown fields are
 * omitted so future schemas fail closed instead of leaking new data.
 */
export function redactAndDigestArgs(args: unknown): Readonly<Record<string, unknown>> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  const source = args as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    if (SAFE_SCALAR_FIELDS.has(key) && isSafeScalar(value)) {
      out[key] = value;
      continue;
    }
    if (key === 'msg_ids' && Array.isArray(value)) {
      out.msg_ids_count = value.length;
      continue;
    }
    if (DIGEST_FIELDS.has(key) && value !== undefined) {
      out[key] = digestValue(value);
    }
  }
  return out;
}

export function waitParamsFromArgs(
  args: unknown,
): Readonly<Record<string, number | boolean>> | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const source = args as Record<string, unknown>;
  const out: Record<string, number | boolean> = {};
  for (const key of ['wait_for_change_ms', 'wait_for_terminal_only', 'user_requested_wait']) {
    const value = source[key];
    if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Match get_run_status's actual blocking modes. Parameter presence alone is
 * not enough: zero/false are immediate snapshots and user_requested_wait is
 * consent for terminal-only waiting, not a wait trigger.
 */
export function isWaitingWaitParams(
  waitParams: Readonly<Record<string, number | boolean>> | undefined,
): boolean {
  return (
    typeof waitParams?.wait_for_change_ms === 'number'
    && waitParams.wait_for_change_ms > 0
  ) || waitParams?.wait_for_terminal_only === true;
}

/**
 * Best-effort append. Serialization, directory creation, rotation, and write
 * failures are intentionally swallowed: diagnostics must never alter a tool
 * result. `open(..., 'a')` gives each JSONL record one O_APPEND write.
 */
export async function appendToolJournal(options: AppendToolJournalOptions): Promise<void> {
  try {
    const path = toolJournalPath(options.crewHome);
    const line = `${JSON.stringify(options.record)}\n`;
    mkdirSync(dirname(path), { recursive: true });
    await rotateIfNeeded(path, options.maxBytes ?? TOOL_JOURNAL_MAX_BYTES);
    appendLine(path, line);
  } catch {
    // Fail open: tool journaling is additive diagnostics only.
  }
}

function digestValue(value: unknown): JournalDigest {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = '[unserializable]';
  }
  return {
    present: true,
    sha256_12: createHash('sha256').update(text).digest('hex').slice(0, 12),
    length: Buffer.byteLength(text, 'utf-8'),
  };
}

function isSafeScalar(value: unknown): value is string | number | boolean | null {
  return value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean';
}

async function rotateIfNeeded(path: string, maxBytes: number): Promise<void> {
  if (!isAtOrAboveLimit(path, maxBytes)) return;
  await withFileLock(
    {
      lockDir: `${path}.lock`,
      timeoutMs: ROTATION_LOCK_TIMEOUT_MS,
      staleMs: ROTATION_LOCK_STALE_MS,
      timeoutMessage: `Timed out rotating tool journal ${path}.`,
      missingRootMessage: `Tool journal directory disappeared while rotating ${path}.`,
    },
    async () => {
      if (!isAtOrAboveLimit(path, maxBytes)) return;
      const first = `${path}.1`;
      const second = `${path}.2`;
      rmSync(second, { force: true });
      if (existsSync(first)) renameSync(first, second);
      if (existsSync(path)) renameSync(path, first);
    },
  );
}

function isAtOrAboveLimit(path: string, maxBytes: number): boolean {
  try {
    return statSync(path).size >= maxBytes;
  } catch {
    return false;
  }
}

function appendLine(path: string, line: string): void {
  const fd = openSync(path, 'a');
  try {
    writeSync(fd, line, undefined, 'utf-8');
  } finally {
    closeSync(fd);
  }
}
