import { randomUUID } from 'node:crypto';

import { sha256Canonical } from './canonical.js';
import { makePrWatchSurfaceId, makePrWatchTransactionId } from './id.js';
import { parsePrWatchState } from './codec.js';
import {
  PR_WATCH_SCHEMA_VERSION,
  type PrWatchActionBatchV1,
  type PrWatchActionGrantV1,
  type PrWatchActiveStateV1,
  type PrWatchBlockedStateV1,
  type PrWatchBlockerCauseV1,
  type PrWatchEventDisposition,
  type PrWatchEventRecordV1,
  type PrWatchEffectKind,
  type PrWatchExpiredStateV1,
  type PrWatchObservationMode,
  type PrWatchPreparedWorktreeLeaseV1,
  type PrWatchRearmReason,
  type PrWatchRearmReceiptV1,
  type PrWatchRemedySurfaceV1,
  type PrWatchStartInitializationV1,
  type PrWatchStateV1,
  type PrWatchWaiterActionV1,
  type PrWatchWorktreeLeaseV1,
  type SuspendedPrWatchStateV1,
} from './types.js';

export interface PrWatchReducerResult {
  readonly state: PrWatchStateV1;
  readonly transactionId: string;
}

export interface PrWatchRearmResult extends PrWatchReducerResult {
  readonly receipt: PrWatchRearmReceiptV1;
  readonly idempotent: boolean;
}

export function preparePrWatchWorktreeLease(
  state: PrWatchStateV1,
  lease: PrWatchPreparedWorktreeLeaseV1,
  now: Date = new Date(),
): PrWatchReducerResult {
  if (state.worktreeLease !== undefined) throw new Error('pr_watch.worktree_lease_already_finalized');
  if (state.preparedWorktreeLease !== undefined) {
    if (sha256Canonical(state.preparedWorktreeLease) !== sha256Canonical(lease)) {
      throw new Error('pr_watch.prepared_worktree_lease_conflict');
    }
    return { state, transactionId: lease.leaseId };
  }
  return {
    state: parsePrWatchState({
      ...state,
      preparedWorktreeLease: lease,
      updatedAt: now.toISOString(),
    }),
    transactionId: lease.leaseId,
  };
}

export function authorizePrWatchActions(
  state: PrWatchStateV1,
  args: {
    readonly expectedGeneration: number;
    readonly effectKinds: readonly PrWatchEffectKind[];
    readonly maxActionRounds: number;
    readonly maxActionableWakes: number;
    readonly expectedPolicyHash: string;
    readonly expectedTopologyHash: string;
    readonly observedHeads: Readonly<Record<string, string>>;
    readonly worktreeLease: PrWatchWorktreeLeaseV1;
    readonly expiresAt?: string;
    readonly now?: Date;
    readonly grantId?: string;
  },
): PrWatchReducerResult & { readonly grant: PrWatchActionGrantV1 } {
  if (state.generation !== args.expectedGeneration) throw new Error('pr_watch.stale_generation');
  if (state.status !== 'active' && state.status !== 'actionable') {
    throw new Error('pr_watch.authorization_invalid_status');
  }
  if (state.effectiveConfig.policyHash !== args.expectedPolicyHash) {
    throw new Error('pr_watch.authorization_policy_changed');
  }
  if (
    args.effectKinds.length === 0
    || new Set(args.effectKinds).size !== args.effectKinds.length
  ) {
    throw new Error('pr_watch.invalid_authorized_effect_kinds');
  }
  if (
    !Number.isSafeInteger(args.maxActionRounds)
    || args.maxActionRounds < 1
    || args.maxActionRounds > state.effectiveConfig.maxActionRounds
    || args.maxActionRounds <= state.actionRoundBudget.spent
  ) {
    throw new Error('pr_watch.invalid_action_round_budget');
  }
  if (
    !Number.isSafeInteger(args.maxActionableWakes)
    || args.maxActionableWakes < 1
    || args.maxActionableWakes > state.effectiveConfig.maxActionableWakes
    || args.maxActionableWakes < state.actionableWakeBudget.spent
  ) {
    throw new Error('pr_watch.invalid_actionable_wake_budget');
  }
  if (sha256Canonical(state.expectedHeads) !== sha256Canonical(args.observedHeads)) {
    throw new Error('pr_watch.authorization_heads_changed');
  }
  const nowDate = args.now ?? new Date();
  requireBeforeDeadline(state, nowDate);
  if (args.expiresAt !== undefined) {
    const expiresAt = Date.parse(args.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= nowDate.getTime()) {
      throw new Error('pr_watch.invalid_authorization_expiry');
    }
    if (state.watchExpiresAt !== undefined && expiresAt > Date.parse(state.watchExpiresAt)) {
      throw new Error('pr_watch.authorization_exceeds_watch_deadline');
    }
  }
  const now = nowDate.toISOString();
  const grant: PrWatchActionGrantV1 = {
    grantId: args.grantId ?? randomUUID(),
    grantedAt: now,
    effectKinds: [...args.effectKinds].sort(),
    maxActionRounds: args.maxActionRounds,
    maxActionableWakes: args.maxActionableWakes,
    expectedPolicyHash: args.expectedPolicyHash,
    expectedTopologyHash: args.expectedTopologyHash,
    observedHeads: { ...args.observedHeads },
    ...(args.expiresAt !== undefined ? { expiresAt: args.expiresAt } : {}),
  };
  if (state.preparedWorktreeLease !== undefined && (
    state.preparedWorktreeLease.leaseId !== args.worktreeLease.leaseId
    || state.preparedWorktreeLease.worktreePath !== args.worktreeLease.worktreePath
    || state.preparedWorktreeLease.branch !== args.worktreeLease.branch
    || state.preparedWorktreeLease.expectedHeadSha !== args.worktreeLease.expectedHeadSha
    || state.preparedWorktreeLease.gitCommonDir !== args.worktreeLease.gitCommonDir
  )) {
    throw new Error('pr_watch.finalized_worktree_lease_mismatch');
  }
  const { preparedWorktreeLease: _preparedWorktreeLease, ...withoutPreparedLease } = state;
  const result = transition({
    ...withoutPreparedLease,
    actionGrant: grant,
    worktreeLease: args.worktreeLease,
    updatedAt: now,
  });
  return { ...result, grant };
}

export function revokePrWatchActions(
  state: PrWatchStateV1,
  args: { readonly reason: string; readonly now?: Date },
): PrWatchReducerResult & { readonly grant?: PrWatchActionGrantV1 } {
  if (!state.actionGrant || state.actionGrant.revokedAt !== undefined) {
    return { state, transactionId: makePrWatchTransactionId(), grant: state.actionGrant };
  }
  const now = (args.now ?? new Date()).toISOString();
  const grant: PrWatchActionGrantV1 = {
    ...state.actionGrant,
    revokedAt: now,
    revokedReason: args.reason,
  };
  const result = transition({ ...state, actionGrant: grant, updatedAt: now });
  return { ...result, grant };
}

export function createInitialPrWatchState(args: {
  readonly watchId: string;
  readonly initialization: PrWatchStartInitializationV1;
  readonly reverseStartKeyDigest?: string;
  readonly now?: Date;
}): PrWatchActiveStateV1 {
  const now = (args.now ?? new Date()).toISOString();
  const generation = 1;
  const config = args.initialization.effectiveConfig;
  return parsePrWatchState({
    schemaVersion: PR_WATCH_SCHEMA_VERSION,
    watchId: args.watchId,
    repoRoot: args.initialization.repoRoot,
    repository: args.initialization.repository,
    anchorPrNumber: args.initialization.anchorPrNumber,
    createdAt: now,
    updatedAt: now,
    generation,
    effectiveConfig: config,
    ...(args.initialization.watchExpiresAt !== undefined
      ? { watchExpiresAt: args.initialization.watchExpiresAt }
      : {}),
    ...(args.reverseStartKeyDigest !== undefined
      ? { reverseStartKeyDigest: args.reverseStartKeyDigest }
      : {}),
    events: {},
    expectedHeads: args.initialization.expectedHeads,
    ...(args.initialization.headUpdateObservedAt !== undefined
      ? { headUpdateObservedAt: args.initialization.headUpdateObservedAt }
      : {}),
    ...(args.initialization.providerCapability !== undefined
      ? { providerCapability: args.initialization.providerCapability }
      : {}),
    ...(args.initialization.policyEvidence !== undefined
      ? { policyEvidence: args.initialization.policyEvidence }
      : {}),
    roundCount: 0,
    actionableWakeBudget: {
      identity: randomUUID(),
      limit: config.maxActionableWakes,
      spent: 0,
    },
    actionRoundBudget: {
      identity: randomUUID(),
      limit: config.maxActionRounds,
      spent: 0,
    },
    blockerSurfaces: [],
    expirySurfaces: [],
    receipts: {},
    status: 'active',
    observationMode: 'full',
    waiter: makeWaiter(generation, 'full', now),
  }) as PrWatchActiveStateV1;
}

export function recordObservedEvents(
  state: PrWatchStateV1,
  events: readonly PrWatchEventRecordV1[],
  now = new Date(),
): PrWatchReducerResult {
  assertMutable(state);
  const updatedEvents = { ...state.events };
  for (const event of events) {
    const existing = updatedEvents[event.id];
    if (existing) {
      if (
        event.versionTimestamp !== undefined
        && event.versionTimestamp !== existing.versionTimestamp
      ) {
        updatedEvents[event.id] = { ...existing, versionTimestamp: event.versionTimestamp };
      }
    } else {
      updatedEvents[event.id] = event;
    }
  }
  return transition({ ...state, events: updatedEvents, updatedAt: now.toISOString() });
}

export function supersedeEventsForNewHead(
  state: PrWatchStateV1,
  args: { readonly prNumber: number; readonly headSha: string; readonly now?: Date },
): PrWatchReducerResult {
  assertMutable(state);
  const now = (args.now ?? new Date()).toISOString();
  const events = Object.fromEntries(Object.entries(state.events).map(([id, event]) => {
    if (
      event.identity.prNumber !== args.prNumber
      || event.identity.headSha === args.headSha
      || event.disposition !== undefined
    ) {
      return [id, event];
    }
    return [id, {
      ...event,
      disposition: 'superseded' as const,
      dispositionAt: now,
      supersededByHead: args.headSha,
    }];
  }));
  return transition({
    ...state,
    expectedHeads: { ...state.expectedHeads, [String(args.prNumber)]: args.headSha },
    events,
    updatedAt: now,
  });
}

export function transitionToActionable(
  state: PrWatchStateV1,
  args: {
    readonly eventIds: readonly string[];
    readonly inclusiveLedgerSequenceWatermark: number;
    readonly now?: Date;
  },
): PrWatchReducerResult {
  if (state.status !== 'active' || state.observationMode !== 'full') {
    throw new Error('pr_watch.invalid_transition: actionable requires active/full');
  }
  requireBeforeDeadline(state, args.now ?? new Date());
  if (args.eventIds.length === 0 || new Set(args.eventIds).size !== args.eventIds.length) {
    throw new Error('pr_watch.invalid_action_batch');
  }
  for (const eventId of args.eventIds) {
    const event = state.events[eventId];
    if (!event || event.disposition !== undefined) {
      throw new Error(`pr_watch.invalid_action_event: ${eventId}`);
    }
  }
  const now = (args.now ?? new Date()).toISOString();
  const batch: PrWatchActionBatchV1 = {
    actionBatchId: randomUUID(),
    generation: state.generation,
    inclusiveLedgerSequenceWatermark: args.inclusiveLedgerSequenceWatermark,
    eventIds: [...args.eventIds],
    handedOffAt: now,
  };

  if (state.actionRoundBudget.spent >= state.actionRoundBudget.limit) {
    if (state.actionGrant === undefined) {
      throw new Error('pr_watch.action_round_budget_missing_grant');
    }
    const dispositions = Object.fromEntries(
      batch.eventIds.map((eventId) => [eventId, 'deferred' as const]),
    );
    return transitionToBlocked(state, {
      now: args.now,
      firstObservedSequence: batch.inclusiveLedgerSequenceWatermark,
      blocker: {
        causeId: 'unbound',
        version: 1,
        kind: 'action_round_budget_exhausted',
        class: 'non_retryable',
        message: 'The action-round budget is exhausted; confirm terminal-only observation.',
        evidence: { batchId: batch.actionBatchId },
        allowedConsumingReasons: ['budget_exhausted'],
        budgetHandoffProof: {
          exhaustedKind: 'action_round',
          expectedGeneration: state.generation,
          batch,
          dispositions,
          counter: state.actionRoundBudget,
          actionGrantId: state.actionGrant.grantId,
        },
      },
      priorActionableBatch: batch,
    });
  }

  if (state.actionableWakeBudget.spent >= state.actionableWakeBudget.limit) {
    const dispositions = Object.fromEntries(
      batch.eventIds.map((eventId) => [eventId, 'deferred' as const]),
    );
    return transitionToBlocked(state, {
      now: args.now,
      firstObservedSequence: batch.inclusiveLedgerSequenceWatermark,
      blocker: {
        causeId: 'unbound',
        version: 1,
        kind: 'actionable_wake_budget_exhausted',
        class: 'non_retryable',
        message: 'The actionable wake budget is exhausted; confirm terminal-only observation.',
        evidence: { batchId: batch.actionBatchId },
        allowedConsumingReasons: ['budget_exhausted'],
        budgetHandoffProof: {
          exhaustedKind: 'actionable_wake',
          expectedGeneration: state.generation,
          batch,
          dispositions,
          counter: state.actionableWakeBudget,
        },
      },
      priorActionableBatch: batch,
    });
  }

  const transitionState = state.actionGrant !== undefined
    && state.actionGrant.revokedAt === undefined
    && state.actionableWakeBudget.spent >= state.actionGrant.maxActionableWakes
    ? revokePrWatchActions(state, {
        reason: 'pr_watch.actionable_wake_grant_exhausted',
        now: args.now,
      }).state
    : state;
  const { waiter: _waiter, ...common } = transitionState;
  return transition({
    ...common,
    status: 'actionable',
    observationMode: 'full',
    batch,
    updatedAt: now,
    actionableWakeBudget: {
      ...transitionState.actionableWakeBudget,
      spent: transitionState.actionableWakeBudget.spent + 1,
    },
  });
}

export function recordEventDispositions(
  state: PrWatchStateV1,
  args: {
    readonly actionBatchId: string;
    readonly dispositions: Readonly<Record<string, { disposition: PrWatchEventDisposition; note?: string }>>;
    readonly now?: Date;
  },
): PrWatchReducerResult {
  if (state.status !== 'actionable' || state.batch.actionBatchId !== args.actionBatchId) {
    throw new Error('pr_watch.stale_action_batch');
  }
  const now = (args.now ?? new Date()).toISOString();
  const batchIds = new Set(state.batch.eventIds);
  const events = { ...state.events };
  for (const [eventId, disposition] of Object.entries(args.dispositions)) {
    if (!batchIds.has(eventId) || !events[eventId]) {
      throw new Error(`pr_watch.event_not_in_batch: ${eventId}`);
    }
    events[eventId] = {
      ...events[eventId],
      disposition: disposition.disposition,
      ...(disposition.note !== undefined ? { dispositionNote: disposition.note } : {}),
      dispositionAt: now,
    };
  }
  return transition({ ...state, events, updatedAt: now });
}

export function transitionToBlocked(
  state: PrWatchStateV1,
  args: {
    readonly blocker: PrWatchBlockerCauseV1;
    readonly priorActionableBatch?: PrWatchActionBatchV1;
    readonly firstObservedSequence?: number;
    readonly now?: Date;
  },
): PrWatchReducerResult {
  assertMutable(state);
  const now = (args.now ?? new Date()).toISOString();
  const closedBlockerSurfaces = state.status === 'blocked'
    ? closeSurface(state.blockerSurfaces, state.currentBlockerSurfaceId, now, 'superseded')
    : state.blockerSurfaces;
  const surface = makeSurface('blocker', state.generation, now);
  const base = withoutLifecycleFields(state);
  const blocker = bindBlockerIdentity(state, args.blocker, args.firstObservedSequence);
  const next: PrWatchBlockedStateV1 = {
    ...base,
    status: 'blocked',
    observationMode: state.observationMode,
    blocker,
    currentBlockerSurfaceId: surface.surfaceId,
    ...(args.priorActionableBatch !== undefined
      ? { priorActionableBatch: args.priorActionableBatch }
      : state.status === 'actionable'
        ? { priorActionableBatch: state.batch }
        : {}),
    blockerSurfaces: [...closedBlockerSurfaces, surface],
    updatedAt: now,
  };
  return transition(next);
}

function bindBlockerIdentity(
  state: PrWatchStateV1,
  draft: PrWatchBlockerCauseV1,
  firstObservedSequence = state.generation,
): PrWatchBlockerCauseV1 {
  if (!Number.isSafeInteger(firstObservedSequence) || firstObservedSequence < 1) {
    throw new Error('pr_watch.invalid_blocker_sequence');
  }
  const subject = blockerSubject(draft);
  if (
    state.status === 'blocked'
    && state.blocker.kind === draft.kind
    && blockerSubject(state.blocker) === subject
  ) {
    const priorFacts = blockerFacts(state.blocker);
    const nextFacts = blockerFacts(draft);
    return {
      ...draft,
      causeId: state.blocker.causeId,
      version: sha256Canonical(priorFacts) === sha256Canonical(nextFacts)
        ? state.blocker.version
        : state.blocker.version + 1,
    };
  }
  return {
    ...draft,
    causeId: sha256Canonical({
      watchId: state.watchId,
      kind: draft.kind,
      subject,
      firstObservedSequence,
    }),
    version: 1,
  };
}

function blockerSubject(blocker: PrWatchBlockerCauseV1): string {
  const subject = blocker.evidence.subject;
  if (typeof subject === 'string' && subject.length > 0) return subject;
  const batchId = blocker.budgetHandoffProof?.batch.actionBatchId;
  return batchId ?? 'watch';
}

function blockerFacts(blocker: PrWatchBlockerCauseV1): unknown {
  const { causeId: _causeId, version: _version, ...facts } = blocker;
  return facts;
}

export function tryExpirePrWatch(
  state: PrWatchStateV1,
  args: { readonly now?: Date; readonly expiryTransactionId?: string } = {},
): PrWatchReducerResult {
  if (state.status === 'expired') {
    return { state, transactionId: state.expiryTransactionId };
  }
  if (state.status === 'terminal' || state.status === 'cancelled') {
    throw new Error('pr_watch.invalid_transition: terminal watch cannot expire');
  }
  if (state.watchExpiresAt === undefined) {
    throw new Error('pr_watch.expiry_disabled');
  }
  const nowDate = args.now ?? new Date();
  if (nowDate.getTime() < Date.parse(state.watchExpiresAt)) {
    throw new Error('pr_watch.not_expired');
  }
  const now = nowDate.toISOString();
  const suspendedState = suspendState(state);
  const surface = makeSurface('expiry', state.generation, now);
  const expiryTransactionId = args.expiryTransactionId ?? makePrWatchTransactionId();
  const blockerSurfaces = state.status === 'blocked'
    ? closeSurface(state.blockerSurfaces, state.currentBlockerSurfaceId, now, 'expired')
    : state.blockerSurfaces;
  const base = withoutLifecycleFields(state);
  const next: PrWatchExpiredStateV1 = {
    ...base,
    status: 'expired',
    observationMode: state.observationMode,
    expiredAt: now,
    expiryTransactionId,
    currentExpirySurfaceId: surface.surfaceId,
    suspendedState,
    suspendedStateDigest: sha256Canonical(suspendedState),
    blockerSurfaces,
    expirySurfaces: [...state.expirySurfaces, surface],
    updatedAt: now,
  };
  return { state: parsePrWatchState(next), transactionId: expiryTransactionId };
}

export function rearmPrWatch(
  state: PrWatchStateV1,
  args: {
    readonly reason: PrWatchRearmReason;
    readonly expectedGeneration: number;
    readonly receiptKey: string;
    readonly actionBatchId?: string;
    readonly blockerCauseId?: string;
    readonly blockerVersion?: number;
    readonly priorWatcherActionId?: string;
    readonly confirmed?: boolean;
    readonly extendDays?: number;
    readonly revalidationPassed?: boolean;
    readonly now?: Date;
  },
): PrWatchRearmResult {
  const existing = state.receipts[args.receiptKey];
  if (existing) {
    return { state, receipt: existing, transactionId: existing.receiptId, idempotent: true };
  }
  if (state.generation !== args.expectedGeneration) {
    throw new Error('pr_watch.stale_generation');
  }
  const nowDate = args.now ?? new Date();
  if (args.reason !== 'expired') requireBeforeDeadline(state, nowDate);

  if (args.reason === 'expired') {
    return rearmExpired(state, args, nowDate);
  }
  if (args.reason === 'disposed_batch') {
    if (
      state.status !== 'actionable'
      || state.batch.actionBatchId !== args.actionBatchId
      || state.batch.eventIds.some((eventId) => state.events[eventId]?.disposition === undefined)
    ) {
      throw new Error('pr_watch.action_batch_not_fully_disposed');
    }
    return commitRearm(
      state,
      args,
      {
        ...withoutLifecycleFields(state),
        status: 'active',
        observationMode: 'full',
        generation: state.generation + 1,
        waiter: makeWaiter(state.generation + 1, 'full', nowDate.toISOString()),
      },
      nowDate,
      { actionBatchId: state.batch.actionBatchId },
    );
  }
  if (args.reason === 'timeout' || args.reason === 'stale_waiter') {
    const waiterMatches = state.status === 'active'
      && state.waiter.watcherActionId === args.priorWatcherActionId;
    const timeoutEligible = args.reason === 'timeout'
      && waiterMatches
      && state.waiter.state === 'exited'
      && state.waiter.exitReason === 'timeout';
    const staleEligible = args.reason === 'stale_waiter'
      && waiterMatches
      && (
        state.waiter.state === 'exited'
        || (
          state.waiter.state === 'running'
          && state.waiter.leaseExpiresAt !== undefined
          && Date.parse(state.waiter.leaseExpiresAt) <= nowDate.getTime()
        )
      );
    if (!timeoutEligible && !staleEligible) {
      throw new Error('pr_watch.waiter_not_replaceable');
    }
    return commitRearm(
      state,
      args,
      {
        ...state,
        waiter: makeWaiter(state.generation, state.observationMode, nowDate.toISOString()),
      },
      nowDate,
    );
  }
  if (args.reason === 'blocked_resolved') {
    if (
      state.status !== 'blocked'
      || state.blocker.class !== 'revalidate'
      || !state.blocker.allowedConsumingReasons.includes('blocked_resolved')
      || state.blocker.causeId !== args.blockerCauseId
      || state.blocker.version !== args.blockerVersion
      || args.revalidationPassed !== true
    ) {
      throw new Error('pr_watch.blocker_not_resolved');
    }
    const blockerSurfaces = closeSurface(
      state.blockerSurfaces,
      state.currentBlockerSurfaceId,
      nowDate.toISOString(),
      'consumed',
    );
    const generation = state.generation + 1;
    return commitRearm(
      state,
      args,
      {
        ...withoutLifecycleFields(state),
        status: 'active',
        observationMode: state.observationMode,
        generation,
        blockerSurfaces,
        waiter: makeWaiter(generation, state.observationMode, nowDate.toISOString()),
      },
      nowDate,
    );
  }
  if (args.reason === 'budget_exhausted') {
    if (
      state.status !== 'blocked'
      || !state.blocker.allowedConsumingReasons.includes('budget_exhausted')
      || state.blocker.causeId !== args.blockerCauseId
      || state.blocker.version !== args.blockerVersion
      || state.blocker.budgetHandoffProof === undefined
      || state.blocker.budgetHandoffProof.expectedGeneration !== state.generation
      || state.blocker.budgetHandoffProof.batch.actionBatchId !== args.actionBatchId
    ) {
      throw new Error('pr_watch.budget_handoff_mismatch');
    }
    const proof = state.blocker.budgetHandoffProof;
    const liveCounter = proof.exhaustedKind === 'action_round'
      ? state.actionRoundBudget
      : state.actionableWakeBudget;
    if (sha256Canonical(proof.counter) !== sha256Canonical(liveCounter)) {
      throw new Error('pr_watch.budget_handoff_counter_mismatch');
    }
    if (
      proof.exhaustedKind === 'action_round'
      && (
        proof.actionGrantId === undefined
        || state.actionGrant?.grantId !== proof.actionGrantId
      )
    ) {
      throw new Error('pr_watch.budget_handoff_grant_mismatch');
    }
    const authorityRevoked = state.actionGrant !== undefined
      && state.actionGrant.revokedAt === undefined
      ? revokePrWatchActions(state, {
          reason: 'pr_watch.budget_exhausted',
          now: nowDate,
        }).state
      : state;
    const blockerSurfaces = closeSurface(
      state.blockerSurfaces,
      state.currentBlockerSurfaceId,
      nowDate.toISOString(),
      'consumed',
    );
    const generation = state.generation + 1;
    return commitRearm(
      state,
      args,
      {
        ...withoutLifecycleFields(authorityRevoked),
        status: 'active',
        observationMode: 'terminal_only',
        generation,
        blockerSurfaces,
        waiter: makeWaiter(generation, 'terminal_only', nowDate.toISOString()),
      },
      nowDate,
      { actionBatchId: proof.batch.actionBatchId, reboundBudgetHandoffProof: proof },
    );
  }
  throw new Error('pr_watch.unsupported_rearm_reason');
}

export function claimPrWatchSurface(
  state: PrWatchStateV1,
  args: {
    readonly surfaceId: string;
    readonly requestId: string;
    readonly leaseMs: number;
    readonly now?: Date;
  },
): PrWatchReducerResult {
  if (!Number.isSafeInteger(args.leaseMs) || args.leaseMs <= 0) {
    throw new Error('pr_watch.invalid_surface_lease');
  }
  const target = [...state.blockerSurfaces, ...state.expirySurfaces]
    .find((surface) => surface.surfaceId === args.surfaceId);
  if (!target || target.state !== 'pending' || target.closedAt !== undefined) {
    throw new Error('pr_watch.surface_not_claimable');
  }
  const nowDate = args.now ?? new Date();
  const update = (surfaces: readonly PrWatchRemedySurfaceV1[]): readonly PrWatchRemedySurfaceV1[] =>
    surfaces.map((surface) => {
      if (surface.surfaceId !== args.surfaceId) return surface;
      if (surface.state !== 'pending' || surface.closedAt !== undefined) {
        throw new Error('pr_watch.surface_not_claimable');
      }
      const attempt = surface.latestClaimAttempt + 1;
      return {
        ...surface,
        state: 'claimed',
        latestClaimAttempt: attempt,
        claimedByRequestId: args.requestId,
        claimedAt: nowDate.toISOString(),
        claimLeaseExpiresAt: new Date(nowDate.getTime() + args.leaseMs).toISOString(),
        attempts: [...surface.attempts, {
          attempt,
          requestId: args.requestId,
          claimedAt: nowDate.toISOString(),
        }],
      };
    });
  return transition({
    ...state,
    blockerSurfaces: update(state.blockerSurfaces),
    expirySurfaces: update(state.expirySurfaces),
    updatedAt: nowDate.toISOString(),
  });
}

export function deliverPrWatchSurface(
  state: PrWatchStateV1,
  args: {
    readonly surfaceId: string;
    readonly requestId?: string;
    readonly attempt?: number;
    readonly via: 'waiter_wake' | 'jit';
    readonly now?: Date;
  },
): PrWatchReducerResult {
  const now = (args.now ?? new Date()).toISOString();
  const target = [...state.blockerSurfaces, ...state.expirySurfaces]
    .find((surface) => surface.surfaceId === args.surfaceId);
  if (!target || target.closedAt !== undefined || target.state === 'delivered') {
    throw new Error('pr_watch.surface_not_deliverable');
  }
  const auditingClaim = target.state === 'claimed';
  if (auditingClaim && (
    target.claimedByRequestId !== args.requestId
    || target.latestClaimAttempt !== args.attempt
  )) {
    throw new Error('pr_watch.stale_surface_audit');
  }
  if (!auditingClaim && args.via === 'jit') throw new Error('pr_watch.stale_surface_audit');
  const update = (surfaces: readonly PrWatchRemedySurfaceV1[]): readonly PrWatchRemedySurfaceV1[] =>
    surfaces.map((surface) => {
      if (surface.surfaceId !== args.surfaceId) return surface;
      if (surface.closedAt !== undefined || surface.state === 'delivered') {
        throw new Error('pr_watch.surface_not_deliverable');
      }
      const attempts = auditingClaim
        ? surface.attempts.map((attempt) => attempt.attempt === args.attempt
          ? { ...attempt, outcome: 'delivered' as const, completedAt: now }
          : attempt)
        : surface.attempts;
      return clearClaimFields({
        ...surface,
        state: 'delivered',
        deliveredAt: now,
        deliveredVia: args.via,
        attempts,
      });
    });
  return transition({
    ...state,
    blockerSurfaces: update(state.blockerSurfaces),
    expirySurfaces: update(state.expirySurfaces),
    updatedAt: now,
  });
}

export function recoverExpiredPrWatchSurfaceClaim(
  state: PrWatchStateV1,
  args: {
    readonly surfaceId: string;
    readonly requestId: string;
    readonly attempt: number;
    readonly now?: Date;
  },
): PrWatchReducerResult {
  const nowDate = args.now ?? new Date();
  const now = nowDate.toISOString();
  const target = [...state.blockerSurfaces, ...state.expirySurfaces]
    .find((surface) => surface.surfaceId === args.surfaceId);
  if (
    !target
    || target.state !== 'claimed'
    || target.claimedByRequestId !== args.requestId
    || target.latestClaimAttempt !== args.attempt
    || target.claimLeaseExpiresAt === undefined
    || Date.parse(target.claimLeaseExpiresAt) > nowDate.getTime()
  ) {
    throw new Error('pr_watch.surface_claim_not_recoverable');
  }
  const update = (surfaces: readonly PrWatchRemedySurfaceV1[]): readonly PrWatchRemedySurfaceV1[] =>
    surfaces.map((surface) => {
      if (surface.surfaceId !== args.surfaceId) return surface;
      if (
        surface.state !== 'claimed'
        || surface.claimedByRequestId !== args.requestId
        || surface.latestClaimAttempt !== args.attempt
        || surface.claimLeaseExpiresAt === undefined
        || Date.parse(surface.claimLeaseExpiresAt) > nowDate.getTime()
      ) {
        throw new Error('pr_watch.surface_claim_not_recoverable');
      }
      const attempts = surface.attempts.map((attempt) => attempt.attempt === args.attempt
        ? { ...attempt, outcome: 'lease_expired' as const, completedAt: now }
        : attempt);
      return clearClaimFields({ ...surface, state: 'pending', attempts });
    });
  return transition({
    ...state,
    blockerSurfaces: update(state.blockerSurfaces),
    expirySurfaces: update(state.expirySurfaces),
    updatedAt: now,
  });
}

export function claimPrWatchWaiter(
  state: PrWatchStateV1,
  args: {
    readonly watcherActionId: string;
    readonly generation: number;
    readonly leaseOwnerId: string;
    readonly leaseMs: number;
    readonly now?: Date;
  },
): PrWatchReducerResult {
  if (state.status !== 'active') throw new Error('pr_watch.waiter_not_claimable');
  if (
    state.generation !== args.generation
    || state.waiter.generation !== args.generation
    || state.waiter.watcherActionId !== args.watcherActionId
  ) {
    throw new Error('pr_watch.stale_waiter');
  }
  if (!Number.isSafeInteger(args.leaseMs) || args.leaseMs <= 0) {
    throw new Error('pr_watch.invalid_waiter_lease');
  }
  const nowDate = args.now ?? new Date();
  if (
    state.waiter.state === 'running'
    && state.waiter.leaseExpiresAt !== undefined
    && Date.parse(state.waiter.leaseExpiresAt) > nowDate.getTime()
  ) {
    throw new Error('pr_watch.waiter_already_running');
  }
  if (state.waiter.state === 'exited') throw new Error('pr_watch.waiter_exited');
  requireBeforeDeadline(state, nowDate);
  const now = nowDate.toISOString();
  return transition({
    ...state,
    waiter: {
      ...state.waiter,
      state: 'running',
      leaseOwnerId: args.leaseOwnerId,
      leaseHeartbeatAt: now,
      leaseExpiresAt: new Date(nowDate.getTime() + args.leaseMs).toISOString(),
    },
    updatedAt: now,
  });
}

export function heartbeatPrWatchWaiter(
  state: PrWatchStateV1,
  args: {
    readonly watcherActionId: string;
    readonly generation: number;
    readonly leaseOwnerId: string;
    readonly leaseMs: number;
    readonly now?: Date;
  },
): PrWatchReducerResult {
  if (
    state.status !== 'active'
    || state.generation !== args.generation
    || state.waiter.watcherActionId !== args.watcherActionId
    || state.waiter.state !== 'running'
    || state.waiter.leaseOwnerId !== args.leaseOwnerId
  ) {
    throw new Error('pr_watch.waiter_lease_lost');
  }
  if (!Number.isSafeInteger(args.leaseMs) || args.leaseMs <= 0) {
    throw new Error('pr_watch.invalid_waiter_lease');
  }
  const nowDate = args.now ?? new Date();
  requireBeforeDeadline(state, nowDate);
  const now = nowDate.toISOString();
  return transition({
    ...state,
    waiter: {
      ...state.waiter,
      leaseHeartbeatAt: now,
      leaseExpiresAt: new Date(nowDate.getTime() + args.leaseMs).toISOString(),
    },
    updatedAt: now,
  });
}

export function exitPrWatchWaiter(
  state: PrWatchStateV1,
  args: {
    readonly watcherActionId: string;
    readonly generation: number;
    readonly leaseOwnerId: string;
    readonly reason: NonNullable<PrWatchWaiterActionV1['exitReason']>;
    readonly now?: Date;
  },
): PrWatchReducerResult {
  if (
    state.status !== 'active'
    || state.generation !== args.generation
    || state.waiter.watcherActionId !== args.watcherActionId
    || state.waiter.state !== 'running'
    || state.waiter.leaseOwnerId !== args.leaseOwnerId
  ) {
    throw new Error('pr_watch.waiter_lease_lost');
  }
  const now = (args.now ?? new Date()).toISOString();
  const {
    leaseOwnerId: _leaseOwnerId,
    leaseHeartbeatAt: _leaseHeartbeatAt,
    leaseExpiresAt: _leaseExpiresAt,
    ...waiter
  } = state.waiter;
  return transition({
    ...state,
    waiter: {
      ...waiter,
      state: 'exited',
      exitReason: args.reason,
      exitedAt: now,
    },
    updatedAt: now,
  });
}

export function markPrWatchTerminal(
  state: PrWatchStateV1,
  args: { readonly outcome: 'green' | 'all_closed'; readonly fingerprint: string; readonly now?: Date },
): PrWatchReducerResult {
  assertMutable(state);
  const now = (args.now ?? new Date()).toISOString();
  return transition({
    ...withoutLifecycleFields(state),
    status: 'terminal',
    observationMode: state.observationMode,
    outcome: args.outcome,
    terminalAt: now,
    terminalFingerprint: args.fingerprint,
    blockerSurfaces: closeAllOpenSurfaces(state.blockerSurfaces, now, 'terminal'),
    expirySurfaces: closeAllOpenSurfaces(state.expirySurfaces, now, 'terminal'),
    updatedAt: now,
  });
}

export function cancelPrWatch(
  state: PrWatchStateV1,
  nowDate = new Date(),
): PrWatchReducerResult {
  if (state.status === 'cancelled') return { state, transactionId: makePrWatchTransactionId() };
  if (state.status === 'terminal') throw new Error('pr_watch.already_terminal');
  const now = nowDate.toISOString();
  return transition({
    ...withoutLifecycleFields(state),
    status: 'cancelled',
    observationMode: state.observationMode,
    cancelledAt: now,
    blockerSurfaces: closeAllOpenSurfaces(state.blockerSurfaces, now, 'cancelled'),
    expirySurfaces: closeAllOpenSurfaces(state.expirySurfaces, now, 'cancelled'),
    updatedAt: now,
  });
}

function rearmExpired(
  state: PrWatchStateV1,
  args: Parameters<typeof rearmPrWatch>[1],
  nowDate: Date,
): PrWatchRearmResult {
  if (
    state.status !== 'expired'
    || args.confirmed !== true
    || !Number.isSafeInteger(args.extendDays)
    || args.extendDays === undefined
    || args.extendDays < 1
    || args.extendDays > 30
  ) {
    throw new Error('pr_watch.expiry_extension_confirmation_required');
  }
  if (sha256Canonical(state.suspendedState) !== state.suspendedStateDigest) {
    throw new Error('pr_watch.suspended_state_digest_mismatch');
  }
  const generation = state.generation + 1;
  const now = nowDate.toISOString();
  const watchExpiresAt = new Date(nowDate.getTime() + args.extendDays * 86_400_000).toISOString();
  const expirySurfaces = closeSurface(
    state.expirySurfaces,
    state.currentExpirySurfaceId,
    now,
    'consumed',
  );
  const base = {
    ...withoutLifecycleFields(state),
    generation,
    watchExpiresAt,
    expirySurfaces,
  };
  const suspended = state.suspendedState;
  if (suspended.status === 'active') {
    return commitRearm(state, args, {
      ...base,
      status: 'active',
      observationMode: suspended.observationMode,
      waiter: makeWaiter(generation, suspended.observationMode, now),
    }, nowDate);
  }
  if (suspended.status === 'actionable') {
    const batch = { ...suspended.batch, generation };
    return commitRearm(state, args, {
      ...base,
      status: 'actionable',
      observationMode: 'full',
      batch,
    }, nowDate, { actionBatchId: batch.actionBatchId });
  }
  const rebound = rebindBlockedCauseGeneration(suspended.blocker, generation);
  const surface = makeSurface('blocker', generation, now);
  return commitRearm(state, args, {
    ...base,
    status: 'blocked',
    observationMode: suspended.observationMode,
    blocker: rebound,
    currentBlockerSurfaceId: surface.surfaceId,
    ...(suspended.priorActionableBatch !== undefined
      ? { priorActionableBatch: suspended.priorActionableBatch }
      : {}),
    blockerSurfaces: [...state.blockerSurfaces, surface],
  }, nowDate, {
    blockerSurfaceId: surface.surfaceId,
    ...(rebound.budgetHandoffProof !== undefined
      ? { reboundBudgetHandoffProof: rebound.budgetHandoffProof }
      : {}),
  });
}

function commitRearm(
  previous: PrWatchStateV1,
  args: Pick<Parameters<typeof rearmPrWatch>[1], 'reason' | 'receiptKey'>,
  candidate: unknown,
  nowDate: Date,
  extras: Pick<
    PrWatchRearmReceiptV1,
    'actionBatchId' | 'blockerSurfaceId' | 'reboundBudgetHandoffProof'
  > = {},
): PrWatchRearmResult {
  const next = parsePrWatchState({ ...(candidate as object), updatedAt: nowDate.toISOString() });
  const receipt: PrWatchRearmReceiptV1 = {
    receiptId: makePrWatchTransactionId(),
    receiptKey: args.receiptKey,
    reason: args.reason,
    priorGeneration: previous.generation,
    generation: next.generation,
    status: next.status,
    observationMode: next.observationMode,
    committedAt: nowDate.toISOString(),
    ...(next.status === 'active' ? { waiter: next.waiter } : {}),
    ...(extras.actionBatchId !== undefined ? { actionBatchId: extras.actionBatchId } : {}),
    ...(extras.blockerSurfaceId !== undefined ? { blockerSurfaceId: extras.blockerSurfaceId } : {}),
    ...(extras.reboundBudgetHandoffProof !== undefined
      ? { reboundBudgetHandoffProof: extras.reboundBudgetHandoffProof }
      : {}),
  };
  const state = parsePrWatchState({
    ...next,
    receipts: { ...next.receipts, [args.receiptKey]: receipt },
  });
  return { state, receipt, transactionId: receipt.receiptId, idempotent: false };
}

function transition(state: unknown): PrWatchReducerResult {
  return { state: parsePrWatchState(state), transactionId: makePrWatchTransactionId() };
}

function requireBeforeDeadline(state: PrWatchStateV1, now: Date): void {
  if (state.watchExpiresAt !== undefined && now.getTime() >= Date.parse(state.watchExpiresAt)) {
    throw new Error('pr_watch.deadline_elapsed');
  }
}

function assertMutable(state: PrWatchStateV1): void {
  if (state.status === 'terminal' || state.status === 'cancelled' || state.status === 'expired') {
    throw new Error(`pr_watch.invalid_transition: ${state.status}`);
  }
}

function makeWaiter(
  generation: number,
  observationMode: PrWatchObservationMode,
  now: string,
): PrWatchWaiterActionV1 {
  return {
    watcherActionId: randomUUID(),
    generation,
    observationMode,
    state: 'pending',
    createdAt: now,
  };
}

function makeSurface(
  kind: 'blocker' | 'expiry',
  generation: number,
  now: string,
): PrWatchRemedySurfaceV1 {
  return {
    surfaceId: makePrWatchSurfaceId(),
    kind,
    generation,
    createdAt: now,
    state: 'pending',
    latestClaimAttempt: 0,
    attempts: [],
  };
}

function closeSurface(
  surfaces: readonly PrWatchRemedySurfaceV1[],
  surfaceId: string,
  now: string,
  reason: string,
): readonly PrWatchRemedySurfaceV1[] {
  return surfaces.map((surface) => surface.surfaceId === surfaceId && surface.closedAt === undefined
    ? { ...surface, closedAt: now, closedReason: reason }
    : surface);
}

function closeAllOpenSurfaces(
  surfaces: readonly PrWatchRemedySurfaceV1[],
  now: string,
  reason: string,
): readonly PrWatchRemedySurfaceV1[] {
  return surfaces.map((surface) => surface.closedAt === undefined
    ? { ...surface, closedAt: now, closedReason: reason }
    : surface);
}

function clearClaimFields(surface: PrWatchRemedySurfaceV1): PrWatchRemedySurfaceV1 {
  const {
    claimedByRequestId: _requestId,
    claimedAt: _claimedAt,
    claimLeaseExpiresAt: _leaseExpiresAt,
    ...rest
  } = surface;
  return rest;
}

function withoutLifecycleFields(state: PrWatchStateV1): Omit<
  PrWatchStateV1,
  'status' | 'waiter' | 'batch' | 'blocker' | 'currentBlockerSurfaceId'
  | 'priorActionableBatch' | 'expiredAt' | 'expiryTransactionId'
  | 'currentExpirySurfaceId' | 'suspendedState' | 'suspendedStateDigest'
  | 'outcome' | 'terminalAt' | 'terminalFingerprint' | 'cancelledAt'
> {
  const record = { ...state } as Record<string, unknown>;
  for (const key of [
    'status', 'waiter', 'batch', 'blocker', 'currentBlockerSurfaceId',
    'priorActionableBatch', 'expiredAt', 'expiryTransactionId',
    'currentExpirySurfaceId', 'suspendedState', 'suspendedStateDigest',
    'outcome', 'terminalAt', 'terminalFingerprint', 'cancelledAt',
  ]) {
    delete record[key];
  }
  return record as ReturnType<typeof withoutLifecycleFields>;
}

function suspendState(state: Exclude<PrWatchStateV1, { status: 'terminal' | 'cancelled' | 'expired' }>): SuspendedPrWatchStateV1 {
  if (state.status === 'active') {
    return { status: 'active', observationMode: state.observationMode };
  }
  if (state.status === 'actionable') {
    return { status: 'actionable', observationMode: 'full', batch: state.batch };
  }
  return {
    status: 'blocked',
    observationMode: state.observationMode,
    blocker: state.blocker,
    ...(state.priorActionableBatch !== undefined
      ? { priorActionableBatch: state.priorActionableBatch }
      : {}),
  };
}

function rebindBlockedCauseGeneration(
  blocker: PrWatchBlockerCauseV1,
  generation: number,
): PrWatchBlockerCauseV1 {
  if (blocker.budgetHandoffProof === undefined) return blocker;
  return {
    ...blocker,
    budgetHandoffProof: {
      ...blocker.budgetHandoffProof,
      expectedGeneration: generation,
    },
  };
}
