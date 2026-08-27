import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { atomicWrite } from '../utils/atomic-write.js';
import { withFileLock } from '../utils/file-lock.js';
import { canonicalJson, sha256Canonical } from './canonical.js';
import {
  parsePrWatchLedgerRecord,
  parsePrWatchState,
  parsePrWatchStateCache,
} from './codec.js';
import { parsePrWatchId } from './id.js';
import {
  PR_WATCH_SCHEMA_VERSION,
  type PrWatchLedgerRecordV1,
  type PrWatchStateCacheV1,
  type PrWatchStateCheckpointV1,
  type PrWatchStateV1,
} from './types.js';

const LOCK_TIMEOUT_MS = 20_000;
const LOCK_STALE_MS = 120_000;
const EMPTY_LEDGER_DIGEST = '';

export interface AuthoritativePrWatchRead {
  readonly state: PrWatchStateV1;
  readonly checkpoint: PrWatchStateCheckpointV1;
  readonly cacheFresh: boolean;
  readonly tailRecords: readonly PrWatchLedgerRecordV1[];
  readonly tailCheckpoints: readonly PrWatchStateCheckpointV1[];
}

export interface PrWatchBoundedRead {
  readonly status: 'ok';
  readonly read: AuthoritativePrWatchRead;
}

export interface PrWatchCacheLagRead {
  readonly status: 'cache_lag';
  readonly reason: 'cache_missing_or_invalid' | 'tail_exceeds_limit';
  readonly tailBytes: number;
  readonly maxTailBytes: number;
  readonly cachedState?: PrWatchStateV1;
}

export type PrWatchBoundedReadResult = PrWatchBoundedRead | PrWatchCacheLagRead;

export interface PrWatchCachedIdentity {
  readonly watchId: string;
  readonly repository: string;
  readonly anchorPrNumber: number;
  readonly repoRoot: string;
  readonly generation: number;
  readonly updatedAt: string;
}

type PrWatchMutation = (
  state: PrWatchStateV1,
  current: AuthoritativePrWatchRead,
) => {
  readonly state: PrWatchStateV1;
  readonly transactionId: string;
};

export type PrWatchCommitListener = (state: PrWatchStateV1) => void;

export class PrWatchCorruptStateError extends Error {
  readonly watchId: string;
  readonly sequence?: number;

  constructor(watchId: string, message: string, sequence?: number) {
    super(`pr_watch.corrupt_state: ${message}`);
    this.name = 'PrWatchCorruptStateError';
    this.watchId = watchId;
    this.sequence = sequence;
  }
}

/**
 * Durable PR-watch state. The append-only ledger is authoritative; state.json
 * is a monotonic cache whose checkpoint can always be replayed read-only.
 */
export class PrWatchStore {
  readonly root: string;
  readonly lockRoot: string;
  private readonly commitListeners = new Set<PrWatchCommitListener>();

  constructor(readonly crewHome: string) {
    this.root = join(crewHome, 'pr-watches');
    this.lockRoot = join(crewHome, 'pr-watch-locks');
    mkdirPrivate(this.root);
    mkdirPrivate(this.lockRoot);
  }

  watchDir(watchId: string): string {
    return join(this.root, parsePrWatchId(watchId));
  }

  exists(watchId: string): boolean {
    return existsSync(this.watchDir(watchId));
  }

  listWatchIds(): readonly string[] {
    return readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((entry) => {
        try {
          parsePrWatchId(entry);
          return true;
        } catch {
          return false;
        }
      })
      .sort();
  }

  onCommit(listener: PrWatchCommitListener): () => void {
    this.commitListeners.add(listener);
    return () => this.commitListeners.delete(listener);
  }

  async create(state: PrWatchStateV1, transactionId: string): Promise<AuthoritativePrWatchRead> {
    parsePrWatchState(state);
    const watchDir = this.watchDir(state.watchId);
    try {
      mkdirSync(watchDir, { mode: 0o700 });
    } catch (error) {
      if (isNodeError(error) && error.code === 'EEXIST') {
        throw new Error(`pr_watch.already_exists: ${state.watchId}`);
      }
      throw error;
    }
    if (process.platform !== 'win32') chmodSync(watchDir, 0o700);
    try {
      const appended = appendLedgerRecord(
        join(watchDir, 'events.jsonl'),
        state,
        transactionId,
        1,
        EMPTY_LEDGER_DIGEST,
      );
      writeReplayableTransactionMarker(watchDir, appended.record, appended.checkpoint);
      writeStateCache(join(watchDir, 'state.json'), { state, checkpoint: appended.checkpoint });
      this.notifyCommit(state);
      return {
        state,
        checkpoint: appended.checkpoint,
        cacheFresh: true,
        tailRecords: [],
        tailCheckpoints: [],
      };
    } catch (error) {
      rmSync(watchDir, { recursive: true, force: true });
      throw error;
    }
  }

  read(watchId: string): AuthoritativePrWatchRead {
    parsePrWatchId(watchId);
    return readAuthoritativePrWatch(this.watchDir(watchId), watchId);
  }

  readBoundedTail(watchId: string, maxTailBytes: number): PrWatchBoundedReadResult {
    parsePrWatchId(watchId);
    return readBoundedPrWatchTail(this.watchDir(watchId), watchId, maxTailBytes);
  }

  /**
   * Diagnostic-only immutable identity from state.json. This never represents
   * authoritative lifecycle state and must not be used for transitions.
   */
  readCachedIdentity(watchId: string): PrWatchCachedIdentity | undefined {
    parsePrWatchId(watchId);
    try {
      const cache = parsePrWatchStateCache(
        JSON.parse(readFileSync(join(this.watchDir(watchId), 'state.json'), 'utf-8')) as unknown,
      );
      return {
        watchId: cache.state.watchId,
        repository: cache.state.repository,
        anchorPrNumber: cache.state.anchorPrNumber,
        repoRoot: cache.state.repoRoot,
        generation: cache.state.generation,
        updatedAt: cache.state.updatedAt,
      };
    } catch {
      return undefined;
    }
  }

  readHistory(watchId: string): readonly PrWatchLedgerRecordV1[] {
    const id = parsePrWatchId(watchId);
    return readEntireLedger(join(this.watchDir(id), 'events.jsonl'), id).records;
  }

  findStateByTransaction(watchId: string, transactionId: string): PrWatchStateV1 | undefined {
    const id = parsePrWatchId(watchId);
    const record = readTransactionMarker(this.watchDir(id), id, transactionId);
    return record?.recordKind === 'state' ? record.state : undefined;
  }

  async mutate(
    watchId: string,
    operation: PrWatchMutation,
  ): Promise<AuthoritativePrWatchRead> {
    return this.withWatchLock(watchId, async () => this.mutateLocked(watchId, operation));
  }

  mutateLocked(
    watchId: string,
    operation: PrWatchMutation,
  ): AuthoritativePrWatchRead {
    const current = this.read(watchId);
    return this.commitMutationLocked(watchId, current, operation);
  }

  async mutateBoundedTail(
    watchId: string,
    maxTailBytes: number,
    operation: PrWatchMutation,
  ): Promise<PrWatchBoundedReadResult> {
    return this.withWatchLock(watchId, async () => {
      const bounded = this.readBoundedTail(watchId, maxTailBytes);
      if (bounded.status === 'cache_lag') return bounded;
      return {
        status: 'ok',
        read: this.commitMutationLocked(watchId, bounded.read, operation),
      };
    });
  }

  private commitMutationLocked(
    watchId: string,
    current: AuthoritativePrWatchRead,
    operation: PrWatchMutation,
  ): AuthoritativePrWatchRead {
    const result = operation(current.state, current);
    const next = parsePrWatchState(result.state);
    if (next.watchId !== watchId) throw new Error('pr_watch.watch_id_changed');
    if (sha256Canonical(next) === sha256Canonical(current.state)) {
      this.notifyCommit(current.state);
      return current;
    }
    const tailIndex = current.tailRecords.findIndex(
      (record) => record.transactionId === result.transactionId,
    );
    if (tailIndex >= 0) {
      writeReplayableTransactionMarker(
        this.watchDir(watchId),
        current.tailRecords[tailIndex],
        current.tailCheckpoints[tailIndex],
      );
      this.notifyCommit(current.state);
      return current;
    }
    if (readTransactionMarker(this.watchDir(watchId), watchId, result.transactionId)) {
      this.notifyCommit(current.state);
      return current;
    }
    const appended = appendLedgerRecord(
      join(this.watchDir(watchId), 'events.jsonl'),
      next,
      result.transactionId,
      current.checkpoint.ledgerSequence + 1,
      current.checkpoint.ledgerDigest,
      current.state,
    );
    writeReplayableTransactionMarker(this.watchDir(watchId), appended.record, appended.checkpoint);
    writeStateCache(join(this.watchDir(watchId), 'state.json'), {
      state: next,
      checkpoint: appended.checkpoint,
    });
    this.notifyCommit(next);
    return {
      state: next,
      checkpoint: appended.checkpoint,
      cacheFresh: true,
      tailRecords: [],
      tailCheckpoints: [],
    };
  }

  async repairCache(watchId: string): Promise<AuthoritativePrWatchRead> {
    return this.withWatchLock(watchId, async () => {
      const authoritative = this.read(watchId);
      if (!authoritative.cacheFresh) {
        authoritative.tailRecords.forEach((record, index) => {
          writeReplayableTransactionMarker(
            this.watchDir(watchId),
            record,
            authoritative.tailCheckpoints[index],
          );
        });
        writeStateCache(join(this.watchDir(watchId), 'state.json'), authoritative);
      }
      return {
        ...authoritative,
        cacheFresh: true,
        tailRecords: [],
        tailCheckpoints: [],
      };
    });
  }

  async removeClosedWatch(
    watchId: string,
    predicate: (state: PrWatchStateV1) => boolean,
  ): Promise<boolean> {
    return this.withWatchLock(watchId, async () => this.removeClosedWatchLocked(
      watchId,
      predicate,
    ));
  }

  removeClosedWatchLocked(
    watchId: string,
    predicate: (state: PrWatchStateV1) => boolean,
  ): boolean {
    const current = this.read(watchId);
    if (!predicate(current.state)) return false;
    if (!['terminal', 'cancelled'].includes(current.state.status)) {
      throw new Error('pr_watch.gc_refuses_nonterminal');
    }
    rmSync(this.watchDir(watchId), { recursive: true, force: true });
    return true;
  }

  async withWatchLock<T>(watchId: string, operation: () => Promise<T>): Promise<T> {
    parsePrWatchId(watchId);
    return withFileLock({
      lockDir: join(this.lockRoot, `${watchId}.lock`),
      timeoutMs: LOCK_TIMEOUT_MS,
      staleMs: LOCK_STALE_MS,
      timeoutMessage: `pr_watch.lock_timeout: ${watchId}`,
    }, operation);
  }

  private notifyCommit(state: PrWatchStateV1): void {
    for (const listener of this.commitListeners) {
      try {
        listener(state);
      } catch {
        // The commit is already durable. Startup sweeps recover controller
        // registration, so listener failure must not invite a duplicate write.
      }
    }
  }
}

export function readAuthoritativePrWatch(
  watchDir: string,
  watchId: string,
): AuthoritativePrWatchRead {
  const ledgerPath = join(watchDir, 'events.jsonl');
  let ledgerSize: number;
  try {
    ledgerSize = statSync(ledgerPath).size;
  } catch (error) {
    throw new PrWatchCorruptStateError(
      watchId,
      `cannot read ledger: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (ledgerSize === 0 || readLedgerRange(ledgerPath, ledgerSize - 1, ledgerSize)[0] !== 0x0a) {
    throw new PrWatchCorruptStateError(watchId, 'ledger is empty or has a truncated final record');
  }

  let cache: PrWatchStateCacheV1 | undefined;
  try {
    cache = parsePrWatchStateCache(
      JSON.parse(readFileSync(join(watchDir, 'state.json'), 'utf-8')) as unknown,
    );
  } catch {
    cache = undefined;
  }

  if (cache !== undefined && cacheCheckpointMatchesLedger(
    ledgerPath,
    ledgerSize,
    watchId,
    cache,
  )) {
    const tail = parseLedgerBytes(
      readLedgerRange(ledgerPath, cache.checkpoint.ledgerByteOffset, ledgerSize),
      watchId,
      {
        absoluteOffset: cache.checkpoint.ledgerByteOffset,
        sequence: cache.checkpoint.ledgerSequence + 1,
        previousDigest: cache.checkpoint.ledgerDigest,
        state: cache.state,
      },
    );
    const lastState = tail.states.at(-1);
    const checkpoint = tail.checkpoints.at(-1) ?? cache.checkpoint;
    return {
      state: lastState ?? cache.state,
      checkpoint,
      cacheFresh: tail.records.length === 0,
      tailRecords: tail.records,
      tailCheckpoints: tail.checkpoints,
    };
  }

  const full = readEntireLedger(ledgerPath, watchId);
  const last = full.states.at(-1);
  const checkpoint = full.checkpoints.at(-1);
  if (!last || !checkpoint) {
    throw new PrWatchCorruptStateError(watchId, 'ledger contains no records');
  }
  return {
    state: last,
    checkpoint,
    cacheFresh: false,
    tailRecords: full.records,
    tailCheckpoints: full.checkpoints,
  };
}

export function readBoundedPrWatchTail(
  watchDir: string,
  watchId: string,
  maxTailBytes: number,
): PrWatchBoundedReadResult {
  if (!Number.isSafeInteger(maxTailBytes) || maxTailBytes < 0) {
    throw new Error('pr_watch.invalid_jit_tail_limit');
  }
  const ledgerPath = join(watchDir, 'events.jsonl');
  let ledgerSize: number;
  try {
    ledgerSize = statSync(ledgerPath).size;
  } catch (error) {
    throw new PrWatchCorruptStateError(
      watchId,
      `cannot read ledger: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (ledgerSize === 0 || readLedgerRange(ledgerPath, ledgerSize - 1, ledgerSize)[0] !== 0x0a) {
    throw new PrWatchCorruptStateError(watchId, 'ledger is empty or has a truncated final record');
  }
  let cache: PrWatchStateCacheV1 | undefined;
  try {
    cache = parsePrWatchStateCache(
      JSON.parse(readFileSync(join(watchDir, 'state.json'), 'utf-8')) as unknown,
    );
  } catch {
    cache = undefined;
  }
  if (cache === undefined || !cacheCheckpointMatchesLedger(ledgerPath, ledgerSize, watchId, cache)) {
    return {
      status: 'cache_lag',
      reason: 'cache_missing_or_invalid',
      tailBytes: ledgerSize,
      maxTailBytes,
      ...(cache !== undefined ? { cachedState: cache.state } : {}),
    };
  }
  const tailBytes = ledgerSize - cache.checkpoint.ledgerByteOffset;
  if (tailBytes > maxTailBytes) {
    return {
      status: 'cache_lag',
      reason: 'tail_exceeds_limit',
      tailBytes,
      maxTailBytes,
      cachedState: cache.state,
    };
  }
  const tail = parseLedgerBytes(
    readLedgerRange(ledgerPath, cache.checkpoint.ledgerByteOffset, ledgerSize),
    watchId,
    {
      absoluteOffset: cache.checkpoint.ledgerByteOffset,
      sequence: cache.checkpoint.ledgerSequence + 1,
      previousDigest: cache.checkpoint.ledgerDigest,
      state: cache.state,
    },
  );
  const lastState = tail.states.at(-1);
  return {
    status: 'ok',
    read: {
      state: lastState ?? cache.state,
      checkpoint: tail.checkpoints.at(-1) ?? cache.checkpoint,
      cacheFresh: tail.records.length === 0,
      tailRecords: tail.records,
      tailCheckpoints: tail.checkpoints,
    },
  };
}

interface ParsedLedgerRecords {
  readonly records: readonly PrWatchLedgerRecordV1[];
  readonly checkpoints: readonly PrWatchStateCheckpointV1[];
  readonly states: readonly PrWatchStateV1[];
}

function readEntireLedger(path: string, watchId: string): ParsedLedgerRecords {
  return parseLedgerBytes(readFileSync(path), watchId, {
    absoluteOffset: 0,
    sequence: 1,
    previousDigest: EMPTY_LEDGER_DIGEST,
  });
}

function parseLedgerBytes(
  bytes: Buffer,
  watchId: string,
  initial: {
    readonly absoluteOffset: number;
    readonly sequence: number;
    readonly previousDigest: string;
    readonly state?: PrWatchStateV1;
  },
): ParsedLedgerRecords {
  if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) {
    throw new PrWatchCorruptStateError(watchId, 'truncated ledger record', initial.sequence);
  }
  const records: PrWatchLedgerRecordV1[] = [];
  const checkpoints: PrWatchStateCheckpointV1[] = [];
  const states: PrWatchStateV1[] = [];
  let offset = 0;
  let sequence = initial.sequence;
  let previousDigest = initial.previousDigest;
  let state = initial.state;
  while (offset < bytes.length) {
    const newline = bytes.indexOf(0x0a, offset);
    if (newline < 0) {
      throw new PrWatchCorruptStateError(watchId, 'truncated ledger record', sequence);
    }
    const record = parseAndValidateLedgerRecord(
      bytes.subarray(offset, newline).toString('utf-8'),
      watchId,
      sequence,
      previousDigest,
    );
    state = applyLedgerRecord(state, record, watchId);
    records.push(record);
    states.push(state);
    checkpoints.push({
      ledgerSequence: record.sequence,
      ledgerRecordStartByteOffset: initial.absoluteOffset + offset,
      ledgerByteOffset: initial.absoluteOffset + newline + 1,
      ledgerDigest: record.digest,
    });
    previousDigest = record.digest;
    sequence += 1;
    offset = newline + 1;
  }
  return { records, checkpoints, states };
}

function parseAndValidateLedgerRecord(
  line: string,
  watchId: string,
  sequence: number,
  expectedPreviousDigest?: string,
): PrWatchLedgerRecordV1 {
  let record: PrWatchLedgerRecordV1;
  try {
    record = parsePrWatchLedgerRecord(JSON.parse(line) as unknown);
  } catch (error) {
    throw new PrWatchCorruptStateError(
      watchId,
      `invalid ledger record: ${error instanceof Error ? error.message : String(error)}`,
      sequence,
    );
  }
  if (
    record.sequence !== sequence
    || (expectedPreviousDigest !== undefined && record.previousDigest !== expectedPreviousDigest)
  ) {
    throw new PrWatchCorruptStateError(watchId, 'ledger sequence or previous digest mismatch', sequence);
  }
  if (record.digest !== digestLedgerRecord(record)) {
    throw new PrWatchCorruptStateError(watchId, 'ledger record digest mismatch', sequence);
  }
  if (
    (record.recordKind === 'state' && record.state.watchId !== watchId)
    || (record.recordKind === 'waiter_heartbeat' && record.heartbeat.watchId !== watchId)
  ) {
    throw new PrWatchCorruptStateError(watchId, 'ledger state belongs to another watch', sequence);
  }
  return record;
}

function applyLedgerRecord(
  prior: PrWatchStateV1 | undefined,
  record: PrWatchLedgerRecordV1,
  watchId: string,
): PrWatchStateV1 {
  let state: PrWatchStateV1;
  if (record.recordKind === 'state') {
    state = record.state;
  } else {
    const heartbeat = record.heartbeat;
    if (
      prior?.status !== 'active'
      || prior.generation !== heartbeat.generation
      || prior.waiter.watcherActionId !== heartbeat.watcherActionId
      || prior.waiter.state !== 'running'
      || prior.waiter.leaseOwnerId !== heartbeat.leaseOwnerId
    ) {
      throw new PrWatchCorruptStateError(
        watchId,
        'waiter heartbeat does not apply to the prior ledger state',
        record.sequence,
      );
    }
    state = parsePrWatchState({
      ...prior,
      waiter: {
        ...prior.waiter,
        leaseHeartbeatAt: heartbeat.leaseHeartbeatAt,
        leaseExpiresAt: heartbeat.leaseExpiresAt,
      },
      updatedAt: heartbeat.updatedAt,
    });
  }
  if (sha256Canonical(state) !== record.stateDigest) {
    throw new PrWatchCorruptStateError(
      watchId,
      'ledger resulting state digest mismatch',
      record.sequence,
    );
  }
  return state;
}

function cacheCheckpointMatchesLedger(
  ledgerPath: string,
  ledgerSize: number,
  watchId: string,
  cache: PrWatchStateCacheV1,
): boolean {
  const checkpoint = cache.checkpoint;
  if (
    checkpoint.ledgerRecordStartByteOffset < 0
    || checkpoint.ledgerRecordStartByteOffset >= checkpoint.ledgerByteOffset
    || checkpoint.ledgerByteOffset > ledgerSize
  ) return false;
  try {
    const bytes = readLedgerRange(
      ledgerPath,
      checkpoint.ledgerRecordStartByteOffset,
      checkpoint.ledgerByteOffset,
    );
    if (
      bytes.length < 2
      || bytes[bytes.length - 1] !== 0x0a
      || bytes.subarray(0, bytes.length - 1).includes(0x0a)
    ) return false;
    const record = parseAndValidateLedgerRecord(
      bytes.subarray(0, bytes.length - 1).toString('utf-8'),
      watchId,
      checkpoint.ledgerSequence,
    );
    return record.digest === checkpoint.ledgerDigest
      && record.stateDigest === sha256Canonical(cache.state);
  } catch {
    return false;
  }
}

function readLedgerRange(path: string, start: number, end: number): Buffer {
  if (start < 0 || end < start) throw new Error('pr_watch.invalid_ledger_range');
  const bytes = Buffer.alloc(end - start);
  if (bytes.length === 0) return bytes;
  const fd = openSync(path, 'r');
  try {
    let read = 0;
    while (read < bytes.length) {
      const count = readSync(fd, bytes, read, bytes.length - read, start + read);
      if (count === 0) throw new Error('pr_watch.short_ledger_read');
      read += count;
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

interface AppendedLedgerRecord {
  readonly record: PrWatchLedgerRecordV1;
  readonly checkpoint: PrWatchStateCheckpointV1;
}

interface PrWatchTransactionMarker {
  readonly schemaVersion: typeof PR_WATCH_SCHEMA_VERSION;
  readonly transactionId: string;
  readonly ledgerSequence: number;
  readonly ledgerRecordStartByteOffset: number;
  readonly ledgerByteOffset: number;
  readonly ledgerDigest: string;
}

function appendLedgerRecord(
  path: string,
  state: PrWatchStateV1,
  transactionId: string,
  sequence: number,
  previousDigest: string,
  priorState?: PrWatchStateV1,
): AppendedLedgerRecord {
  const common = {
    schemaVersion: PR_WATCH_SCHEMA_VERSION,
    sequence,
    transactionId,
    recordedAt: state.updatedAt,
    previousDigest,
    stateDigest: sha256Canonical(state),
  } as const;
  let record: PrWatchLedgerRecordV1;
  if (priorState !== undefined && isWaiterHeartbeatOnly(priorState, state)) {
    if (state.status !== 'active' || state.waiter.state !== 'running') {
      throw new Error('pr_watch.invalid_compact_heartbeat');
    }
    const withoutDigest = {
      ...common,
      recordKind: 'waiter_heartbeat' as const,
      heartbeat: {
        watchId: state.watchId,
        generation: state.generation,
        watcherActionId: state.waiter.watcherActionId,
        leaseOwnerId: state.waiter.leaseOwnerId!,
        leaseHeartbeatAt: state.waiter.leaseHeartbeatAt!,
        leaseExpiresAt: state.waiter.leaseExpiresAt!,
        updatedAt: state.updatedAt,
      },
    };
    record = { ...withoutDigest, digest: sha256Canonical(withoutDigest) };
  } else {
    const withoutDigest = {
      ...common,
      recordKind: 'state' as const,
      state,
    };
    record = { ...withoutDigest, digest: sha256Canonical(withoutDigest) };
  }
  const serialized = `${canonicalJson(record)}\n`;
  mkdirPrivate(dirname(path));
  const ledgerRecordStartByteOffset = existsSync(path) ? statSync(path).size : 0;
  const fd = openSync(path, 'a', 0o600);
  try {
    writeSync(fd, serialized, undefined, 'utf-8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const ledgerByteOffset = statSync(path).size;
  return {
    record,
    checkpoint: {
      ledgerSequence: sequence,
      ledgerRecordStartByteOffset,
      ledgerByteOffset,
      ledgerDigest: record.digest,
    },
  };
}

function isWaiterHeartbeatOnly(prior: PrWatchStateV1, next: PrWatchStateV1): boolean {
  if (
    prior.status !== 'active'
    || next.status !== 'active'
    || prior.waiter.state !== 'running'
    || next.waiter.state !== 'running'
    || prior.waiter.leaseOwnerId === undefined
    || next.waiter.leaseOwnerId !== prior.waiter.leaseOwnerId
    || next.waiter.leaseHeartbeatAt === undefined
    || next.waiter.leaseExpiresAt === undefined
  ) return false;
  const normalizedNext = {
    ...next,
    updatedAt: prior.updatedAt,
    waiter: {
      ...next.waiter,
      leaseHeartbeatAt: prior.waiter.leaseHeartbeatAt,
      leaseExpiresAt: prior.waiter.leaseExpiresAt,
    },
  };
  return sha256Canonical(normalizedNext) === sha256Canonical(prior);
}

function writeTransactionMarker(
  watchDir: string,
  record: PrWatchLedgerRecordV1,
  checkpoint: PrWatchStateCheckpointV1,
): void {
  const marker: PrWatchTransactionMarker = {
    schemaVersion: PR_WATCH_SCHEMA_VERSION,
    transactionId: record.transactionId,
    ledgerSequence: checkpoint.ledgerSequence,
    ledgerRecordStartByteOffset: checkpoint.ledgerRecordStartByteOffset,
    ledgerByteOffset: checkpoint.ledgerByteOffset,
    ledgerDigest: checkpoint.ledgerDigest,
  };
  const path = transactionMarkerPath(watchDir, record.transactionId);
  mkdirPrivate(dirname(path));
  atomicWrite(path, `${JSON.stringify(marker)}\n`);
}

function writeReplayableTransactionMarker(
  watchDir: string,
  record: PrWatchLedgerRecordV1,
  checkpoint: PrWatchStateCheckpointV1,
): void {
  if (record.recordKind === 'waiter_heartbeat') return;
  writeTransactionMarker(watchDir, record, checkpoint);
}

function readTransactionMarker(
  watchDir: string,
  watchId: string,
  transactionId: string,
): PrWatchLedgerRecordV1 | undefined {
  const path = transactionMarkerPath(watchDir, transactionId);
  if (!existsSync(path)) return undefined;
  try {
    const marker = JSON.parse(readFileSync(path, 'utf-8')) as Partial<PrWatchTransactionMarker>;
    if (
      marker.schemaVersion !== PR_WATCH_SCHEMA_VERSION
      || marker.transactionId !== transactionId
      || !Number.isSafeInteger(marker.ledgerSequence)
      || !Number.isSafeInteger(marker.ledgerRecordStartByteOffset)
      || !Number.isSafeInteger(marker.ledgerByteOffset)
      || typeof marker.ledgerDigest !== 'string'
      || marker.ledgerRecordStartByteOffset! < 0
      || marker.ledgerByteOffset! <= marker.ledgerRecordStartByteOffset!
    ) {
      throw new Error('invalid transaction marker');
    }
    const bytes = readLedgerRange(
      join(watchDir, 'events.jsonl'),
      marker.ledgerRecordStartByteOffset!,
      marker.ledgerByteOffset!,
    );
    if (
      bytes.length < 2
      || bytes[bytes.length - 1] !== 0x0a
      || bytes.subarray(0, bytes.length - 1).includes(0x0a)
    ) {
      throw new Error('transaction marker does not name one complete record');
    }
    const record = parseAndValidateLedgerRecord(
      bytes.subarray(0, bytes.length - 1).toString('utf-8'),
      watchId,
      marker.ledgerSequence!,
    );
    if (
      record.transactionId !== transactionId
      || record.digest !== marker.ledgerDigest
    ) {
      throw new Error('transaction marker record mismatch');
    }
    if (
      record.recordKind === 'state'
      && sha256Canonical(record.state) !== record.stateDigest
    ) {
      throw new Error('transaction marker state digest mismatch');
    }
    return record;
  } catch (error) {
    throw new PrWatchCorruptStateError(
      watchId,
      `invalid transaction marker: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function transactionMarkerPath(watchDir: string, transactionId: string): string {
  return join(
    watchDir,
    '.transactions',
    `${sha256Canonical({ transactionId })}.json`,
  );
}

function digestLedgerRecord(record: PrWatchLedgerRecordV1): string {
  const { digest: _digest, ...withoutDigest } = record;
  return sha256Canonical(withoutDigest);
}

function writeStateCache(
  path: string,
  args: { readonly state: PrWatchStateV1; readonly checkpoint: PrWatchStateCheckpointV1 },
): void {
  const cache: PrWatchStateCacheV1 = {
    schemaVersion: PR_WATCH_SCHEMA_VERSION,
    checkpoint: args.checkpoint,
    state: args.state,
  };
  atomicWrite(path, `${JSON.stringify(cache, null, 2)}\n`);
}

function mkdirPrivate(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(path, 0o700);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}
