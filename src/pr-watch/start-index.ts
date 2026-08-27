import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';

import { atomicWrite } from '../utils/atomic-write.js';
import { withFileLock } from '../utils/file-lock.js';
import { sha256Canonical } from './canonical.js';
import { parsePrWatchStartIndexRecord } from './codec.js';
import { makePrWatchId } from './id.js';
import {
  PR_WATCH_SCHEMA_VERSION,
  type PrWatchStartIndexRecordV1,
  type PrWatchStartInitializationV1,
} from './types.js';

const LOCK_TIMEOUT_MS = 20_000;
const LOCK_STALE_MS = 120_000;

export class PrWatchStartIndex {
  readonly root: string;
  readonly lockRoot: string;

  constructor(readonly crewHome: string) {
    this.root = join(crewHome, 'pr-watches', 'start-keys');
    this.lockRoot = join(crewHome, 'pr-watch-locks', 'start-keys');
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    mkdirSync(this.lockRoot, { recursive: true, mode: 0o700 });
  }

  read(startKeyDigest: string): PrWatchStartIndexRecordV1 | undefined {
    validateDigest(startKeyDigest);
    const path = this.path(startKeyDigest);
    if (!existsSync(path)) return undefined;
    try {
      return parsePrWatchStartIndexRecord(JSON.parse(readFileSync(path, 'utf-8')) as unknown);
    } catch (error) {
      throw new Error(
        `pr_watch.corrupt_start_index: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  listStartKeyDigests(): readonly string[] {
    return readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^[0-9a-f]{64}\.json$/.test(entry.name))
      .map((entry) => entry.name.slice(0, -'.json'.length))
      .sort();
  }

  async prepare(args: {
    readonly startKeyDigest: string;
    readonly startIntentDigest: string;
    readonly initialization: PrWatchStartInitializationV1;
    readonly now?: Date;
  }): Promise<PrWatchStartIndexRecordV1> {
    return this.withLock(args.startKeyDigest, async () => this.prepareLocked(args));
  }

  prepareLocked(args: {
    readonly startKeyDigest: string;
    readonly startIntentDigest: string;
    readonly initialization: PrWatchStartInitializationV1;
    readonly now?: Date;
  }): PrWatchStartIndexRecordV1 {
    validateDigest(args.startIntentDigest);
    const current = this.read(args.startKeyDigest);
    const initializationDigest = sha256Canonical(args.initialization);
    if (current?.startIntentDigest !== undefined && current.startIntentDigest !== args.startIntentDigest) {
      throw new Error('pr_watch.idempotency_conflict');
    }
    if (current?.status === 'prepared') {
      if (current.initializationDigest !== initializationDigest) {
        throw new Error('pr_watch.start_key_conflict');
      }
      return current;
    }
    if (current?.status === 'committed') return current;
    if (current?.status === 'reclaimed') rmSync(this.path(args.startKeyDigest), { force: true });
    const prepared: PrWatchStartIndexRecordV1 = {
        schemaVersion: PR_WATCH_SCHEMA_VERSION,
        status: 'prepared',
        startKeyDigest: args.startKeyDigest,
        startIntentDigest: args.startIntentDigest,
        watchId: makePrWatchId(),
        preparedAt: (args.now ?? new Date()).toISOString(),
        repoRoot: args.initialization.repoRoot,
        initializationDigest,
        initialization: args.initialization,
    };
    this.write(prepared);
    return prepared;
  }

  async markCommitted(
    startKeyDigest: string,
    watchId: string,
    now = new Date(),
  ): Promise<PrWatchStartIndexRecordV1> {
    return this.withLock(startKeyDigest, async () => this.markCommittedLocked(
      startKeyDigest,
      watchId,
      now,
    ));
  }

  markCommittedLocked(
    startKeyDigest: string,
    watchId: string,
    now = new Date(),
  ): PrWatchStartIndexRecordV1 {
      const current = this.read(startKeyDigest);
      if (!current || current.watchId !== watchId) {
        throw new Error('pr_watch.start_index_missing_preparation');
      }
      if (current.status === 'committed') return current;
      if (current.status !== 'prepared') throw new Error('pr_watch.start_index_reclaimed');
      const committed: PrWatchStartIndexRecordV1 = {
        schemaVersion: PR_WATCH_SCHEMA_VERSION,
        status: 'committed',
        startKeyDigest,
        startIntentDigest: current.startIntentDigest,
        watchId,
        preparedAt: current.preparedAt,
        committedAt: now.toISOString(),
        repoRoot: current.repoRoot,
        initializationDigest: current.initializationDigest,
      };
    this.write(committed);
    return committed;
  }

  async markReclaimed(
    startKeyDigest: string,
    watchId: string,
    now = new Date(),
  ): Promise<PrWatchStartIndexRecordV1> {
    return this.withLock(startKeyDigest, async () => this.markReclaimedLocked(
      startKeyDigest,
      watchId,
      now,
    ));
  }

  markReclaimedLocked(
    startKeyDigest: string,
    watchId: string,
    now = new Date(),
  ): PrWatchStartIndexRecordV1 {
    const current = this.read(startKeyDigest);
    if (current?.status === 'reclaimed' && current.watchId === watchId) return current;
    if (!current || current.status !== 'committed' || current.watchId !== watchId) {
      throw new Error('pr_watch.start_index_not_committed');
    }
    const reclaimed: PrWatchStartIndexRecordV1 = {
      schemaVersion: PR_WATCH_SCHEMA_VERSION,
      status: 'reclaimed',
      startKeyDigest,
      startIntentDigest: current.startIntentDigest,
      watchId,
      reclaimedAt: now.toISOString(),
      priorCommittedAt: current.committedAt,
      repoRoot: current.repoRoot,
      initializationDigest: current.initializationDigest,
    };
    this.write(reclaimed);
    return reclaimed;
  }

  async removeReclaimed(startKeyDigest: string, watchId: string): Promise<void> {
    await this.withLock(startKeyDigest, async () => {
      const current = this.read(startKeyDigest);
      if (!current || current.status !== 'reclaimed' || current.watchId !== watchId) {
        throw new Error('pr_watch.start_index_reclaim_mismatch');
      }
      rmSync(this.path(startKeyDigest), { force: true });
    });
  }

  removeReclaimedLocked(startKeyDigest: string, watchId: string): void {
    const current = this.read(startKeyDigest);
    if (!current || current.status !== 'reclaimed' || current.watchId !== watchId) {
      throw new Error('pr_watch.start_index_reclaim_mismatch');
    }
    rmSync(this.path(startKeyDigest), { force: true });
  }

  quarantine(startKeyDigest: string): string {
    validateDigest(startKeyDigest);
    const source = this.path(startKeyDigest);
    const target = `${source}.corrupt-${randomUUID()}`;
    renameSync(source, target);
    return target;
  }

  async withLock<T>(startKeyDigest: string, operation: () => Promise<T>): Promise<T> {
    validateDigest(startKeyDigest);
    return withFileLock({
      lockDir: join(this.lockRoot, `${startKeyDigest}.lock`),
      timeoutMs: LOCK_TIMEOUT_MS,
      staleMs: LOCK_STALE_MS,
      timeoutMessage: `pr_watch.start_key_lock_timeout: ${startKeyDigest}`,
    }, operation);
  }

  private path(startKeyDigest: string): string {
    return join(this.root, `${startKeyDigest}.json`);
  }

  private write(record: PrWatchStartIndexRecordV1): void {
    atomicWrite(this.path(record.startKeyDigest), `${JSON.stringify(record, null, 2)}\n`);
  }
}

function validateDigest(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('pr_watch.invalid_start_key_digest');
}
