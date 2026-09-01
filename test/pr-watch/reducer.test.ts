import { describe, expect, it } from 'vitest';

import { sha256Canonical } from '../../src/pr-watch/canonical.js';
import { parsePrWatchState } from '../../src/pr-watch/codec.js';
import { makePrWatchId } from '../../src/pr-watch/id.js';
import {
  claimPrWatchSurface,
  createInitialPrWatchState,
  deliverPrWatchSurface,
  rearmPrWatch,
  recordEventDispositions,
  recordObservedEvents,
  recoverExpiredPrWatchSurfaceClaim,
  transitionToActionable,
  transitionToBlocked,
  tryExpirePrWatch,
} from '../../src/pr-watch/reducer.js';
import type {
  PrWatchBlockerCauseV1,
  PrWatchEventRecordV1,
  PrWatchStartInitializationV1,
  PrWatchStateV1,
} from '../../src/pr-watch/types.js';
import { PR_WATCH_PENDING_CLAIM_GRACE_MS } from '../../src/pr-watch/waiter-health.js';

const T0 = new Date('2026-08-27T12:00:00.000Z');

describe('PR-watch lifecycle reducer', () => {
  it('hands off a stable batch, records dispositions, and rearms idempotently', () => {
    let state: PrWatchStateV1 = initialState();
    state = recordObservedEvents(state, [event('check-1')], T0).state;
    state = transitionToActionable(state, {
      eventIds: ['check-1'],
      inclusiveLedgerSequenceWatermark: 2,
      now: T0,
    }).state;
    expect(state.status).toBe('actionable');
    if (state.status !== 'actionable') throw new Error('expected actionable');
    const batchId = state.batch.actionBatchId;
    state = recordEventDispositions(state, {
      actionBatchId: batchId,
      dispositions: { 'check-1': { disposition: 'acknowledged', note: 'triaged' } },
      now: T0,
    }).state;
    const first = rearmPrWatch(state, {
      reason: 'disposed_batch',
      expectedGeneration: 1,
      receiptKey: 'dispose-check-1',
      actionBatchId: batchId,
      now: T0,
    });
    expect(first.state.status).toBe('active');
    expect(first.state.generation).toBe(2);
    expect(first.receipt.waiter?.generation).toBe(2);
    const retry = rearmPrWatch(first.state, {
      reason: 'disposed_batch',
      expectedGeneration: 2,
      receiptKey: 'dispose-check-1',
      actionBatchId: batchId,
      now: T0,
    });
    expect(retry.idempotent).toBe(true);
    expect(retry.receipt).toEqual(first.receipt);
    expect(retry.state).toEqual(first.state);
  });

  it('expires waiter-less actionable state and restores its exact handoff without a waiter', () => {
    let state: PrWatchStateV1 = initialState({ expiresAt: T0 });
    state = recordObservedEvents(state, [event('review-1')], new Date(T0.getTime() - 1000)).state;
    state = transitionToActionable(state, {
      eventIds: ['review-1'],
      inclusiveLedgerSequenceWatermark: 2,
      now: new Date(T0.getTime() - 500),
    }).state;
    if (state.status !== 'actionable') throw new Error('expected actionable');
    const batchId = state.batch.actionBatchId;
    state = tryExpirePrWatch(state, { now: T0, expiryTransactionId: 'expiry-actionable' }).state;
    expect(state.status).toBe('expired');
    if (state.status !== 'expired') throw new Error('expected expired');
    expect(state.suspendedState.status).toBe('actionable');
    expect(state.expirySurfaces).toHaveLength(1);
    const restored = rearmPrWatch(state, {
      reason: 'expired',
      expectedGeneration: 1,
      receiptKey: 'extend-actionable',
      confirmed: true,
      extendDays: 1,
      now: T0,
    });
    expect(restored.state.status).toBe('actionable');
    expect(restored.state.generation).toBe(2);
    expect(restored.receipt.waiter).toBeUndefined();
    if (restored.state.status !== 'actionable') throw new Error('expected actionable');
    expect(restored.state.batch.actionBatchId).toBe(batchId);
    expect(restored.state.batch.generation).toBe(2);
  });

  it('replaces a never-claimed pending waiter only after its claim grace expires', () => {
    const state: PrWatchStateV1 = initialState();
    expect(state.status).toBe('active');
    if (state.status !== 'active') throw new Error('expected active');
    expect(state.waiter.state).toBe('pending');
    const priorWatcherActionId = state.waiter.watcherActionId;
    const rearmArgs = {
      reason: 'stale_waiter',
      expectedGeneration: 1,
      priorWatcherActionId,
      receiptKey: 'replace-never-claimed',
    } as const;

    // Inside the grace window a fresh pending waiter is not replaceable —
    // a healthy launch may simply not have claimed yet.
    expect(() => rearmPrWatch(state, { ...rearmArgs, now: T0 }))
      .toThrow('pr_watch.waiter_not_replaceable');

    // Past the grace window the waiter never claimed (skipped launch or a
    // sandbox-blocked exit-4 probe) and must be replaceable.
    const afterGrace = new Date(T0.getTime() + PR_WATCH_PENDING_CLAIM_GRACE_MS);
    const replaced = rearmPrWatch(state, { ...rearmArgs, now: afterGrace });
    expect(replaced.state.status).toBe('active');
    if (replaced.state.status !== 'active') throw new Error('expected active');
    expect(replaced.state.waiter.watcherActionId).not.toBe(priorWatcherActionId);
    expect(replaced.state.waiter.state).toBe('pending');
  });

  it('preserves and rebinds budget handoff proof through expiry, then consumes it once', () => {
    let state: PrWatchStateV1 = initialState({ expiresAt: T0, maxWakes: 1 });
    state = recordObservedEvents(state, [event('check-budget')], new Date(T0.getTime() - 1000)).state;
    state = transitionToActionable(state, {
      eventIds: ['check-budget'],
      inclusiveLedgerSequenceWatermark: 2,
      now: new Date(T0.getTime() - 900),
    }).state;
    state = recordEventDispositions(state, {
      actionBatchId: state.status === 'actionable' ? state.batch.actionBatchId : '',
      dispositions: { 'check-budget': { disposition: 'deferred' } },
      now: new Date(T0.getTime() - 800),
    }).state;
    state = rearmPrWatch(state, {
      reason: 'disposed_batch',
      expectedGeneration: 1,
      receiptKey: 'dispose-budget-1',
      actionBatchId: state.status === 'actionable' ? state.batch.actionBatchId : '',
      now: new Date(T0.getTime() - 700),
    }).state;
    state = recordObservedEvents(state, [event('check-budget-2')], new Date(T0.getTime() - 600)).state;
    state = transitionToActionable(state, {
      eventIds: ['check-budget-2'],
      inclusiveLedgerSequenceWatermark: 6,
      now: new Date(T0.getTime() - 500),
    }).state;
    expect(state.status).toBe('blocked');
    if (state.status !== 'blocked') throw new Error('expected budget blocked');
    const causeId = state.blocker.causeId;
    const batchId = state.blocker.budgetHandoffProof?.batch.actionBatchId;
    const proofBeforeExpiry = state.blocker.budgetHandoffProof;
    const priorBatchBeforeExpiry = state.priorActionableBatch;
    expect(state.blocker.budgetHandoffProof?.expectedGeneration).toBe(2);
    state = tryExpirePrWatch(state, { now: T0, expiryTransactionId: 'expiry-budget' }).state;
    const restored = rearmPrWatch(state, {
      reason: 'expired',
      expectedGeneration: 2,
      receiptKey: 'extend-budget',
      confirmed: true,
      extendDays: 1,
      now: T0,
    });
    expect(restored.state.status).toBe('blocked');
    expect(restored.state.generation).toBe(3);
    expect(restored.receipt.reboundBudgetHandoffProof?.expectedGeneration).toBe(3);
    if (restored.state.status !== 'blocked') throw new Error('expected restored blocker');
    expect(restored.state.blocker.budgetHandoffProof?.batch).toEqual(proofBeforeExpiry?.batch);
    expect(restored.state.blocker.budgetHandoffProof?.counter).toEqual(proofBeforeExpiry?.counter);
    expect(restored.state.blocker.budgetHandoffProof?.dispositions)
      .toEqual(proofBeforeExpiry?.dispositions);
    expect(restored.state.priorActionableBatch).toEqual(priorBatchBeforeExpiry);
    const terminalOnly = rearmPrWatch(restored.state, {
      reason: 'budget_exhausted',
      expectedGeneration: 3,
      receiptKey: 'consume-budget',
      actionBatchId: batchId,
      blockerCauseId: causeId,
      blockerVersion: 1,
      now: T0,
    });
    expect(terminalOnly.state.status).toBe('active');
    expect(terminalOnly.state.observationMode).toBe('terminal_only');
    expect(terminalOnly.state.generation).toBe(4);
    expect(terminalOnly.receipt.waiter?.observationMode).toBe('terminal_only');
  });

  it('blocks on action-round exhaustion and revokes the exact grant when consumed', () => {
    let state: PrWatchStateV1 = initialState();
    const grantId = 'grant-action-round';
    state = parsePrWatchState({
      ...state,
      actionRoundBudget: {
        ...state.actionRoundBudget,
        spent: state.actionRoundBudget.limit,
      },
      actionGrant: {
        grantId,
        grantedAt: T0.toISOString(),
        effectKinds: ['post_pr_comment'],
        maxActionRounds: state.actionRoundBudget.limit,
        maxActionableWakes: state.actionableWakeBudget.limit,
        expectedPolicyHash: state.effectiveConfig.policyHash,
        expectedTopologyHash: sha256Canonical({ topology: 'fixture' }),
        observedHeads: state.expectedHeads,
      },
      worktreeLease: {
        leaseId: 'lease-action-round',
        worktreePath: '/tmp/crew-pr-watch-action-round',
        remote: 'origin',
        branch: 'feature',
        expectedHeadSha: state.expectedHeads['42'],
        gitCommonDir: '/tmp/crew-pr-watch-action-round.git',
        createdAt: T0.toISOString(),
        finalizedAt: T0.toISOString(),
      },
    });
    state = recordObservedEvents(state, [event('check-action-round')], T0).state;
    const blocked = transitionToActionable(state, {
      eventIds: ['check-action-round'],
      inclusiveLedgerSequenceWatermark: 2,
      now: T0,
    }).state;
    expect(blocked.status).toBe('blocked');
    if (blocked.status !== 'blocked') throw new Error('expected action-round blocker');
    expect(blocked.blocker.budgetHandoffProof).toMatchObject({
      exhaustedKind: 'action_round',
      actionGrantId: grantId,
    });

    const consumed = rearmPrWatch(blocked, {
      reason: 'budget_exhausted',
      expectedGeneration: blocked.generation,
      receiptKey: 'consume-action-round-budget',
      actionBatchId: blocked.blocker.budgetHandoffProof?.batch.actionBatchId,
      blockerCauseId: blocked.blocker.causeId,
      blockerVersion: blocked.blocker.version,
      now: T0,
    });
    expect(consumed.state.status).toBe('active');
    expect(consumed.state.observationMode).toBe('terminal_only');
    expect(consumed.state.actionGrant).toMatchObject({
      grantId,
      revokedAt: T0.toISOString(),
      revokedReason: 'pr_watch.budget_exhausted',
    });
    expect(consumed.state.actionRoundBudget.spent).toBe(consumed.state.actionRoundBudget.limit);
  });

  it('revokes a wake-bounded grant before handing off the next actionable batch', () => {
    let state = initialState();
    state = parsePrWatchState({
      ...state,
      generation: 2,
      waiter: {
        ...state.waiter,
        generation: 2,
      },
      actionableWakeBudget: {
        ...state.actionableWakeBudget,
        spent: 1,
      },
      actionGrant: {
        grantId: 'grant-one-wake',
        grantedAt: T0.toISOString(),
        effectKinds: ['post_pr_comment'],
        maxActionRounds: 2,
        maxActionableWakes: 1,
        expectedPolicyHash: state.effectiveConfig.policyHash,
        expectedTopologyHash: sha256Canonical({ topology: 'fixture' }),
        observedHeads: state.expectedHeads,
      },
      worktreeLease: {
        leaseId: 'lease-one-wake',
        worktreePath: '/tmp/crew-pr-watch-one-wake',
        remote: 'origin',
        branch: 'feature',
        expectedHeadSha: state.expectedHeads['42'],
        gitCommonDir: '/tmp/crew-pr-watch-one-wake.git',
        createdAt: T0.toISOString(),
        finalizedAt: T0.toISOString(),
      },
    });
    state = recordObservedEvents(state, [event('next-wake')], T0).state;
    const handedOff = transitionToActionable(state, {
      eventIds: ['next-wake'],
      inclusiveLedgerSequenceWatermark: 3,
      now: T0,
    }).state;
    expect(handedOff.status).toBe('actionable');
    expect(handedOff.actionableWakeBudget.spent).toBe(2);
    expect(handedOff.actionGrant).toMatchObject({
      grantId: 'grant-one-wake',
      revokedAt: T0.toISOString(),
      revokedReason: 'pr_watch.actionable_wake_grant_exhausted',
    });
  });

  it('rejects a budget handoff proof whose counter differs from live state', () => {
    let state = initialState({ maxWakes: 1 });
    state = parsePrWatchState({
      ...state,
      actionableWakeBudget: { ...state.actionableWakeBudget, spent: 1 },
    });
    state = recordObservedEvents(state, [event('counter-mismatch')], T0).state;
    const blocked = transitionToActionable(state, {
      eventIds: ['counter-mismatch'],
      inclusiveLedgerSequenceWatermark: 2,
      now: T0,
    }).state;
    if (blocked.status !== 'blocked') throw new Error('expected budget blocker');
    expect(() => parsePrWatchState({
      ...blocked,
      blocker: {
        ...blocked.blocker,
        budgetHandoffProof: {
          ...blocked.blocker.budgetHandoffProof!,
          counter: {
            ...blocked.blocker.budgetHandoffProof!.counter,
            identity: 'forged-counter',
          },
        },
      },
    })).toThrow('budget proof counter must match live state');
  });

  it('requires budget proof only on matching non-retryable budget blockers', () => {
    const state = initialState();
    const invalid = {
      ...state,
      status: 'blocked',
      waiter: undefined,
      blocker: {
        causeId: 'cause',
        version: 1,
        kind: 'provider_auth',
        class: 'revalidate',
        message: 'auth',
        evidence: {},
        allowedConsumingReasons: ['blocked_resolved'],
        budgetHandoffProof: {
          exhaustedKind: 'actionable_wake',
          expectedGeneration: 1,
          batch: {
            actionBatchId: 'batch',
            generation: 1,
            inclusiveLedgerSequenceWatermark: 1,
            eventIds: ['event'],
            handedOffAt: T0.toISOString(),
          },
          dispositions: { event: 'deferred' },
          counter: { identity: 'budget', limit: 1, spent: 1 },
        },
      },
      currentBlockerSurfaceId: 'pws-0123456789abcdef0123456789abcdef',
      blockerSurfaces: [{
        surfaceId: 'pws-0123456789abcdef0123456789abcdef',
        kind: 'blocker',
        generation: 1,
        createdAt: T0.toISOString(),
        state: 'pending',
        latestClaimAttempt: 0,
        attempts: [],
      }],
    };
    expect(() => parsePrWatchState(invalid)).toThrow('non-budget blocker forbids');
  });

  it('derives blocker identity and increments its version only when facts change', () => {
    const first = transitionToBlocked(initialState(), {
      firstObservedSequence: 7,
      blocker: {
        causeId: 'caller-value-is-not-authoritative',
        version: 99,
        kind: 'provider_auth',
        class: 'revalidate',
        message: 'authenticate gh',
        evidence: { subject: 'github.com', detail: 'missing token' },
        allowedConsumingReasons: ['blocked_resolved'],
      },
      now: T0,
    }).state;
    if (first.status !== 'blocked') throw new Error('expected blocker');
    const same = transitionToBlocked(first, {
      firstObservedSequence: 8,
      blocker: { ...first.blocker, causeId: 'ignored', version: 123 },
      now: T0,
    }).state;
    if (same.status !== 'blocked') throw new Error('expected blocker');
    expect(same.blocker.causeId).toBe(first.blocker.causeId);
    expect(same.blocker.version).toBe(1);
    const changed = transitionToBlocked(same, {
      firstObservedSequence: 9,
      blocker: {
        ...same.blocker,
        causeId: 'ignored-again',
        version: 456,
        evidence: { subject: 'github.com', detail: 'expired token' },
      },
      now: T0,
    }).state;
    if (changed.status !== 'blocked') throw new Error('expected blocker');
    expect(changed.blocker.causeId).toBe(first.blocker.causeId);
    expect(changed.blocker.version).toBe(2);
  });

  it('recovers a live claimed remedy lease and rejects the delayed old audit', () => {
    const blocker: PrWatchBlockerCauseV1 = {
      causeId: 'auth-cause',
      version: 1,
      kind: 'provider_auth',
      class: 'revalidate',
      message: 'authenticate gh',
      evidence: {},
      allowedConsumingReasons: ['blocked_resolved'],
    };
    let state = transitionToBlocked(initialState(), { blocker, now: T0 }).state;
    if (state.status !== 'blocked') throw new Error('expected blocked');
    const surfaceId = state.currentBlockerSurfaceId;
    state = claimPrWatchSurface(state, {
      surfaceId,
      requestId: 'request-1',
      leaseMs: 1000,
      now: T0,
    }).state;
    state = recoverExpiredPrWatchSurfaceClaim(state, {
      surfaceId,
      requestId: 'request-1',
      attempt: 1,
      now: new Date(T0.getTime() + 1001),
    }).state;
    expect(() => deliverPrWatchSurface(state, {
      surfaceId,
      requestId: 'request-1',
      attempt: 1,
      via: 'jit',
      now: new Date(T0.getTime() + 1002),
    })).toThrow('stale_surface_audit');
    state = claimPrWatchSurface(state, {
      surfaceId,
      requestId: 'request-2',
      leaseMs: 1000,
      now: new Date(T0.getTime() + 1003),
    }).state;
    state = deliverPrWatchSurface(state, {
      surfaceId,
      requestId: 'request-2',
      attempt: 2,
      via: 'jit',
      now: new Date(T0.getTime() + 1004),
    }).state;
    expect(state.blockerSurfaces[0].state).toBe('delivered');
    expect(state.blockerSurfaces[0].attempts.map((attempt) => attempt.outcome)).toEqual([
      'lease_expired',
      'delivered',
    ]);
  });
});

function initialState(args: { expiresAt?: Date; maxWakes?: number } = {}): PrWatchStateV1 {
  const initialization: PrWatchStartInitializationV1 = {
    repository: 'example/repo',
    anchorPrNumber: 42,
    repoRoot: '/tmp/example-repo',
    effectiveConfig: {
      maxPrs: 50,
      maxActionableWakes: args.maxWakes ?? 20,
      maxActionRounds: 5,
      maxWatchAgeDays: args.expiresAt ? 14 : -1,
      policyHash: sha256Canonical({ mode: 'github_rules' }),
    },
    expectedHeads: { '42': 'abc123' },
    ...(args.expiresAt ? { watchExpiresAt: args.expiresAt.toISOString() } : {}),
  };
  return createInitialPrWatchState({
    watchId: makePrWatchId(),
    initialization,
    now: new Date(T0.getTime() - 10_000),
  });
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
    firstObservedAt: T0.toISOString(),
    lastObservedAt: T0.toISOString(),
    fixAttemptCount: 0,
  };
}
