import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  closeSync,
  fsyncSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

import { withFileLock } from '../../utils/file-lock.js';
import { logger } from '../../utils/logger.js';
import { warnOnce } from '../../utils/warn-once.js';
import { repoHash } from '../auth/token.js';
import {
  CAPTAIN_INBOX_SCHEMA_VERSION,
  captainInboxMessageSchema,
  type CaptainInboxMessage,
} from './schema.js';

export type CaptainInboxErrorCode = 'inbox_full' | 'inbox_total_full';

export class CaptainInboxError extends Error {
  readonly code: CaptainInboxErrorCode;

  constructor(code: CaptainInboxErrorCode, message: string = code) {
    super(message);
    this.name = 'CaptainInboxError';
    this.code = code;
  }
}

export interface AppendMessageArgs {
  readonly crewHome: string;
  readonly message: Omit<CaptainInboxMessage, 'inbox_schema_version' | 'msg_id' | 'status' | 'created_at'> & {
    readonly created_at?: string;
  };
  readonly now?: Date;
  readonly env?: NodeJS.ProcessEnv;
}

export interface TransitionMessagesArgs {
  readonly crewHome: string;
  readonly repoRoot: string;
  readonly msgIds: readonly string[];
  readonly action: 'read' | 'dismiss';
  readonly now?: Date;
}

export function inboxRepoDir(crewHome: string, repoRoot: string): string {
  return join(crewHome, 'captain-inbox', repoHash(repoRoot));
}

export async function appendMessage(args: AppendMessageArgs): Promise<CaptainInboxMessage> {
  const repoRoot = args.message.repo_root_at_send;
  const dir = inboxRepoDir(args.crewHome, repoRoot);
  mkdirSync(dir, { recursive: true });
  const env = args.env ?? process.env;
  const caps = {
    maxUnread: getPositiveIntegerEnv('CREW_CAPTAIN_INBOX_MAX_UNREAD', 200, env),
    maxTotal: getPositiveIntegerEnv('CREW_CAPTAIN_INBOX_MAX_TOTAL', 1000, env),
  };

  return withInboxLock(dir, async () => {
    const counts = countMessages(dir);
    if (counts.unread >= caps.maxUnread) {
      throw new CaptainInboxError('inbox_full', `inbox_full: unread cap ${caps.maxUnread} reached`);
    }
    if (counts.total >= caps.maxTotal) {
      throw new CaptainInboxError(
        'inbox_total_full',
        `inbox_total_full: total cap ${caps.maxTotal} reached`,
      );
    }

    const now = (args.now ?? new Date()).toISOString();
    const message: CaptainInboxMessage = captainInboxMessageSchema.parse({
      ...args.message,
      inbox_schema_version: CAPTAIN_INBOX_SCHEMA_VERSION,
      msg_id: makeInboxMessageId(args.now),
      status: 'unread',
      created_at: args.message.created_at ?? now,
    });
    writeMessageAtomic(dir, message);
    return message;
  });
}

export function listMessages(args: {
  readonly crewHome: string;
  readonly repoRoot: string;
}): readonly CaptainInboxMessage[] {
  const dir = inboxRepoDir(args.crewHome, args.repoRoot);
  if (!existsSync(dir)) return [];
  const messages: CaptainInboxMessage[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const parsed = readMessageFile(dir, entry);
    if (parsed !== undefined) messages.push(parsed.message);
  }
  return messages.sort((a, b) => a.msg_id.localeCompare(b.msg_id));
}

export async function transitionMessages(args: TransitionMessagesArgs): Promise<readonly CaptainInboxMessage[]> {
  const dir = inboxRepoDir(args.crewHome, args.repoRoot);
  mkdirSync(dir, { recursive: true });
  const targetIds = new Set(args.msgIds);
  if (targetIds.size === 0) return [];
  const timestamp = (args.now ?? new Date()).toISOString();

  return withInboxLock(dir, async () => {
    const updated: CaptainInboxMessage[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const parsed = readMessageFile(dir, entry);
      if (parsed === undefined || !targetIds.has(parsed.message.msg_id)) continue;

      const next: CaptainInboxMessage = {
        ...parsed.message,
        status: args.action === 'read' ? 'read' : 'dismissed',
        ...(args.action === 'read' ? { read_at: timestamp } : { dismissed_at: timestamp }),
      };
      writeMessageAtomicAtPath(parsed.path, next);
      updated.push(next);
    }
    return updated.sort((a, b) => a.msg_id.localeCompare(b.msg_id));
  });
}

export function makeInboxMessageId(now = new Date()): string {
  return `${encodeCrockfordTime(now.getTime())}${encodeCrockfordRandom(16)}`;
}

function countMessages(dir: string): { readonly total: number; readonly unread: number } {
  let total = 0;
  let unread = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const parsed = readMessageFile(dir, entry);
    if (parsed === undefined) continue;
    total += 1;
    if (parsed.message.status === 'unread') unread += 1;
  }
  return { total, unread };
}

function writeMessageAtomic(dir: string, message: CaptainInboxMessage): void {
  writeMessageAtomicAtPath(join(dir, `${message.msg_id}.json`), message);
}

function writeMessageAtomicAtPath(path: string, message: CaptainInboxMessage): void {
  const tmp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeSync(fd, JSON.stringify(message, null, 2) + '\n', undefined, 'utf-8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Surface the original write/rename error.
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      // Surface the original write/rename error.
    }
    throw err;
  }
}

function readMessageFile(
  dir: string,
  entry: { readonly isFile: () => boolean; readonly name: string },
): { readonly path: string; readonly message: CaptainInboxMessage } | undefined {
  if (!entry.isFile() || !entry.name.endsWith('.json')) return undefined;
  const stem = entry.name.slice(0, -'.json'.length);
  const path = join(dir, entry.name);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    const result = captainInboxMessageSchema.safeParse(parsed);
    if (!result.success || result.data.msg_id !== stem) return undefined;
    return { path, message: result.data };
  } catch {
    // Readers tolerate in-flight temp files, corrupt files, and old shapes.
    return undefined;
  }
}

function withInboxLock<T>(repoDir: string, operation: () => Promise<T>): Promise<T> {
  return withFileLock(
    {
      lockDir: join(repoDir, '.lock'),
      timeoutMs: getPositiveIntegerEnv('CREW_CAPTAIN_INBOX_LOCK_TIMEOUT_MS', 30_000),
      staleMs: getPositiveIntegerEnv('CREW_CAPTAIN_INBOX_LOCK_STALE_MS', 60_000),
      waitMs: 50,
      timeoutMessage: `captain_inbox.lock_timeout: timed out waiting for inbox lock at ${repoDir}`,
    },
    operation,
  );
}

function getPositiveIntegerEnv(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[name];
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

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeCrockfordTime(ms: number): string {
  let value = Math.max(0, Math.floor(ms));
  let out = '';
  for (let i = 0; i < 10; i += 1) {
    out = CROCKFORD[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function encodeCrockfordRandom(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const byte of bytes) {
    out += CROCKFORD[byte % 32];
  }
  return out;
}
