import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { sha256Canonical } from '../../src/pr-watch/canonical.js';
import { gcPrWatches, PR_WATCH_DAY_MS } from '../../src/pr-watch/gc.js';
import { createInitialPrWatchState } from '../../src/pr-watch/reducer.js';
import { PrWatchStartIndex } from '../../src/pr-watch/start-index.js';
import { PrWatchStore } from '../../src/pr-watch/store.js';
import type { PrWatchStartInitializationV1 } from '../../src/pr-watch/types.js';

const NOW = Date.parse('2026-08-27T12:00:00.000Z');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('PR-watch retention GC', () => {
  it('completes an aged prepared reservation through cancelled state before reclaiming it', async () => {
    const fixture = makeFixture();
    const prepared = await fixture.index.prepare({
      startKeyDigest: fixture.startKeyDigest,
      startIntentDigest: fixture.startIntentDigest,
      initialization: fixture.initialization,
      now: new Date(NOW - 2 * PR_WATCH_DAY_MS),
    });

    const result = await gcPrWatches({
      crewHome: fixture.crewHome,
      repoRoot: fixture.repoRoot,
      ttlMs: PR_WATCH_DAY_MS,
      now: NOW,
    });

    expect(result).toEqual({
      watchesReclaimed: 1,
      outcomes: [{
        watchId: prepared.watchId,
        status: 'cancelled',
        ageDays: 2,
        reclaimed: true,
      }],
    });
    expect(fixture.store.exists(prepared.watchId)).toBe(false);
    expect(fixture.index.read(fixture.startKeyDigest)).toBeUndefined();
  });

  it('keeps dry-run byte-pure while reporting an aged prepared reclaim', async () => {
    const fixture = makeFixture();
    const prepared = await fixture.index.prepare({
      startKeyDigest: fixture.startKeyDigest,
      startIntentDigest: fixture.startIntentDigest,
      initialization: fixture.initialization,
      now: new Date(NOW - 2 * PR_WATCH_DAY_MS),
    });
    const before = fixture.index.read(fixture.startKeyDigest);

    const result = await gcPrWatches({
      crewHome: fixture.crewHome,
      repoRoot: fixture.repoRoot,
      ttlMs: PR_WATCH_DAY_MS,
      dryRun: true,
      now: NOW,
    });

    expect(result.outcomes).toEqual([{
      watchId: prepared.watchId,
      status: 'cancelled',
      ageDays: 2,
      reclaimed: true,
      reason: 'aged_prepared_start',
    }]);
    expect(fixture.index.read(fixture.startKeyDigest)).toEqual(before);
    expect(fixture.store.exists(prepared.watchId)).toBe(false);
  });

  it('repairs preparation after watch creation without deleting a live watch', async () => {
    const fixture = makeFixture();
    const prepared = await fixture.index.prepare({
      startKeyDigest: fixture.startKeyDigest,
      startIntentDigest: fixture.startIntentDigest,
      initialization: fixture.initialization,
      now: new Date(NOW - 2 * PR_WATCH_DAY_MS),
    });
    const state = createInitialPrWatchState({
      watchId: prepared.watchId,
      initialization: fixture.initialization,
      reverseStartKeyDigest: fixture.startKeyDigest,
      now: new Date(NOW - 2 * PR_WATCH_DAY_MS),
    });
    await fixture.store.create(state, 'crash-after-watch-create');

    const result = await gcPrWatches({
      crewHome: fixture.crewHome,
      repoRoot: fixture.repoRoot,
      ttlMs: PR_WATCH_DAY_MS,
      now: NOW,
    });

    expect(result.outcomes).toEqual([{
      watchId: prepared.watchId,
      status: 'active',
      ageDays: 0,
      reclaimed: false,
      reason: 'nonterminal',
    }]);
    expect(fixture.store.exists(prepared.watchId)).toBe(true);
    expect(fixture.index.read(fixture.startKeyDigest)).toMatchObject({
      status: 'committed',
      watchId: prepared.watchId,
    });
  });
});

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'crew-pr-watch-gc-'));
  roots.push(root);
  const crewHome = join(root, 'crew-home');
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const repoRoot = realpathSync(repo);
  const initialization: PrWatchStartInitializationV1 = {
    repository: 'example/repo',
    anchorPrNumber: 42,
    repoRoot,
    effectiveConfig: {
      maxPrs: 50,
      maxActionableWakes: 20,
      maxActionRounds: 5,
      maxWatchAgeDays: -1,
      policyHash: sha256Canonical({ mode: 'github_rules' }),
    },
    expectedHeads: { '42': 'abc123' },
  };
  return {
    crewHome,
    repoRoot,
    initialization,
    store: new PrWatchStore(crewHome),
    index: new PrWatchStartIndex(crewHome),
    startKeyDigest: sha256Canonical({ repoRoot, key: 'aged' }),
    startIntentDigest: sha256Canonical({ repoRoot, intent: 'aged' }),
  };
}
