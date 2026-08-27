import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalJson, sha256Canonical } from './canonical.js';
import { parsePrWatchId } from './id.js';
import { PrWatchStore } from './store.js';
import { withFileLock } from '../utils/file-lock.js';
import type { PrWatchEffectKind } from './types.js';

export type PrWatchEffectPhase =
  | 'prepared'
  | 'observed_absent'
  | 'applied'
  | 'verified'
  | 'ambiguous'
  | 'settled';

export interface PrWatchEffectRecordV1 {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly effectId: string;
  readonly watchId: string;
  readonly generation: number;
  readonly kind: PrWatchEffectKind;
  readonly target: Readonly<Record<string, string | number>>;
  readonly intentDigest: string;
  readonly marker: string;
  readonly phase: PrWatchEffectPhase;
  readonly recordedAt: string;
  readonly evidence?: Readonly<Record<string, unknown>>;
  readonly previousDigest: string;
  readonly digest: string;
}

export class PrWatchEffectJournal {
  constructor(readonly store: PrWatchStore) {}

  makeEffectId(args: {
    readonly watchId: string;
    readonly generation: number;
    readonly eventId: string;
    readonly kind: PrWatchEffectKind;
    readonly target: Readonly<Record<string, string | number>>;
  }): string {
    return sha256Canonical({
      watchId: parsePrWatchId(args.watchId),
      generation: args.generation,
      eventId: args.eventId,
      kind: args.kind,
      target: args.target,
    });
  }

  async withEffectLock<T>(
    watchId: string,
    effectId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    parsePrWatchId(watchId);
    if (!/^[0-9a-f]{64}$/.test(effectId)) throw new Error('pr_watch.invalid_effect_id');
    return withFileLock({
      lockDir: join(this.store.lockRoot, `${watchId}.effect-${effectId}.lock`),
      timeoutMs: 60_000,
      staleMs: 5 * 60_000,
      timeoutMessage: `pr_watch.effect_lock_timeout: ${effectId}`,
    }, operation);
  }

  read(watchId: string): readonly PrWatchEffectRecordV1[] {
    const id = parsePrWatchId(watchId);
    const path = join(this.store.watchDir(id), 'effects.jsonl');
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, 'utf-8');
    if (raw.length === 0) return [];
    if (!raw.endsWith('\n')) throw new Error('pr_watch.corrupt_effect_journal_tail');
    let prior = '';
    return raw.trimEnd().split('\n').map((line, index) => {
      const parsed = JSON.parse(line) as PrWatchEffectRecordV1;
      validateEffectRecord(parsed, index + 1, prior);
      prior = parsed.digest;
      return parsed;
    });
  }

  async append(args: {
    readonly watchId: string;
    readonly effectId: string;
    readonly generation: number;
    readonly kind: PrWatchEffectKind;
    readonly target: Readonly<Record<string, string | number>>;
    readonly intentDigest: string;
    readonly phase: PrWatchEffectPhase;
    readonly marker: string;
    readonly evidence?: Readonly<Record<string, unknown>>;
    readonly now?: Date;
  }): Promise<PrWatchEffectRecordV1> {
    return this.store.withWatchLock(args.watchId, async () => {
      const records = this.read(args.watchId);
      const existing = records.find((record) => (
        record.effectId === args.effectId && record.phase === args.phase
      ));
      if (existing) {
        if (
          existing.intentDigest !== args.intentDigest
          || existing.generation !== args.generation
          || existing.kind !== args.kind
          || existing.marker !== args.marker
          || sha256Canonical(existing.target) !== sha256Canonical(args.target)
        ) {
          throw new Error('pr_watch.effect_id_conflict');
        }
        return existing;
      }
      const prior = records.at(-1);
      const withoutDigest = {
        schemaVersion: 1 as const,
        sequence: (prior?.sequence ?? 0) + 1,
        effectId: args.effectId,
        watchId: parsePrWatchId(args.watchId),
        generation: args.generation,
        kind: args.kind,
        target: args.target,
        intentDigest: args.intentDigest,
        marker: args.marker,
        phase: args.phase,
        recordedAt: (args.now ?? new Date()).toISOString(),
        ...(args.evidence !== undefined ? { evidence: args.evidence } : {}),
        previousDigest: prior?.digest ?? '',
      };
      const record: PrWatchEffectRecordV1 = {
        ...withoutDigest,
        digest: sha256Canonical(withoutDigest),
      };
      const path = join(this.store.watchDir(args.watchId), 'effects.jsonl');
      const fd = openSync(path, 'a', 0o600);
      try {
        writeSync(fd, `${canonicalJson(record)}\n`, undefined, 'utf-8');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return record;
    });
  }

  latestPhase(watchId: string, effectId: string): PrWatchEffectRecordV1 | undefined {
    return this.read(watchId).filter((record) => record.effectId === effectId).at(-1);
  }
}

function validateEffectRecord(record: PrWatchEffectRecordV1, sequence: number, prior: string): void {
  if (
    record.schemaVersion !== 1
    || record.sequence !== sequence
    || record.previousDigest !== prior
    || !/^[0-9a-f]{64}$/.test(record.effectId)
    || !/^[0-9a-f]{64}$/.test(record.intentDigest)
    || record.marker !== `<!-- crew-pr-watch-effect:${record.effectId} -->`
  ) {
    throw new Error('pr_watch.corrupt_effect_journal_record');
  }
  parsePrWatchId(record.watchId);
  const { digest, ...withoutDigest } = record;
  if (digest !== sha256Canonical(withoutDigest)) {
    throw new Error('pr_watch.corrupt_effect_journal_digest');
  }
}
