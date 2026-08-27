import { z } from 'zod';

import { sha256Canonical } from './canonical.js';
import { parsePrWatchId, parsePrWatchSurfaceId } from './id.js';
import {
  PR_WATCH_SCHEMA_VERSION,
  type PrWatchLedgerRecordV1,
  type PrWatchStartIndexRecordV1,
  type PrWatchStateCacheV1,
  type PrWatchStateV1,
  type SuspendedPrWatchStateV1,
} from './types.js';

const isoTimestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)), {
  message: 'expected an ISO timestamp',
});
const nonEmpty = z.string().min(1);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const positiveInteger = z.number().int().positive();
const nonNegativeInteger = z.number().int().nonnegative();
const effectKindSchema = z.enum([
  'push_single_branch',
  'reply_review_comment',
  'post_pr_comment',
  'resolve_review_thread',
]);

const effectiveConfigSchema = z.object({
  maxPrs: z.number().int().min(1).max(100),
  maxActionableWakes: positiveInteger,
  maxActionRounds: positiveInteger,
  maxWatchAgeDays: z.union([z.literal(-1), z.number().int().min(1).max(365)]),
  policyHash: sha256,
}).strict();

const eventIdentitySchema = z.object({
  prNumber: positiveInteger,
  headSha: nonEmpty,
  kind: z.enum(['check_failure', 'review_thread', 'comment', 'review', 'pr_closed']),
  providerSourceId: nonEmpty,
  attempt: nonNegativeInteger,
}).strict();

const dispositionSchema = z.enum(['acknowledged', 'superseded', 'deferred', 'resolved']);
const eventRecordSchema = z.object({
  id: nonEmpty,
  identity: eventIdentitySchema,
  firstObservedAt: isoTimestamp,
  lastObservedAt: isoTimestamp,
  versionTimestamp: isoTimestamp.optional(),
  replyCommentId: positiveInteger.optional(),
  disposition: dispositionSchema.optional(),
  dispositionNote: z.string().max(2048).optional(),
  dispositionAt: isoTimestamp.optional(),
  fixAttemptCount: z.number().int().min(0).max(3),
  supersededByHead: nonEmpty.optional(),
}).strict();

const actionBatchSchema = z.object({
  actionBatchId: nonEmpty,
  generation: positiveInteger,
  inclusiveLedgerSequenceWatermark: positiveInteger,
  eventIds: z.array(nonEmpty).min(1),
  handedOffAt: isoTimestamp,
}).strict().superRefine((batch, ctx) => {
  if (new Set(batch.eventIds).size !== batch.eventIds.length) {
    ctx.addIssue({ code: 'custom', message: 'action batch event ids must be unique' });
  }
});

const budgetCounterSchema = z.object({
  identity: nonEmpty,
  limit: positiveInteger,
  spent: nonNegativeInteger,
}).strict().refine((counter) => counter.spent <= counter.limit, {
  message: 'budget spent cannot exceed limit',
});

const budgetHandoffProofSchema = z.object({
  exhaustedKind: z.enum(['actionable_wake', 'action_round']),
  expectedGeneration: positiveInteger,
  batch: actionBatchSchema,
  dispositions: z.record(z.string(), dispositionSchema),
  counter: budgetCounterSchema,
  actionGrantId: nonEmpty.optional(),
}).strict().superRefine((proof, ctx) => {
  const dispositionIds = Object.keys(proof.dispositions).sort();
  const eventIds = [...proof.batch.eventIds].sort();
  if (JSON.stringify(dispositionIds) !== JSON.stringify(eventIds)) {
    ctx.addIssue({ code: 'custom', message: 'budget dispositions must cover the exact handed-off batch' });
  }
  if (proof.counter.spent !== proof.counter.limit) {
    ctx.addIssue({ code: 'custom', message: 'budget handoff proof requires an exhausted counter' });
  }
  if (proof.exhaustedKind === 'action_round' && proof.actionGrantId === undefined) {
    ctx.addIssue({ code: 'custom', message: 'action-round exhaustion requires the originating grant' });
  }
  if (proof.exhaustedKind === 'actionable_wake' && proof.actionGrantId !== undefined) {
    ctx.addIssue({ code: 'custom', message: 'actionable-wake exhaustion forbids an action grant' });
  }
});

const rearmReasonSchema = z.enum([
  'disposed_batch',
  'timeout',
  'stale_waiter',
  'budget_exhausted',
  'expired',
  'blocked_resolved',
]);

const blockerSchema = z.object({
  causeId: nonEmpty,
  version: positiveInteger,
  kind: z.enum([
    'provider_missing',
    'provider_version',
    'provider_auth',
    'provider_scope',
    'provider_timeout',
    'provider_cancelled',
    'policy_changed',
    'topology_changed',
    'head_changed',
    'evidence_incomplete',
    'actionable_wake_budget_exhausted',
    'action_round_budget_exhausted',
    'authorization_required',
    'lease_lost',
    'corrupt_state',
  ]),
  class: z.enum(['revalidate', 'non_retryable', 'restart_required']),
  message: nonEmpty,
  evidence: z.record(z.string(), z.unknown()),
  allowedConsumingReasons: z.array(rearmReasonSchema),
  budgetHandoffProof: budgetHandoffProofSchema.optional(),
}).strict().superRefine((blocker, ctx) => {
  const expectedBudgetKind = blocker.kind === 'actionable_wake_budget_exhausted'
    ? 'actionable_wake'
    : blocker.kind === 'action_round_budget_exhausted'
      ? 'action_round'
      : undefined;
  if (expectedBudgetKind === undefined && blocker.budgetHandoffProof !== undefined) {
    ctx.addIssue({ code: 'custom', message: 'non-budget blocker forbids a budget handoff proof' });
  }
  if (expectedBudgetKind !== undefined) {
    if (blocker.class !== 'non_retryable') {
      ctx.addIssue({ code: 'custom', message: 'budget blockers must be non-retryable' });
    }
    if (blocker.budgetHandoffProof?.exhaustedKind !== expectedBudgetKind) {
      ctx.addIssue({ code: 'custom', message: 'budget blocker kind and handoff proof disagree' });
    }
    if (
      blocker.allowedConsumingReasons.length !== 1
      || blocker.allowedConsumingReasons[0] !== 'budget_exhausted'
    ) {
      ctx.addIssue({ code: 'custom', message: 'budget blocker permits only budget_exhausted' });
    }
  }
  if (
    blocker.class === 'revalidate'
    && (
      blocker.allowedConsumingReasons.length !== 1
      || blocker.allowedConsumingReasons[0] !== 'blocked_resolved'
    )
  ) {
    ctx.addIssue({ code: 'custom', message: 'revalidate blocker permits only blocked_resolved' });
  }
  if (blocker.class === 'restart_required' && blocker.allowedConsumingReasons.length !== 0) {
    ctx.addIssue({ code: 'custom', message: 'restart-required blocker forbids rearm reasons' });
  }
});

const surfaceAttemptSchema = z.object({
  attempt: positiveInteger,
  requestId: nonEmpty,
  claimedAt: isoTimestamp,
  outcome: z.enum(['delivered', 'lease_expired', 'closed']).optional(),
  completedAt: isoTimestamp.optional(),
}).strict();

const surfaceSchema = z.object({
  surfaceId: z.string().refine((value) => {
    try {
      parsePrWatchSurfaceId(value);
      return true;
    } catch {
      return false;
    }
  }),
  kind: z.enum(['blocker', 'expiry']),
  generation: positiveInteger,
  createdAt: isoTimestamp,
  state: z.enum(['pending', 'claimed', 'delivered']),
  latestClaimAttempt: nonNegativeInteger,
  claimedByRequestId: nonEmpty.optional(),
  claimedAt: isoTimestamp.optional(),
  claimLeaseExpiresAt: isoTimestamp.optional(),
  deliveredAt: isoTimestamp.optional(),
  deliveredVia: z.enum(['waiter_wake', 'jit']).optional(),
  closedAt: isoTimestamp.optional(),
  closedReason: nonEmpty.optional(),
  attempts: z.array(surfaceAttemptSchema),
}).strict().superRefine((surface, ctx) => {
  const hasClaim = surface.claimedByRequestId !== undefined
    && surface.claimedAt !== undefined
    && surface.claimLeaseExpiresAt !== undefined;
  if (surface.state === 'claimed' && !hasClaim) {
    ctx.addIssue({ code: 'custom', message: 'claimed surface requires request and lease fields' });
  }
  if (surface.state !== 'claimed' && hasClaim) {
    ctx.addIssue({ code: 'custom', message: 'only a claimed surface may retain live claim fields' });
  }
  if (surface.state === 'delivered' && (surface.deliveredAt === undefined || surface.deliveredVia === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'delivered surface requires delivery evidence' });
  }
  if (surface.latestClaimAttempt !== surface.attempts.length) {
    ctx.addIssue({ code: 'custom', message: 'surface attempt counter must match attempt history' });
  }
});

const waiterSchema = z.object({
  watcherActionId: nonEmpty,
  generation: positiveInteger,
  observationMode: z.enum(['full', 'terminal_only']),
  state: z.enum(['pending', 'running', 'exited']),
  createdAt: isoTimestamp,
  leaseOwnerId: nonEmpty.optional(),
  leaseHeartbeatAt: isoTimestamp.optional(),
  leaseExpiresAt: isoTimestamp.optional(),
  exitReason: z.enum(['timeout', 'actionable', 'terminal', 'blocked', 'expired', 'cancelled']).optional(),
  exitedAt: isoTimestamp.optional(),
}).strict().superRefine((waiter, ctx) => {
  const liveLease = waiter.leaseOwnerId !== undefined
    && waiter.leaseHeartbeatAt !== undefined
    && waiter.leaseExpiresAt !== undefined;
  if (waiter.state === 'running' && !liveLease) {
    ctx.addIssue({ code: 'custom', message: 'running waiter requires a complete execution lease' });
  }
  if (waiter.state !== 'running' && liveLease) {
    ctx.addIssue({ code: 'custom', message: 'only a running waiter may retain execution lease fields' });
  }
  if (waiter.state === 'exited' && (waiter.exitReason === undefined || waiter.exitedAt === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'exited waiter requires exit evidence' });
  }
  if (waiter.state !== 'exited' && (waiter.exitReason !== undefined || waiter.exitedAt !== undefined)) {
    ctx.addIssue({ code: 'custom', message: 'only an exited waiter may retain exit evidence' });
  }
});

const receiptSchema = z.object({
  receiptId: nonEmpty,
  receiptKey: nonEmpty,
  reason: rearmReasonSchema,
  priorGeneration: positiveInteger,
  generation: positiveInteger,
  status: z.enum(['active', 'actionable', 'blocked', 'expired', 'terminal', 'cancelled']),
  observationMode: z.enum(['full', 'terminal_only']),
  committedAt: isoTimestamp,
  waiter: waiterSchema.optional(),
  actionBatchId: nonEmpty.optional(),
  blockerSurfaceId: nonEmpty.optional(),
  reboundBudgetHandoffProof: budgetHandoffProofSchema.optional(),
}).strict();

const commonShape = {
  schemaVersion: z.literal(PR_WATCH_SCHEMA_VERSION),
  watchId: z.string().refine((value) => {
    try {
      parsePrWatchId(value);
      return true;
    } catch {
      return false;
    }
  }),
  repoRoot: nonEmpty,
  repository: nonEmpty,
  anchorPrNumber: positiveInteger,
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
  generation: positiveInteger,
  effectiveConfig: effectiveConfigSchema,
  watchExpiresAt: isoTimestamp.optional(),
  reverseStartKeyDigest: sha256.optional(),
  events: z.record(z.string(), eventRecordSchema),
  expectedHeads: z.record(z.string(), nonEmpty),
  headUpdateObservedAt: z.record(z.string(), isoTimestamp).optional(),
  providerCapability: z.record(z.string(), z.unknown()).optional(),
  policyEvidence: z.record(z.string(), z.unknown()).optional(),
  terminalStability: z.object({
    fingerprint: nonEmpty,
    firstObservedAt: isoTimestamp,
  }).strict().optional(),
  lastObservation: z.object({
    observedAt: isoTimestamp,
    complete: z.boolean(),
    incompleteReasons: z.array(nonEmpty),
    queryCost: nonNegativeInteger,
    projectedPointSpend: nonNegativeInteger,
    terminalFingerprint: nonEmpty.optional(),
  }).strict().optional(),
  roundCount: nonNegativeInteger,
  actionableWakeBudget: budgetCounterSchema,
  actionRoundBudget: budgetCounterSchema,
  blockerSurfaces: z.array(surfaceSchema),
  expirySurfaces: z.array(surfaceSchema),
  receipts: z.record(z.string(), receiptSchema),
  actionGrant: z.object({
    grantId: nonEmpty,
    grantedAt: isoTimestamp,
    effectKinds: z.array(effectKindSchema).min(1),
    maxActionRounds: positiveInteger,
    maxActionableWakes: positiveInteger,
    expectedPolicyHash: sha256,
    expectedTopologyHash: sha256,
    observedHeads: z.record(z.string(), nonEmpty),
    expiresAt: isoTimestamp.optional(),
    revokedAt: isoTimestamp.optional(),
    revokedReason: nonEmpty.optional(),
  }).strict().superRefine((grant, ctx) => {
    if (new Set(grant.effectKinds).size !== grant.effectKinds.length) {
      ctx.addIssue({ code: 'custom', message: 'grant effect kinds must be unique' });
    }
    if ((grant.revokedAt === undefined) !== (grant.revokedReason === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'grant revocation requires timestamp and reason' });
    }
  }).optional(),
  preparedWorktreeLease: z.object({
    leaseId: nonEmpty,
    worktreePath: nonEmpty,
    remote: nonEmpty,
    branch: nonEmpty,
    expectedHeadSha: nonEmpty,
    gitCommonDir: nonEmpty,
    createdAt: isoTimestamp,
  }).strict().optional(),
  worktreeLease: z.object({
    leaseId: nonEmpty,
    worktreePath: nonEmpty,
    remote: nonEmpty,
    branch: nonEmpty,
    expectedHeadSha: nonEmpty,
    gitCommonDir: nonEmpty,
    createdAt: isoTimestamp,
    finalizedAt: isoTimestamp,
  }).strict().optional(),
} as const;

const suspendedStateSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('active'),
    observationMode: z.enum(['full', 'terminal_only']),
  }).strict(),
  z.object({
    status: z.literal('actionable'),
    observationMode: z.literal('full'),
    batch: actionBatchSchema,
  }).strict(),
  z.object({
    status: z.literal('blocked'),
    observationMode: z.enum(['full', 'terminal_only']),
    blocker: blockerSchema,
    priorActionableBatch: actionBatchSchema.optional(),
  }).strict(),
]);

const stateSchema = z.discriminatedUnion('status', [
  z.object({ ...commonShape, status: z.literal('active'), observationMode: z.enum(['full', 'terminal_only']), waiter: waiterSchema }).strict(),
  z.object({ ...commonShape, status: z.literal('actionable'), observationMode: z.literal('full'), batch: actionBatchSchema }).strict(),
  z.object({
    ...commonShape,
    status: z.literal('blocked'),
    observationMode: z.enum(['full', 'terminal_only']),
    blocker: blockerSchema,
    currentBlockerSurfaceId: nonEmpty,
    priorActionableBatch: actionBatchSchema.optional(),
  }).strict(),
  z.object({
    ...commonShape,
    status: z.literal('expired'),
    observationMode: z.enum(['full', 'terminal_only']),
    expiredAt: isoTimestamp,
    expiryTransactionId: nonEmpty,
    currentExpirySurfaceId: nonEmpty,
    suspendedState: suspendedStateSchema,
    suspendedStateDigest: sha256,
  }).strict(),
  z.object({
    ...commonShape,
    status: z.literal('terminal'),
    observationMode: z.enum(['full', 'terminal_only']),
    outcome: z.enum(['green', 'all_closed']),
    terminalAt: isoTimestamp,
    terminalFingerprint: nonEmpty,
  }).strict(),
  z.object({
    ...commonShape,
    status: z.literal('cancelled'),
    observationMode: z.enum(['full', 'terminal_only']),
    cancelledAt: isoTimestamp,
  }).strict(),
]).superRefine((state, ctx) => {
  if (state.watchExpiresAt === undefined && state.effectiveConfig.maxWatchAgeDays !== -1) {
    ctx.addIssue({ code: 'custom', message: 'enabled watch age requires a persisted deadline' });
  }
  if (state.watchExpiresAt !== undefined && state.effectiveConfig.maxWatchAgeDays === -1) {
    ctx.addIssue({ code: 'custom', message: 'disabled watch age forbids a deadline' });
  }
  if (state.status === 'expired' && sha256Canonical(state.suspendedState) !== state.suspendedStateDigest) {
    ctx.addIssue({ code: 'custom', message: 'suspended state digest mismatch' });
  }
  if (state.actionGrant && state.actionGrant.maxActionRounds > state.effectiveConfig.maxActionRounds) {
    ctx.addIssue({ code: 'custom', message: 'grant action-round budget exceeds watch ceiling' });
  }
  if (state.actionGrant && state.actionGrant.maxActionableWakes > state.effectiveConfig.maxActionableWakes) {
    ctx.addIssue({ code: 'custom', message: 'grant wake budget exceeds watch ceiling' });
  }
  if (state.preparedWorktreeLease && state.worktreeLease) {
    ctx.addIssue({ code: 'custom', message: 'prepared and finalized worktree leases are mutually exclusive' });
  }
  if (state.actionGrant && !state.worktreeLease) {
    ctx.addIssue({ code: 'custom', message: 'action grant requires a finalized worktree lease' });
  }
  if (state.status === 'blocked') {
    const surface = state.blockerSurfaces.find((entry) => entry.surfaceId === state.currentBlockerSurfaceId);
    if (surface?.kind !== 'blocker' || surface.closedAt !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'blocked state requires its current open blocker surface' });
    }
    if (state.blocker.budgetHandoffProof?.expectedGeneration !== undefined
      && state.blocker.budgetHandoffProof.expectedGeneration !== state.generation) {
      ctx.addIssue({ code: 'custom', message: 'budget proof must bind to current generation' });
    }
    const proof = state.blocker.budgetHandoffProof;
    if (proof !== undefined) {
      const counter = proof.exhaustedKind === 'action_round'
        ? state.actionRoundBudget
        : state.actionableWakeBudget;
      if (sha256Canonical(proof.counter) !== sha256Canonical(counter)) {
        ctx.addIssue({ code: 'custom', message: 'budget proof counter must match live state' });
      }
    }
  }
  if (state.status === 'expired') {
    const surface = state.expirySurfaces.find((entry) => entry.surfaceId === state.currentExpirySurfaceId);
    if (surface?.kind !== 'expiry' || surface.closedAt !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'expired state requires its current open expiry surface' });
    }
  }
});

const checkpointSchema = z.object({
  ledgerSequence: positiveInteger,
  ledgerRecordStartByteOffset: nonNegativeInteger,
  ledgerByteOffset: positiveInteger,
  ledgerDigest: sha256,
}).strict().refine((checkpoint) => (
  checkpoint.ledgerRecordStartByteOffset < checkpoint.ledgerByteOffset
), { message: 'ledger checkpoint record range must be non-empty' });

const cacheSchema = z.object({
  schemaVersion: z.literal(PR_WATCH_SCHEMA_VERSION),
  checkpoint: checkpointSchema,
  state: stateSchema,
}).strict();

const ledgerRecordBaseSchema = z.object({
  schemaVersion: z.literal(PR_WATCH_SCHEMA_VERSION),
  sequence: positiveInteger,
  transactionId: nonEmpty,
  recordedAt: isoTimestamp,
  previousDigest: z.union([z.literal(''), sha256]),
  stateDigest: sha256,
  digest: sha256,
});

const ledgerRecordSchema = z.discriminatedUnion('recordKind', [
  ledgerRecordBaseSchema.extend({
    recordKind: z.literal('state'),
    state: stateSchema,
  }).strict(),
  ledgerRecordBaseSchema.extend({
    recordKind: z.literal('waiter_heartbeat'),
    heartbeat: z.object({
      watchId: nonEmpty,
      generation: positiveInteger,
      watcherActionId: nonEmpty,
      leaseOwnerId: nonEmpty,
      leaseHeartbeatAt: isoTimestamp,
      leaseExpiresAt: isoTimestamp,
      updatedAt: isoTimestamp,
    }).strict(),
  }).strict(),
]);

const initializationSchema = z.object({
  repository: nonEmpty,
  anchorPrNumber: positiveInteger,
  repoRoot: nonEmpty,
  effectiveConfig: effectiveConfigSchema,
  expectedHeads: z.record(z.string(), nonEmpty),
  headUpdateObservedAt: z.record(z.string(), isoTimestamp).optional(),
  providerCapability: z.record(z.string(), z.unknown()).optional(),
  policyEvidence: z.record(z.string(), z.unknown()).optional(),
  watchExpiresAt: isoTimestamp.optional(),
}).strict();

const startIndexSchema = z.discriminatedUnion('status', [
  z.object({
    schemaVersion: z.literal(PR_WATCH_SCHEMA_VERSION),
    status: z.literal('prepared'),
    startKeyDigest: sha256,
    startIntentDigest: sha256,
    watchId: nonEmpty,
    preparedAt: isoTimestamp,
    repoRoot: nonEmpty,
    initializationDigest: sha256,
    initialization: initializationSchema,
  }).strict(),
  z.object({
    schemaVersion: z.literal(PR_WATCH_SCHEMA_VERSION),
    status: z.literal('committed'),
    startKeyDigest: sha256,
    startIntentDigest: sha256,
    watchId: nonEmpty,
    preparedAt: isoTimestamp,
    committedAt: isoTimestamp,
    repoRoot: nonEmpty,
    initializationDigest: sha256,
  }).strict(),
  z.object({
    schemaVersion: z.literal(PR_WATCH_SCHEMA_VERSION),
    status: z.literal('reclaimed'),
    startKeyDigest: sha256,
    startIntentDigest: sha256,
    watchId: nonEmpty,
    reclaimedAt: isoTimestamp,
    priorCommittedAt: isoTimestamp,
    repoRoot: nonEmpty,
    initializationDigest: sha256,
  }).strict(),
]);

export function parsePrWatchState(value: unknown): PrWatchStateV1 {
  return stateSchema.parse(value) as PrWatchStateV1;
}

export function parseSuspendedPrWatchState(value: unknown): SuspendedPrWatchStateV1 {
  return suspendedStateSchema.parse(value) as SuspendedPrWatchStateV1;
}

export function parsePrWatchStateCache(value: unknown): PrWatchStateCacheV1 {
  return cacheSchema.parse(value) as PrWatchStateCacheV1;
}

export function parsePrWatchLedgerRecord(value: unknown): PrWatchLedgerRecordV1 {
  return ledgerRecordSchema.parse(value) as PrWatchLedgerRecordV1;
}

export function parsePrWatchStartIndexRecord(value: unknown): PrWatchStartIndexRecordV1 {
  const parsed = startIndexSchema.parse(value) as PrWatchStartIndexRecordV1;
  parsePrWatchId(parsed.watchId);
  if (parsed.status === 'prepared' && sha256Canonical(parsed.initialization) !== parsed.initializationDigest) {
    throw new Error('pr_watch.start_index_initialization_digest_mismatch');
  }
  return parsed;
}
