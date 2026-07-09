import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';

import { withFileLock } from '../../utils/file-lock.js';
import { logger } from '../../utils/logger.js';
import { warnOnce } from '../../utils/warn-once.js';
import { repoHash } from '../auth/token.js';
import {
  CAPTAIN_INBOX_SCHEMA_VERSION,
  CAPTAIN_INBOX_MSG_ID_REGEX,
  captainInboxMessageSchema,
  type CaptainInboxMessage,
} from './schema.js';

export type CaptainInboxErrorCode = 'inbox_full' | 'inbox_total_full';
export const CAPTAIN_INBOX_RETENTION_DAYS = 7;
export const CAPTAIN_INBOX_SWEEP_COOLDOWN_MS = 10 * 60 * 1000;

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

export interface TransitionMessagesResult {
  readonly acknowledged: readonly string[];
  readonly not_found: readonly string[];
  readonly already_in_target_state: readonly string[];
}

export interface InboxSummary {
  readonly total_unread: number;
  readonly total_in_inbox: number;
  readonly oldest_unread_at?: string;
}

export interface SweepExpiredMessagesArgs {
  readonly crewHome: string;
  readonly repoRoot: string;
  readonly now?: Date;
  readonly env?: NodeJS.ProcessEnv;
  readonly force?: boolean;
}

let lastSweepAtMsByRepo = new Map<string, number>();

interface ParsedMessageCacheEntry {
  readonly path: string;
  readonly mtimeMs: number;
  readonly size: number;
  readonly message?: CaptainInboxMessage;
}

interface CaptainInboxFs {
  existsSync(path: string): boolean;
  mkdirSync(path: string, options: { readonly recursive: true }): void;
  readdirSync(path: string, options: { readonly withFileTypes: true }): fs.Dirent[];
  statSync(path: string): fs.Stats;
  readFileSync(path: string, encoding: 'utf-8'): string;
  openSync(path: string, flags: string, mode: number): number;
  writeSync(fd: number, string: string, position?: number | null, encoding?: BufferEncoding): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  renameSync(oldPath: string, newPath: string): void;
  unlinkSync(path: string): void;
}

const defaultCaptainInboxFs: CaptainInboxFs = {
  existsSync: fs.existsSync,
  mkdirSync: fs.mkdirSync,
  readdirSync: fs.readdirSync,
  statSync: fs.statSync,
  readFileSync: fs.readFileSync,
  openSync: fs.openSync,
  writeSync: fs.writeSync,
  fsyncSync: fs.fsyncSync,
  closeSync: fs.closeSync,
  renameSync: fs.renameSync,
  unlinkSync: fs.unlinkSync,
};

let captainInboxFs = defaultCaptainInboxFs;
const parsedMessageCache = new Map<string, ParsedMessageCacheEntry>();
const MSG_ID_PATTERN = CAPTAIN_INBOX_MSG_ID_REGEX.source.replace(/^\^/, '').replace(/\$$/, '');
const MESSAGE_FILE_RE = new RegExp(`^(${MSG_ID_PATTERN})\\.json$`);

export function inboxRepoDir(crewHome: string, repoRoot: string): string {
  return join(crewHome, 'captain-inbox', repoHash(repoRoot));
}

export async function appendMessage(args: AppendMessageArgs): Promise<CaptainInboxMessage> {
  const repoRoot = args.message.repo_root_at_send;
  const dir = inboxRepoDir(args.crewHome, repoRoot);
  captainInboxFs.mkdirSync(dir, { recursive: true });
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
  return collectMessages(args).sort((a, b) => a.msg_id.localeCompare(b.msg_id));
}

function collectMessages(args: {
  readonly crewHome: string;
  readonly repoRoot: string;
}): CaptainInboxMessage[] {
  const dir = inboxRepoDir(args.crewHome, args.repoRoot);
  if (!captainInboxFs.existsSync(dir)) return [];
  const messages: CaptainInboxMessage[] = [];
  const seenPaths = new Set<string>();
  for (const entry of captainInboxFs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = messagePathForEntry(dir, entry);
    if (entryPath !== undefined) seenPaths.add(entryPath);
    const parsed = readMessageFile(dir, entry);
    if (parsed !== undefined) {
      messages.push(parsed.message);
    }
  }
  pruneMissingMessageCacheEntries(dir, seenPaths);
  return messages;
}

export function summarizeInbox(args: {
  readonly crewHome: string;
  readonly repoRoot: string;
}): InboxSummary {
  const summary = { total: 0, unread: 0, oldestUnreadAt: undefined as string | undefined };
  for (const message of collectMessages(args)) {
    summary.total += 1;
    if (message.status === 'unread') {
      summary.unread += 1;
      if (summary.oldestUnreadAt === undefined || message.created_at < summary.oldestUnreadAt) {
        summary.oldestUnreadAt = message.created_at;
      }
    }
  }
  return {
    total_unread: summary.unread,
    total_in_inbox: summary.total,
    ...(summary.oldestUnreadAt !== undefined ? { oldest_unread_at: summary.oldestUnreadAt } : {}),
  };
}

export async function transitionMessages(args: TransitionMessagesArgs): Promise<TransitionMessagesResult> {
  const dir = inboxRepoDir(args.crewHome, args.repoRoot);
  captainInboxFs.mkdirSync(dir, { recursive: true });
  const targetIds = new Set(args.msgIds);
  if (targetIds.size === 0) {
    return { acknowledged: [], not_found: [], already_in_target_state: [] };
  }
  const timestamp = (args.now ?? new Date()).toISOString();
  const targetStatus = args.action === 'read' ? 'read' : 'dismissed';

  return withInboxLock(dir, async () => {
    const acknowledged: string[] = [];
    const alreadyInTargetState: string[] = [];
    const notFound: string[] = [];
    const writes: AtomicMessageWrite[] = [];
    for (const targetId of targetIds) {
      if (!isValidMsgId(targetId)) {
        notFound.push(targetId);
        continue;
      }
      const parsed = readMessageById(dir, targetId);
      if (parsed === undefined) {
        notFound.push(targetId);
        continue;
      }
      if (parsed.message.status === targetStatus) {
        alreadyInTargetState.push(parsed.message.msg_id);
        continue;
      }

      const next: CaptainInboxMessage = {
        ...parsed.message,
        status: targetStatus,
        ...(args.action === 'read' ? { read_at: timestamp } : { dismissed_at: timestamp }),
      };
      writes.push({ path: parsed.path, message: next });
      acknowledged.push(next.msg_id);
    }
    writeMessagesAtomicBatch(writes);
    return {
      acknowledged: acknowledged.sort(),
      not_found: notFound.sort(),
      already_in_target_state: alreadyInTargetState.sort(),
    };
  });
}

export async function sweepExpiredMessages(args: SweepExpiredMessagesArgs): Promise<{
  readonly swept: number;
  readonly skipped: boolean;
}> {
  const dir = inboxRepoDir(args.crewHome, args.repoRoot);
  if (!captainInboxFs.existsSync(dir)) return { swept: 0, skipped: false };
  const now = args.now ?? new Date();
  const nowMs = now.getTime();
  const key = dir;
  const lastSweepAtMs = lastSweepAtMsByRepo.get(key);
  // Ten minutes keeps opportunistic checks cheap on hot inboxes while still
  // making retention converge promptly during active captain sessions.
  if (args.force !== true && lastSweepAtMs !== undefined && nowMs - lastSweepAtMs < CAPTAIN_INBOX_SWEEP_COOLDOWN_MS) {
    return { swept: 0, skipped: true };
  }
  lastSweepAtMsByRepo.set(key, nowMs);
  const cutoffMs = nowMs - getRetentionDays(args.env ?? process.env) * 24 * 60 * 60 * 1000;

  return withInboxLock(dir, async () => {
    let swept = 0;
    for (const entry of captainInboxFs.readdirSync(dir, { withFileTypes: true })) {
      const parsed = readMessageFile(dir, entry);
      if (parsed === undefined) continue;
      const timestamp = sweepTimestamp(parsed.message);
      if (timestamp === undefined || Date.parse(timestamp) >= cutoffMs) continue;
      captainInboxFs.unlinkSync(parsed.path);
      parsedMessageCache.delete(parsed.path);
      swept += 1;
    }
    return { swept, skipped: false };
  });
}

export function makeInboxMessageId(now = new Date()): string {
  return `${encodeCrockfordTime(now.getTime())}${encodeCrockfordRandom(16)}`;
}

function countMessages(dir: string): { readonly total: number; readonly unread: number } {
  let total = 0;
  let unread = 0;
  const seenPaths = new Set<string>();
  for (const entry of captainInboxFs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = messagePathForEntry(dir, entry);
    if (entryPath !== undefined) seenPaths.add(entryPath);
    const parsed = readMessageFile(dir, entry);
    if (parsed === undefined) continue;
    total += 1;
    if (parsed.message.status === 'unread') unread += 1;
  }
  pruneMissingMessageCacheEntries(dir, seenPaths);
  return { total, unread };
}

function sweepTimestamp(message: CaptainInboxMessage): string | undefined {
  if (message.status === 'read') return message.read_at;
  if (message.status === 'dismissed') return message.dismissed_at;
  return undefined;
}

function writeMessageAtomic(dir: string, message: CaptainInboxMessage): void {
  writeMessageAtomicAtPath(join(dir, `${message.msg_id}.json`), message);
}

function writeMessageAtomicAtPath(
  path: string,
  message: CaptainInboxMessage,
): void {
  const tmp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let fd: number | undefined;
  try {
    fd = captainInboxFs.openSync(tmp, 'wx', 0o600);
    captainInboxFs.writeSync(fd, JSON.stringify(message, null, 2) + '\n', undefined, 'utf-8');
    captainInboxFs.fsyncSync(fd);
    captainInboxFs.closeSync(fd);
    fd = undefined;
    captainInboxFs.renameSync(tmp, path);
    cacheWrittenMessage(path, message);
  } catch (err) {
    if (fd !== undefined) {
      try {
        captainInboxFs.closeSync(fd);
      } catch {
        // Surface the original write/rename error.
      }
    }
    try {
      captainInboxFs.unlinkSync(tmp);
    } catch {
      // Surface the original write/rename error.
    }
    throw err;
  }
}

interface AtomicMessageWrite {
  readonly path: string;
  readonly message: CaptainInboxMessage;
}

interface PendingAtomicMessageWrite extends AtomicMessageWrite {
  readonly tmp: string;
  fd?: number;
  renamed: boolean;
}

function writeMessagesAtomicBatch(writes: readonly AtomicMessageWrite[]): void {
  if (writes.length === 0) return;
  const pending: PendingAtomicMessageWrite[] = [];
  try {
    for (const write of writes) {
      const tmp = `${write.path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
      const fd = captainInboxFs.openSync(tmp, 'wx', 0o600);
      // Track the fd + tmp before writeSync so a mid-write failure (e.g. ENOSPC)
      // still routes through the catch block's fd-close + tmp-unlink cleanup.
      pending.push({ ...write, tmp, fd, renamed: false });
      captainInboxFs.writeSync(fd, JSON.stringify(write.message, null, 2) + '\n', undefined, 'utf-8');
    }

    for (const write of pending) {
      if (write.fd !== undefined) captainInboxFs.fsyncSync(write.fd);
    }
    for (const write of pending) {
      if (write.fd !== undefined) {
        captainInboxFs.closeSync(write.fd);
        write.fd = undefined;
      }
    }
    for (const write of pending) {
      captainInboxFs.renameSync(write.tmp, write.path);
      write.renamed = true;
      cacheWrittenMessage(write.path, write.message);
    }
  } catch (err) {
    for (const write of pending) {
      if (write.fd !== undefined) {
        try {
          captainInboxFs.closeSync(write.fd);
          write.fd = undefined;
        } catch {
          // Surface the original write/fsync/rename error.
        }
      }
      if (!write.renamed) {
        try {
          captainInboxFs.unlinkSync(write.tmp);
        } catch {
          // Surface the original write/fsync/rename error.
        }
      }
    }
    throw err;
  }
}

function readMessageFile(
  dir: string,
  entry: { readonly isFile: () => boolean; readonly name: string },
): { readonly path: string; readonly message: CaptainInboxMessage } | undefined {
  const path = messagePathForEntry(dir, entry);
  if (path === undefined) return undefined;
  return readMessagePath(path, entry.name.slice(0, -'.json'.length));
}

function readMessageById(
  dir: string,
  msgId: string,
): { readonly path: string; readonly message: CaptainInboxMessage } | undefined {
  if (!isValidMsgId(msgId)) return undefined;
  return readMessagePath(join(dir, `${msgId}.json`), msgId);
}

function readMessagePath(
  path: string,
  expectedMsgId: string,
): { readonly path: string; readonly message: CaptainInboxMessage } | undefined {
  let stat: { readonly mtimeMs: number; readonly size: number };
  try {
    stat = messageStat(path);
  } catch {
    parsedMessageCache.delete(path);
    return undefined;
  }

  const cached = parsedMessageCache.get(path);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.message !== undefined ? { path, message: cached.message } : undefined;
  }

  try {
    const parsed = JSON.parse(captainInboxFs.readFileSync(path, 'utf-8')) as unknown;
    const result = captainInboxMessageSchema.safeParse(parsed);
    if (!result.success || result.data.msg_id !== expectedMsgId) {
      parsedMessageCache.set(path, { path, ...stat });
      return undefined;
    }
    parsedMessageCache.set(path, { path, ...stat, message: result.data });
    return { path, message: result.data };
  } catch {
    // Readers tolerate in-flight temp files, corrupt files, and old shapes.
    parsedMessageCache.set(path, { path, ...stat });
    return undefined;
  }
}

function messagePathForEntry(
  dir: string,
  entry: { readonly isFile: () => boolean; readonly name: string },
): string | undefined {
  if (!entry.isFile()) return undefined;
  if (MESSAGE_FILE_RE.exec(entry.name) === null) return undefined;
  return join(dir, entry.name);
}

function cacheWrittenMessage(path: string, message: CaptainInboxMessage): void {
  try {
    parsedMessageCache.set(path, {
      path,
      ...messageStat(path),
      message,
    });
  } catch {
    parsedMessageCache.delete(path);
  }
}

function messageStat(path: string): { readonly mtimeMs: number; readonly size: number } {
  const stat = captainInboxFs.statSync(path);
  return { mtimeMs: stat.mtimeMs, size: stat.size };
}

function pruneMissingMessageCacheEntries(dir: string, seenPaths: Set<string>): void {
  const expectedPathPrefix = `${dir}/`;
  for (const [path] of parsedMessageCache) {
    if (path.startsWith(expectedPathPrefix) && !seenPaths.has(path)) {
      parsedMessageCache.delete(path);
    }
  }
}

function isValidMsgId(value: string): boolean {
  return CAPTAIN_INBOX_MSG_ID_REGEX.test(value);
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

function getRetentionDays(env: NodeJS.ProcessEnv): number {
  return getPositiveIntegerEnv(
    'CREW_CAPTAIN_INBOX_RETENTION_DAYS',
    CAPTAIN_INBOX_RETENTION_DAYS,
    env,
  );
}

export function clearCaptainInboxSweepStateForTest(): void {
  lastSweepAtMsByRepo = new Map<string, number>();
}

export function clearCaptainInboxCachesForTest(): void {
  parsedMessageCache.clear();
  lastSweepAtMsByRepo = new Map<string, number>();
}

export function setCaptainInboxFsForTest(overrides: Partial<CaptainInboxFs>): () => void {
  captainInboxFs = { ...defaultCaptainInboxFs, ...overrides };
  parsedMessageCache.clear();
  return () => {
    captainInboxFs = defaultCaptainInboxFs;
    parsedMessageCache.clear();
  };
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
