import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { atomicWrite } from '../utils/atomic-write.js';
import { withFileLock } from '../utils/file-lock.js';
import { validateCodexThreadId } from './app-server-bridge.js';
import {
  CodexQueueWakeError,
  queueCodexNativeReviewerThread,
} from './queue-wake.js';

const SCHEMA_VERSION = 1;
const TOMBSTONE_TTL_MS = 10 * 60 * 1_000;
const CLAIM_TTL_MS = 24 * 60 * 60 * 1_000;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

export type NativeReviewerWakeState =
  | 'tombstone'
  | 'registered'
  | 'completed'
  | 'delivering'
  | 'delivered'
  | 'delivery_ambiguous'
  | 'resolved';

interface NativeReviewerWakeRecord {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly threadId: string;
  readonly agentId: string;
  readonly repoRoot: string;
  readonly panelId?: string;
  readonly state: NativeReviewerWakeState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
  readonly registeredAt?: string;
  readonly completedAt?: string;
  readonly deliveredAt?: string;
  readonly resolvedAt?: string;
  readonly deliveryOwnerId?: string;
}

export interface NativeReviewerWakeTarget {
  readonly crewHome: string;
  readonly repoRoot: string;
  readonly threadId: string;
  readonly agentId: string;
  readonly panelId?: string;
}

export interface NativeReviewerWakeDeps {
  readonly now?: () => Date;
  readonly queueWake?: typeof queueCodexNativeReviewerThread;
}

export interface NativeReviewerWakeResult {
  readonly state: NativeReviewerWakeState | 'missing';
  readonly action:
    | 'registered'
    | 'completion_recorded'
    | 'wake_queued'
    | 'delivery_ambiguous'
    | 'delivery_failed'
    | 'already_claimed'
    | 'resolved'
    | 'missing'
    | 'ignored_wrong_repo';
}

export async function registerNativeReviewer(
  target: NativeReviewerWakeTarget,
  deps: NativeReviewerWakeDeps = {},
): Promise<NativeReviewerWakeResult> {
  const now = deps.now ?? (() => new Date());
  const normalized = normalizeTarget(target);
  await pruneExpiredRecords(normalized.crewHome, now());
  const ownerId = randomUUID();
  const preparation = await withRecordLock(normalized, async () => {
    const current = readCurrentRecord(normalized, now());
    if (current && current.repoRoot !== normalized.repoRoot) {
      return { result: wrongRepoResult(current), deliver: false };
    }
    if (current?.panelId && normalized.panelId && current.panelId !== normalized.panelId) {
      throw new Error('native reviewer is already registered to a different panel');
    }

    const timestamp = now();
    if (!current) {
      const record = createRecord(normalized, 'registered', timestamp, {
        registeredAt: timestamp.toISOString(),
      });
      writeRecord(normalized, record);
      return {
        result: { state: record.state, action: 'registered' } satisfies NativeReviewerWakeResult,
        deliver: false,
      };
    }

    if (current.state === 'tombstone' || current.state === 'completed') {
      const claimed = claimForDelivery({
        ...current,
        ...(normalized.panelId ? { panelId: normalized.panelId } : {}),
        registeredAt: current.registeredAt ?? timestamp.toISOString(),
        expiresAt: new Date(timestamp.getTime() + CLAIM_TTL_MS).toISOString(),
      }, ownerId, timestamp);
      writeRecord(normalized, claimed);
      return { result: claimedResult(claimed), deliver: true };
    }

    return {
      result: existingResult(current),
      deliver: false,
    };
  });

  if (!preparation.deliver) return preparation.result;
  return deliverClaim(normalized, ownerId, now, deps.queueWake);
}

export async function recordNativeReviewerCompletion(
  target: Omit<NativeReviewerWakeTarget, 'panelId'>,
  deps: NativeReviewerWakeDeps = {},
): Promise<NativeReviewerWakeResult> {
  const now = deps.now ?? (() => new Date());
  const normalized = normalizeTarget(target);
  await pruneExpiredRecords(normalized.crewHome, now());
  const ownerId = randomUUID();
  const preparation = await withRecordLock(normalized, async () => {
    const current = readCurrentRecord(normalized, now());
    if (current && current.repoRoot !== normalized.repoRoot) {
      return { result: wrongRepoResult(current), deliver: false };
    }

    const timestamp = now();
    if (!current) {
      const record = createRecord(normalized, 'tombstone', timestamp, {
        completedAt: timestamp.toISOString(),
      });
      writeRecord(normalized, record);
      return {
        result: {
          state: record.state,
          action: 'completion_recorded',
        } satisfies NativeReviewerWakeResult,
        deliver: false,
      };
    }

    if (current.state === 'registered' || current.state === 'completed') {
      const claimed = claimForDelivery({
        ...current,
        completedAt: current.completedAt ?? timestamp.toISOString(),
      }, ownerId, timestamp);
      writeRecord(normalized, claimed);
      return { result: claimedResult(claimed), deliver: true };
    }

    return {
      result: existingResult(current),
      deliver: false,
    };
  });

  if (!preparation.deliver) return preparation.result;
  return deliverClaim(normalized, ownerId, now, deps.queueWake);
}

export async function getNativeReviewerWakeStatus(
  target: Omit<NativeReviewerWakeTarget, 'panelId'>,
  deps: Pick<NativeReviewerWakeDeps, 'now'> = {},
): Promise<NativeReviewerWakeResult> {
  const now = deps.now ?? (() => new Date());
  const normalized = normalizeTarget(target);
  await pruneExpiredRecords(normalized.crewHome, now());
  return withRecordLock(normalized, async () => {
    const current = readCurrentRecord(normalized, now());
    if (!current) return { state: 'missing', action: 'missing' };
    if (current.repoRoot !== normalized.repoRoot) return wrongRepoResult(current);
    return existingResult(current);
  });
}

export async function resolveNativeReviewerWake(
  target: Omit<NativeReviewerWakeTarget, 'panelId'>,
  deps: Pick<NativeReviewerWakeDeps, 'now'> = {},
): Promise<NativeReviewerWakeResult> {
  const now = deps.now ?? (() => new Date());
  const normalized = normalizeTarget(target);
  await pruneExpiredRecords(normalized.crewHome, now());
  return withRecordLock(normalized, async () => {
    const current = readCurrentRecord(normalized, now());
    if (!current) return { state: 'missing', action: 'missing' };
    if (current.repoRoot !== normalized.repoRoot) return wrongRepoResult(current);
    if (current.state === 'resolved') return existingResult(current);

    const timestamp = now().toISOString();
    const resolved: NativeReviewerWakeRecord = {
      ...current,
      state: 'resolved',
      updatedAt: timestamp,
      resolvedAt: timestamp,
      deliveryOwnerId: undefined,
    };
    writeRecord(normalized, resolved);
    return { state: 'resolved', action: 'resolved' };
  });
}

async function deliverClaim(
  target: NativeReviewerWakeTarget,
  ownerId: string,
  now: () => Date,
  queueWake: typeof queueCodexNativeReviewerThread = queueCodexNativeReviewerThread,
): Promise<NativeReviewerWakeResult> {
  let outcome: 'queued' | 'ambiguous' | 'failed';
  try {
    await queueWake({ threadId: target.threadId, agentId: target.agentId });
    outcome = 'queued';
  } catch (error) {
    outcome = error instanceof CodexQueueWakeError && error.ambiguous
      ? 'ambiguous'
      : 'failed';
  }

  return withRecordLock(target, async () => {
    const current = readCurrentRecord(target, now());
    if (
      !current
      || current.repoRoot !== target.repoRoot
      || current.state !== 'delivering'
      || current.deliveryOwnerId !== ownerId
    ) {
      return current && current.repoRoot === target.repoRoot
        ? existingResult(current)
        : { state: 'missing', action: 'missing' };
    }

    const timestamp = now().toISOString();
    const next: NativeReviewerWakeRecord = outcome === 'queued'
      ? {
          ...current,
          state: 'delivered',
          updatedAt: timestamp,
          deliveredAt: timestamp,
          deliveryOwnerId: undefined,
        }
      : outcome === 'ambiguous'
        ? {
            ...current,
            state: 'delivery_ambiguous',
            updatedAt: timestamp,
            deliveryOwnerId: undefined,
          }
        : {
            ...current,
            state: 'completed',
            updatedAt: timestamp,
            deliveryOwnerId: undefined,
          };
    writeRecord(target, next);
    return outcome === 'queued'
      ? { state: next.state, action: 'wake_queued' }
      : outcome === 'ambiguous'
        ? { state: next.state, action: 'delivery_ambiguous' }
        : { state: next.state, action: 'delivery_failed' };
  });
}

function claimForDelivery(
  record: NativeReviewerWakeRecord,
  ownerId: string,
  now: Date,
): NativeReviewerWakeRecord {
  return {
    ...record,
    state: 'delivering',
    updatedAt: now.toISOString(),
    deliveryOwnerId: ownerId,
  };
}

function claimedResult(record: NativeReviewerWakeRecord): NativeReviewerWakeResult {
  return { state: record.state, action: 'already_claimed' };
}

function existingResult(record: NativeReviewerWakeRecord): NativeReviewerWakeResult {
  if (record.state === 'resolved') return { state: record.state, action: 'resolved' };
  if (record.state === 'tombstone') {
    return { state: record.state, action: 'completion_recorded' };
  }
  if (record.state === 'registered') return { state: record.state, action: 'registered' };
  if (record.state === 'completed') return { state: record.state, action: 'delivery_failed' };
  if (record.state === 'delivery_ambiguous') {
    return { state: record.state, action: 'delivery_ambiguous' };
  }
  return { state: record.state, action: 'already_claimed' };
}

function wrongRepoResult(record: NativeReviewerWakeRecord): NativeReviewerWakeResult {
  return { state: record.state, action: 'ignored_wrong_repo' };
}

function createRecord(
  target: NativeReviewerWakeTarget,
  state: 'registered' | 'tombstone',
  now: Date,
  extra: Pick<NativeReviewerWakeRecord, 'registeredAt' | 'completedAt'>,
): NativeReviewerWakeRecord {
  const timestamp = now.toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    threadId: target.threadId,
    agentId: target.agentId,
    repoRoot: target.repoRoot,
    ...(target.panelId ? { panelId: target.panelId } : {}),
    state,
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: new Date(
      now.getTime() + (state === 'tombstone' ? TOMBSTONE_TTL_MS : CLAIM_TTL_MS),
    ).toISOString(),
    ...extra,
  };
}

function normalizeTarget<T extends NativeReviewerWakeTarget | Omit<NativeReviewerWakeTarget, 'panelId'>>(
  target: T,
): T & { readonly repoRoot: string } {
  validateCodexThreadId(target.threadId);
  validateCodexThreadId(target.agentId);
  if ('panelId' in target && target.panelId !== undefined) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(target.panelId)) {
      throw new Error('native reviewer panel id is invalid');
    }
  }
  const lexicalRoot = resolve(target.repoRoot);
  const repoRoot = existsSync(lexicalRoot) ? realpathSync(lexicalRoot) : lexicalRoot;
  return { ...target, repoRoot };
}

async function withRecordLock<T>(
  target: Pick<NativeReviewerWakeTarget, 'crewHome' | 'threadId' | 'agentId'>,
  operation: () => Promise<T>,
): Promise<T> {
  const roots = ensureRoots(target.crewHome);
  const key = recordKey(target.threadId, target.agentId);
  return withFileLock({
    lockDir: join(roots.locks, key),
    timeoutMs: LOCK_TIMEOUT_MS,
    staleMs: LOCK_STALE_MS,
    timeoutMessage: 'timed out waiting for native reviewer wake state lock.',
  }, operation);
}

function readCurrentRecord(
  target: Pick<NativeReviewerWakeTarget, 'crewHome' | 'threadId' | 'agentId'>,
  now: Date,
): NativeReviewerWakeRecord | undefined {
  const path = recordPath(target);
  if (!existsSync(path)) return undefined;
  const record = parseRecord(readFileSync(path, 'utf-8'));
  if (record.threadId !== target.threadId || record.agentId !== target.agentId) {
    throw new Error('native reviewer wake record identity mismatch');
  }
  if (Date.parse(record.expiresAt) <= now.getTime()) {
    unlinkSync(path);
    return undefined;
  }
  return record;
}

function parseRecord(raw: string): NativeReviewerWakeRecord {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('native reviewer wake record must be an object');
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== SCHEMA_VERSION
    || typeof record.threadId !== 'string'
    || typeof record.agentId !== 'string'
    || typeof record.repoRoot !== 'string'
    || !isAbsolute(record.repoRoot)
    || !isWakeState(record.state)
    || typeof record.createdAt !== 'string'
    || typeof record.updatedAt !== 'string'
    || typeof record.expiresAt !== 'string'
    || !isIsoDate(record.createdAt)
    || !isIsoDate(record.updatedAt)
    || !isIsoDate(record.expiresAt)
    || !optionalString(record.panelId)
    || !optionalIsoDate(record.registeredAt)
    || !optionalIsoDate(record.completedAt)
    || !optionalIsoDate(record.deliveredAt)
    || !optionalIsoDate(record.resolvedAt)
    || !optionalString(record.deliveryOwnerId)
  ) {
    throw new Error('native reviewer wake record is invalid');
  }
  validateCodexThreadId(record.threadId);
  validateCodexThreadId(record.agentId);
  return record as unknown as NativeReviewerWakeRecord;
}

function isIsoDate(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function optionalIsoDate(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && isIsoDate(value));
}

function isWakeState(value: unknown): value is NativeReviewerWakeState {
  return value === 'tombstone'
    || value === 'registered'
    || value === 'completed'
    || value === 'delivering'
    || value === 'delivered'
    || value === 'delivery_ambiguous'
    || value === 'resolved';
}

function writeRecord(
  target: Pick<NativeReviewerWakeTarget, 'crewHome' | 'threadId' | 'agentId'>,
  record: NativeReviewerWakeRecord,
): void {
  const path = recordPath(target);
  atomicWrite(path, `${JSON.stringify(record, null, 2)}\n`);
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}

function recordPath(
  target: Pick<NativeReviewerWakeTarget, 'crewHome' | 'threadId' | 'agentId'>,
): string {
  return join(
    resolve(target.crewHome),
    'native-reviewers',
    `${recordKey(target.threadId, target.agentId)}.json`,
  );
}

function ensureRoots(crewHome: string): { readonly records: string; readonly locks: string } {
  const root = resolve(crewHome);
  const records = join(root, 'native-reviewers');
  const locks = join(root, 'native-reviewer-locks');
  mkdirSync(records, { recursive: true, mode: 0o700 });
  mkdirSync(locks, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    chmodSync(records, 0o700);
    chmodSync(locks, 0o700);
  }
  return { records, locks };
}

function recordKey(threadId: string, agentId: string): string {
  return createHash('sha256').update(`${threadId}\0${agentId}`).digest('hex');
}

async function pruneExpiredRecords(crewHome: string, now: Date): Promise<void> {
  const roots = ensureRoots(crewHome);
  let names: string[];
  try {
    names = readdirSync(roots.records)
      .filter((name) => /^[0-9a-f]{64}\.json$/.test(name));
  } catch {
    return;
  }

  for (const name of names) {
    const path = join(roots.records, name);
    let expiry: number;
    try {
      expiry = Date.parse(parseRecord(readFileSync(path, 'utf-8')).expiresAt);
    } catch {
      continue;
    }
    if (!Number.isFinite(expiry) || expiry > now.getTime()) continue;
    const key = name.slice(0, -'.json'.length);
    try {
      await withFileLock({
        lockDir: join(roots.locks, key),
        timeoutMs: LOCK_TIMEOUT_MS,
        staleMs: LOCK_STALE_MS,
        timeoutMessage: 'timed out waiting to prune native reviewer wake state.',
      }, async () => {
        if (!existsSync(path)) return;
        const current = parseRecord(readFileSync(path, 'utf-8'));
        if (Date.parse(current.expiresAt) <= now.getTime()) unlinkSync(path);
      });
    } catch {
      // Cleanup is opportunistic. The record remains fail-closed and a later
      // lifecycle operation will retry its expiry check.
    }
  }
}
