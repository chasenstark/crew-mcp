import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { sha256Canonical } from '../../src/pr-watch/canonical.js';
import { makePrWatchId, makePrWatchTransactionId } from '../../src/pr-watch/id.js';
import {
  claimPrWatchWaiter,
  createInitialPrWatchState,
  heartbeatPrWatchWaiter,
  recordObservedEvents,
} from '../../src/pr-watch/reducer.js';
import { PrWatchStartIndex } from '../../src/pr-watch/start-index.js';
import { PrWatchCorruptStateError, PrWatchStore } from '../../src/pr-watch/store.js';
import type { PrWatchEventRecordV1, PrWatchStartInitializationV1 } from '../../src/pr-watch/types.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('PrWatchStore', () => {
  it('replays a committed ledger tail without mutating a stale cache', async () => {
    const root = tempRoot();
    const store = new PrWatchStore(root);
    const watchId = makePrWatchId();
    const initial = createInitialPrWatchState({
      watchId,
      initialization: initialization(),
      now: new Date('2026-08-27T12:00:00.000Z'),
    });
    await store.create(initial, makePrWatchTransactionId());
    const cachePath = join(store.watchDir(watchId), 'state.json');
    const staleCache = readFileSync(cachePath);
    await store.mutate(watchId, (state) => recordObservedEvents(
      state,
      [event('new-event')],
      new Date('2026-08-27T12:01:00.000Z'),
    ));
    writeFileSync(cachePath, staleCache);
    const beforeRead = readFileSync(cachePath);
    const authoritative = store.read(watchId);
    expect(authoritative.cacheFresh).toBe(false);
    expect(authoritative.tailRecords).toHaveLength(1);
    expect(authoritative.state.events['new-event']).toBeDefined();
    expect(readFileSync(cachePath)).toEqual(beforeRead);
    const repaired = await store.repairCache(watchId);
    expect(repaired.cacheFresh).toBe(true);
    expect(store.read(watchId).cacheFresh).toBe(true);
  });

  it('bounds JIT tail replay and reports cache lag without falling back to full history', async () => {
    const root = tempRoot();
    const store = new PrWatchStore(root);
    const watchId = makePrWatchId();
    await store.create(createInitialPrWatchState({
      watchId,
      initialization: initialization(),
    }), makePrWatchTransactionId());
    const cachePath = join(store.watchDir(watchId), 'state.json');
    const staleCache = readFileSync(cachePath);
    await store.mutate(watchId, (state) => recordObservedEvents(state, [event('bounded-tail')]));
    writeFileSync(cachePath, staleCache);
    const before = readFileSync(cachePath);

    const bounded = store.readBoundedTail(watchId, 1);
    expect(bounded).toMatchObject({
      status: 'cache_lag',
      reason: 'tail_exceeds_limit',
      maxTailBytes: 1,
    });
    expect(readFileSync(cachePath)).toEqual(before);
    expect(store.read(watchId).state.events['bounded-tail']).toBeDefined();
  });

  it('fails closed on a truncated ledger instead of trusting state.json', async () => {
    const root = tempRoot();
    const store = new PrWatchStore(root);
    const watchId = makePrWatchId();
    await store.create(createInitialPrWatchState({
      watchId,
      initialization: initialization(),
    }), makePrWatchTransactionId());
    const ledgerPath = join(store.watchDir(watchId), 'events.jsonl');
    const bytes = readFileSync(ledgerPath);
    writeFileSync(ledgerPath, bytes.subarray(0, bytes.length - 1));
    expect(() => store.read(watchId)).toThrow(PrWatchCorruptStateError);
    expect(() => store.read(watchId)).toThrow('truncated');
  });

  it('refuses to garbage-collect every nonterminal lifecycle', async () => {
    const root = tempRoot();
    const store = new PrWatchStore(root);
    const watchId = makePrWatchId();
    await store.create(createInitialPrWatchState({ watchId, initialization: initialization() }), makePrWatchTransactionId());
    await expect(store.removeClosedWatch(watchId, () => true)).rejects.toThrow('gc_refuses_nonterminal');
    expect(store.exists(watchId)).toBe(true);
  });

  it('deduplicates a committed transaction through its durable marker without replaying history', async () => {
    const root = tempRoot();
    const store = new PrWatchStore(root);
    const watchId = makePrWatchId();
    await store.create(createInitialPrWatchState({
      watchId,
      initialization: initialization(),
    }), 'create-marker-fixture');
    const transactionId = 'stable-observation-transaction';
    const committed = await store.mutate(watchId, (state) => ({
      ...recordObservedEvents(state, [event('first-event')]),
      transactionId,
    }));
    const duplicate = await store.mutate(watchId, (state) => ({
      ...recordObservedEvents(state, [event('must-not-commit')]),
      transactionId,
    }));

    expect(duplicate.checkpoint.ledgerSequence).toBe(committed.checkpoint.ledgerSequence);
    expect(duplicate.state.events['first-event']).toBeDefined();
    expect(duplicate.state.events['must-not-commit']).toBeUndefined();
    expect(store.findStateByTransaction(watchId, transactionId)?.events['first-event'])
      .toBeDefined();
  });

  it('stores repeated waiter heartbeats as compact digest-chained records', async () => {
    const root = tempRoot();
    const store = new PrWatchStore(root);
    const watchId = makePrWatchId();
    const t0 = new Date('2026-08-27T12:00:00.000Z');
    await store.create(createInitialPrWatchState({
      watchId,
      initialization: initialization(),
      now: t0,
    }), 'create-heartbeat-fixture');
    await store.mutate(watchId, (state) => claimPrWatchWaiter(state, {
      watcherActionId: state.status === 'active' ? state.waiter.watcherActionId : '',
      generation: state.generation,
      leaseOwnerId: 'waiter-owner',
      leaseMs: 180_000,
      now: t0,
    }));
    for (let index = 1; index <= 20; index += 1) {
      const now = new Date(t0.getTime() + index * 1000);
      await store.mutate(watchId, (state) => heartbeatPrWatchWaiter(state, {
        watcherActionId: state.status === 'active' ? state.waiter.watcherActionId : '',
        generation: state.generation,
        leaseOwnerId: 'waiter-owner',
        leaseMs: 180_000,
        now,
      }));
    }

    const history = store.readHistory(watchId);
    expect(history.slice(-20).every((record) => record.recordKind === 'waiter_heartbeat'))
      .toBe(true);
    expect(readFileSync(join(store.watchDir(watchId), 'events.jsonl')).byteLength)
      .toBeLessThan(50_000);
    expect(readdirSync(join(store.watchDir(watchId), '.transactions'))).toHaveLength(2);
    const state = store.read(watchId).state;
    expect(state.status === 'active' ? state.waiter.leaseHeartbeatAt : undefined)
      .toBe(new Date(t0.getTime() + 20_000).toISOString());
  });

  it('rejects a heartbeat at the lease deadline instead of resurrecting a stale waiter', async () => {
    const root = tempRoot();
    const store = new PrWatchStore(root);
    const watchId = makePrWatchId();
    const t0 = new Date('2026-08-27T12:00:00.000Z');
    await store.create(createInitialPrWatchState({
      watchId,
      initialization: initialization(),
      now: t0,
    }), 'create-expired-heartbeat-fixture');
    await store.mutate(watchId, (state) => claimPrWatchWaiter(state, {
      watcherActionId: state.status === 'active' ? state.waiter.watcherActionId : '',
      generation: state.generation,
      leaseOwnerId: 'expired-waiter-owner',
      leaseMs: 60_000,
      now: t0,
    }));

    await expect(store.mutate(watchId, (state) => heartbeatPrWatchWaiter(state, {
      watcherActionId: state.status === 'active' ? state.waiter.watcherActionId : '',
      generation: state.generation,
      leaseOwnerId: 'expired-waiter-owner',
      leaseMs: 60_000,
      now: new Date(t0.getTime() + 60_000),
    }))).rejects.toThrow('pr_watch.waiter_lease_lost');
    expect(store.read(watchId).state).toMatchObject({
      status: 'active',
      waiter: {
        state: 'running',
        leaseExpiresAt: new Date(t0.getTime() + 60_000).toISOString(),
      },
    });
  });
});

describe('PrWatchStartIndex', () => {
  it('recovers prepared and retained committed requests, then allocates fresh only after reclaim proof', async () => {
    const root = tempRoot();
    const index = new PrWatchStartIndex(root);
    const startKeyDigest = sha256Canonical({ repo: '/tmp/example', key: 'stable-request' });
    const startIntentDigest = sha256Canonical({ intent: 'stable-request' });
    const prepared = await index.prepare({ startKeyDigest, startIntentDigest, initialization: initialization() });
    const preparedRetry = await index.prepare({ startKeyDigest, startIntentDigest, initialization: initialization() });
    expect(preparedRetry).toEqual(prepared);
    const committed = await index.markCommitted(startKeyDigest, prepared.watchId);
    expect((await index.prepare({ startKeyDigest, startIntentDigest, initialization: initialization() }))).toEqual(committed);
    const reclaimed = await index.markReclaimed(startKeyDigest, prepared.watchId);
    expect(reclaimed.status).toBe('reclaimed');
    await index.removeReclaimed(startKeyDigest, prepared.watchId);
    const replacement = await index.prepare({ startKeyDigest, startIntentDigest, initialization: initialization() });
    expect(replacement.status).toBe('prepared');
    expect(replacement.watchId).not.toBe(prepared.watchId);
  });

  it('fails closed when a prepared retry changes initialization', async () => {
    const root = tempRoot();
    const index = new PrWatchStartIndex(root);
    const startKeyDigest = sha256Canonical({ key: 'conflict' });
    const startIntentDigest = sha256Canonical({ intent: 'conflict' });
    await index.prepare({ startKeyDigest, startIntentDigest, initialization: initialization() });
    await expect(index.prepare({
      startKeyDigest,
      startIntentDigest,
      initialization: { ...initialization(), anchorPrNumber: 99 },
    })).rejects.toThrow('start_key_conflict');
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'crew-pr-watch-test-'));
  roots.push(root);
  return root;
}

function initialization(): PrWatchStartInitializationV1 {
  return {
    repository: 'example/repo',
    anchorPrNumber: 42,
    repoRoot: '/tmp/example',
    effectiveConfig: {
      maxPrs: 50,
      maxActionableWakes: 20,
      maxActionRounds: 5,
      maxWatchAgeDays: -1,
      policyHash: sha256Canonical({ mode: 'github_rules' }),
    },
    expectedHeads: { '42': 'abc123' },
  };
}

function event(id: string): PrWatchEventRecordV1 {
  return {
    id,
    identity: {
      prNumber: 42,
      headSha: 'abc123',
      kind: 'check_failure',
      providerSourceId: id,
      attempt: 1,
    },
    firstObservedAt: '2026-08-27T12:01:00.000Z',
    lastObservedAt: '2026-08-27T12:01:00.000Z',
    fixAttemptCount: 0,
  };
}
