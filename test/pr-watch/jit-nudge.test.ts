import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  auditPrWatchJitNudge,
  claimPrWatchJitNudge,
} from '../../src/orchestrator/detection/jit-nudges.js';
import { sha256Canonical } from '../../src/pr-watch/canonical.js';
import { makePrWatchId } from '../../src/pr-watch/id.js';
import {
  createInitialPrWatchState,
  transitionToBlocked,
  tryExpirePrWatch,
} from '../../src/pr-watch/reducer.js';
import { PrWatchStore } from '../../src/pr-watch/store.js';
import type { PrWatchStateV1 } from '../../src/pr-watch/types.js';

const T0 = new Date('2026-08-27T12:00:00.000Z');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('PR-watch JIT remedy claims', () => {
  it('claims, decorates, and audits a blocker surface only once', async () => {
    const fixture = await makeFixture('blocked');
    const claim = await claimPrWatchJitNudge({
      crewHome: fixture.crewHome,
      repoRoot: fixture.repoRoot,
      requestId: 'jit-request-1',
      now: T0,
    });
    expect(claim?.warning).toContain('pr_watch_blocked_remedy');
    expect(await claimPrWatchJitNudge({
      crewHome: fixture.crewHome,
      repoRoot: fixture.repoRoot,
      requestId: 'jit-request-race',
      now: T0,
    })).toBeUndefined();

    await auditPrWatchJitNudge({ crewHome: fixture.crewHome, claim: claim!, now: T0 });
    const state = fixture.store.read(fixture.watchId).state;
    expect(state.blockerSurfaces[0]).toMatchObject({
      state: 'delivered',
      deliveredVia: 'jit',
      latestClaimAttempt: 1,
    });
    expect(await claimPrWatchJitNudge({
      crewHome: fixture.crewHome,
      repoRoot: fixture.repoRoot,
      now: T0,
    })).toBeUndefined();
  });

  it('recovers an abandoned claim in-process and rejects the late audit', async () => {
    const fixture = await makeFixture('expired');
    const first = await claimPrWatchJitNudge({
      crewHome: fixture.crewHome,
      repoRoot: fixture.repoRoot,
      requestId: 'jit-request-old',
      leaseMs: 1_000,
      now: T0,
    });
    expect(first?.warning).toContain('pr_watch_expiry_remedy');

    const recovered = await claimPrWatchJitNudge({
      crewHome: fixture.crewHome,
      repoRoot: fixture.repoRoot,
      requestId: 'jit-request-new',
      leaseMs: 1_000,
      now: new Date(T0.getTime() + 1_001),
    });
    expect(recovered).toMatchObject({
      watchId: fixture.watchId,
      surfaceId: first?.surfaceId,
      attempt: 2,
    });
    await expect(auditPrWatchJitNudge({
      crewHome: fixture.crewHome,
      claim: first!,
      now: new Date(T0.getTime() + 1_002),
    })).rejects.toThrow('pr_watch.stale_surface_audit');
    await auditPrWatchJitNudge({
      crewHome: fixture.crewHome,
      claim: recovered!,
      now: new Date(T0.getTime() + 1_003),
    });
    const state = fixture.store.read(fixture.watchId).state;
    expect(state.expirySurfaces[0].attempts.map((attempt) => attempt.outcome)).toEqual([
      'lease_expired',
      'delivered',
    ]);
  });

  it('does not claim cross-repository or over-budget warnings', async () => {
    const fixture = await makeFixture('blocked');
    expect(await claimPrWatchJitNudge({
      crewHome: fixture.crewHome,
      repoRoot: join(fixture.repoRoot, 'other'),
      now: T0,
    })).toBeUndefined();
    expect(await claimPrWatchJitNudge({
      crewHome: fixture.crewHome,
      repoRoot: fixture.repoRoot,
      maxWarningBytes: 1,
      now: T0,
    })).toBeUndefined();
    expect(fixture.store.read(fixture.watchId).state.blockerSurfaces[0].state).toBe('pending');
  });

  it('refuses a lifecycle claim when the authoritative tail exceeds the JIT cap', async () => {
    const fixture = await makeFixture('blocked');
    const cachePath = join(fixture.store.watchDir(fixture.watchId), 'state.json');
    const staleCache = readFileSync(cachePath);
    await fixture.store.mutate(fixture.watchId, (state) => ({
      state: { ...state, updatedAt: new Date(T0.getTime() + 1).toISOString() },
      transactionId: 'jit-tail-fixture',
    }));
    writeFileSync(cachePath, staleCache);

    expect(await claimPrWatchJitNudge({
      crewHome: fixture.crewHome,
      repoRoot: fixture.repoRoot,
      maxTailBytes: 1,
      now: T0,
    })).toBeUndefined();
    expect(fixture.store.read(fixture.watchId).state.blockerSurfaces[0].state).toBe('pending');
  });
});

async function makeFixture(status: 'blocked' | 'expired') {
  const root = mkdtempSync(join(tmpdir(), 'crew-pr-watch-jit-'));
  roots.push(root);
  const crewHome = join(root, 'crew-home');
  const repoRoot = join(root, 'repo');
  const store = new PrWatchStore(crewHome);
  const watchId = makePrWatchId();
  let state: PrWatchStateV1 = createInitialPrWatchState({
    watchId,
    initialization: {
      repository: 'example/repo',
      anchorPrNumber: 42,
      repoRoot,
      effectiveConfig: {
        maxPrs: 50,
        maxActionableWakes: 20,
        maxActionRounds: 5,
        maxWatchAgeDays: status === 'expired' ? 14 : -1,
        policyHash: sha256Canonical({ mode: 'github_rules' }),
      },
      expectedHeads: { '42': 'abc123' },
      ...(status === 'expired' ? { watchExpiresAt: T0.toISOString() } : {}),
    },
    now: new Date(T0.getTime() - 10_000),
  });
  if (status === 'blocked') {
    state = transitionToBlocked(state, {
      blocker: {
        causeId: 'cause-auth',
        version: 1,
        kind: 'provider_auth',
        class: 'revalidate',
        message: 'authenticate gh',
        evidence: {},
        allowedConsumingReasons: ['blocked_resolved'],
      },
      now: T0,
    }).state;
  } else {
    state = tryExpirePrWatch(state, { now: T0, expiryTransactionId: 'expiry-jit' }).state;
  }
  await store.create(state, 'create-jit-fixture');
  return { crewHome, repoRoot, store, watchId };
}
