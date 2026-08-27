export const PR_WATCH_SCHEMA_VERSION = 1 as const;

export type PrWatchStatus =
  | 'active'
  | 'actionable'
  | 'blocked'
  | 'expired'
  | 'terminal'
  | 'cancelled';

export type PrWatchObservationMode = 'full' | 'terminal_only';
export type PrWatchRemedySurfaceKind = 'blocker' | 'expiry';
export type PrWatchSurfaceDeliveryState = 'pending' | 'claimed' | 'delivered';
export type PrWatchBlockerClass = 'revalidate' | 'non_retryable' | 'restart_required';
export type PrWatchRearmReason =
  | 'disposed_batch'
  | 'timeout'
  | 'stale_waiter'
  | 'budget_exhausted'
  | 'expired'
  | 'blocked_resolved';

export type PrWatchBlockerKind =
  | 'provider_missing'
  | 'provider_version'
  | 'provider_auth'
  | 'provider_scope'
  | 'provider_timeout'
  | 'provider_cancelled'
  | 'policy_changed'
  | 'topology_changed'
  | 'head_changed'
  | 'evidence_incomplete'
  | 'actionable_wake_budget_exhausted'
  | 'action_round_budget_exhausted'
  | 'authorization_required'
  | 'lease_lost'
  | 'corrupt_state';

export type PrWatchEventKind =
  | 'check_failure'
  | 'review_thread'
  | 'comment'
  | 'review'
  | 'pr_closed';

export type PrWatchEventDisposition = 'acknowledged' | 'superseded' | 'deferred' | 'resolved';

export type PrWatchEffectKind =
  | 'push_single_branch'
  | 'reply_review_comment'
  | 'post_pr_comment'
  | 'resolve_review_thread';

export interface PrWatchActionGrantV1 {
  readonly grantId: string;
  readonly grantedAt: string;
  readonly effectKinds: readonly PrWatchEffectKind[];
  readonly maxActionRounds: number;
  readonly maxActionableWakes: number;
  readonly expectedPolicyHash: string;
  readonly expectedTopologyHash: string;
  readonly observedHeads: Readonly<Record<string, string>>;
  readonly expiresAt?: string;
  readonly revokedAt?: string;
  readonly revokedReason?: string;
}

export interface PrWatchWorktreeLeaseV1 {
  readonly leaseId: string;
  readonly worktreePath: string;
  readonly remote: string;
  readonly branch: string;
  readonly expectedHeadSha: string;
  readonly gitCommonDir: string;
  readonly createdAt: string;
  readonly finalizedAt: string;
}

export interface PrWatchPreparedWorktreeLeaseV1 {
  readonly leaseId: string;
  readonly worktreePath: string;
  readonly remote: string;
  readonly branch: string;
  readonly expectedHeadSha: string;
  readonly gitCommonDir: string;
  readonly createdAt: string;
}

export interface PrWatchEffectiveConfigV1 {
  readonly maxPrs: number;
  readonly maxActionableWakes: number;
  readonly maxActionRounds: number;
  readonly maxWatchAgeDays: number;
  readonly policyHash: string;
}

export interface PrWatchEventIdentityV1 {
  readonly prNumber: number;
  readonly headSha: string;
  readonly kind: PrWatchEventKind;
  readonly providerSourceId: string;
  readonly attempt: number;
}

export interface PrWatchEventRecordV1 {
  readonly id: string;
  readonly identity: PrWatchEventIdentityV1;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  readonly versionTimestamp?: string;
  readonly replyCommentId?: number;
  readonly disposition?: PrWatchEventDisposition;
  readonly dispositionNote?: string;
  readonly dispositionAt?: string;
  readonly fixAttemptCount: number;
  readonly supersededByHead?: string;
}

export interface PrWatchActionBatchV1 {
  readonly actionBatchId: string;
  readonly generation: number;
  readonly inclusiveLedgerSequenceWatermark: number;
  readonly eventIds: readonly string[];
  readonly handedOffAt: string;
}

export interface PrWatchBudgetCounterV1 {
  readonly identity: string;
  readonly limit: number;
  readonly spent: number;
}

export interface PrWatchBudgetHandoffProofV1 {
  readonly exhaustedKind: 'actionable_wake' | 'action_round';
  readonly expectedGeneration: number;
  readonly batch: PrWatchActionBatchV1;
  readonly dispositions: Readonly<Record<string, PrWatchEventDisposition>>;
  readonly counter: PrWatchBudgetCounterV1;
  readonly actionGrantId?: string;
}

export interface PrWatchBlockerCauseV1 {
  readonly causeId: string;
  readonly version: number;
  readonly kind: PrWatchBlockerKind;
  readonly class: PrWatchBlockerClass;
  readonly message: string;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly allowedConsumingReasons: readonly PrWatchRearmReason[];
  readonly budgetHandoffProof?: PrWatchBudgetHandoffProofV1;
}

export interface PrWatchRemedySurfaceV1 {
  readonly surfaceId: string;
  readonly kind: PrWatchRemedySurfaceKind;
  readonly generation: number;
  readonly createdAt: string;
  readonly state: PrWatchSurfaceDeliveryState;
  readonly latestClaimAttempt: number;
  readonly claimedByRequestId?: string;
  readonly claimedAt?: string;
  readonly claimLeaseExpiresAt?: string;
  readonly deliveredAt?: string;
  readonly deliveredVia?: 'waiter_wake' | 'jit';
  readonly closedAt?: string;
  readonly closedReason?: string;
  readonly attempts: readonly PrWatchSurfaceAttemptV1[];
}

export interface PrWatchSurfaceAttemptV1 {
  readonly attempt: number;
  readonly requestId: string;
  readonly claimedAt: string;
  readonly outcome?: 'delivered' | 'lease_expired' | 'closed';
  readonly completedAt?: string;
}

export interface PrWatchWaiterActionV1 {
  readonly watcherActionId: string;
  readonly generation: number;
  readonly observationMode: PrWatchObservationMode;
  readonly state: 'pending' | 'running' | 'exited';
  readonly createdAt: string;
  readonly leaseOwnerId?: string;
  readonly leaseHeartbeatAt?: string;
  readonly leaseExpiresAt?: string;
  readonly exitReason?: 'timeout' | 'actionable' | 'terminal' | 'blocked' | 'expired' | 'cancelled';
  readonly exitedAt?: string;
}

export interface PrWatchCommonStateV1 {
  readonly schemaVersion: typeof PR_WATCH_SCHEMA_VERSION;
  readonly watchId: string;
  readonly repoRoot: string;
  readonly repository: string;
  readonly anchorPrNumber: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly generation: number;
  readonly effectiveConfig: PrWatchEffectiveConfigV1;
  readonly watchExpiresAt?: string;
  readonly reverseStartKeyDigest?: string;
  readonly events: Readonly<Record<string, PrWatchEventRecordV1>>;
  readonly expectedHeads: Readonly<Record<string, string>>;
  readonly headUpdateObservedAt?: Readonly<Record<string, string>>;
  readonly providerCapability?: Readonly<Record<string, unknown>>;
  readonly policyEvidence?: Readonly<Record<string, unknown>>;
  readonly terminalStability?: {
    readonly fingerprint: string;
    readonly firstObservedAt: string;
  };
  readonly lastObservation?: {
    readonly observedAt: string;
    readonly complete: boolean;
    readonly incompleteReasons: readonly string[];
    readonly queryCost: number;
    readonly projectedPointSpend: number;
    readonly terminalFingerprint?: string;
  };
  readonly roundCount: number;
  readonly actionableWakeBudget: PrWatchBudgetCounterV1;
  readonly actionRoundBudget: PrWatchBudgetCounterV1;
  readonly blockerSurfaces: readonly PrWatchRemedySurfaceV1[];
  readonly expirySurfaces: readonly PrWatchRemedySurfaceV1[];
  readonly receipts: Readonly<Record<string, PrWatchRearmReceiptV1>>;
  readonly actionGrant?: PrWatchActionGrantV1;
  readonly preparedWorktreeLease?: PrWatchPreparedWorktreeLeaseV1;
  readonly worktreeLease?: PrWatchWorktreeLeaseV1;
}

export interface PrWatchActiveStateV1 extends PrWatchCommonStateV1 {
  readonly status: 'active';
  readonly observationMode: PrWatchObservationMode;
  readonly waiter: PrWatchWaiterActionV1;
}

export interface PrWatchActionableStateV1 extends PrWatchCommonStateV1 {
  readonly status: 'actionable';
  readonly observationMode: 'full';
  readonly batch: PrWatchActionBatchV1;
  readonly waiter?: undefined;
}

export interface PrWatchBlockedStateV1 extends PrWatchCommonStateV1 {
  readonly status: 'blocked';
  readonly observationMode: PrWatchObservationMode;
  readonly blocker: PrWatchBlockerCauseV1;
  readonly currentBlockerSurfaceId: string;
  readonly priorActionableBatch?: PrWatchActionBatchV1;
  readonly waiter?: undefined;
}

export type SuspendedPrWatchStateV1 =
  | {
    readonly status: 'active';
    readonly observationMode: PrWatchObservationMode;
  }
  | {
    readonly status: 'actionable';
    readonly observationMode: 'full';
    readonly batch: PrWatchActionBatchV1;
  }
  | {
    readonly status: 'blocked';
    readonly observationMode: PrWatchObservationMode;
    readonly blocker: PrWatchBlockerCauseV1;
    readonly priorActionableBatch?: PrWatchActionBatchV1;
  };

export interface PrWatchExpiredStateV1 extends PrWatchCommonStateV1 {
  readonly status: 'expired';
  readonly observationMode: PrWatchObservationMode;
  readonly expiredAt: string;
  readonly expiryTransactionId: string;
  readonly currentExpirySurfaceId: string;
  readonly suspendedState: SuspendedPrWatchStateV1;
  readonly suspendedStateDigest: string;
  readonly waiter?: undefined;
}

export interface PrWatchTerminalStateV1 extends PrWatchCommonStateV1 {
  readonly status: 'terminal';
  readonly observationMode: PrWatchObservationMode;
  readonly outcome: 'green' | 'all_closed';
  readonly terminalAt: string;
  readonly terminalFingerprint: string;
  readonly waiter?: undefined;
}

export interface PrWatchCancelledStateV1 extends PrWatchCommonStateV1 {
  readonly status: 'cancelled';
  readonly observationMode: PrWatchObservationMode;
  readonly cancelledAt: string;
  readonly waiter?: undefined;
}

export type PrWatchStateV1 =
  | PrWatchActiveStateV1
  | PrWatchActionableStateV1
  | PrWatchBlockedStateV1
  | PrWatchExpiredStateV1
  | PrWatchTerminalStateV1
  | PrWatchCancelledStateV1;

export interface PrWatchRearmReceiptV1 {
  readonly receiptId: string;
  readonly receiptKey: string;
  readonly reason: PrWatchRearmReason;
  readonly priorGeneration: number;
  readonly generation: number;
  readonly status: PrWatchStatus;
  readonly observationMode: PrWatchObservationMode;
  readonly committedAt: string;
  readonly waiter?: PrWatchWaiterActionV1;
  readonly actionBatchId?: string;
  readonly blockerSurfaceId?: string;
  readonly reboundBudgetHandoffProof?: PrWatchBudgetHandoffProofV1;
}

export interface PrWatchStateCheckpointV1 {
  readonly ledgerSequence: number;
  readonly ledgerRecordStartByteOffset: number;
  readonly ledgerByteOffset: number;
  readonly ledgerDigest: string;
}

export interface PrWatchStateCacheV1 {
  readonly schemaVersion: typeof PR_WATCH_SCHEMA_VERSION;
  readonly checkpoint: PrWatchStateCheckpointV1;
  readonly state: PrWatchStateV1;
}

interface PrWatchLedgerRecordBaseV1 {
  readonly schemaVersion: typeof PR_WATCH_SCHEMA_VERSION;
  readonly sequence: number;
  readonly transactionId: string;
  readonly recordedAt: string;
  readonly previousDigest: string;
  readonly stateDigest: string;
  readonly digest: string;
}

export interface PrWatchStateLedgerRecordV1 extends PrWatchLedgerRecordBaseV1 {
  readonly recordKind: 'state';
  readonly state: PrWatchStateV1;
}

export interface PrWatchWaiterHeartbeatLedgerRecordV1 extends PrWatchLedgerRecordBaseV1 {
  readonly recordKind: 'waiter_heartbeat';
  readonly heartbeat: {
    readonly watchId: string;
    readonly generation: number;
    readonly watcherActionId: string;
    readonly leaseOwnerId: string;
    readonly leaseHeartbeatAt: string;
    readonly leaseExpiresAt: string;
    readonly updatedAt: string;
  };
}

export type PrWatchLedgerRecordV1 =
  | PrWatchStateLedgerRecordV1
  | PrWatchWaiterHeartbeatLedgerRecordV1;

export type PrWatchStartIndexRecordV1 =
  | {
    readonly schemaVersion: typeof PR_WATCH_SCHEMA_VERSION;
    readonly status: 'prepared';
    readonly startKeyDigest: string;
    readonly startIntentDigest: string;
    readonly watchId: string;
    readonly preparedAt: string;
    readonly repoRoot: string;
    readonly initializationDigest: string;
    readonly initialization: PrWatchStartInitializationV1;
  }
  | {
    readonly schemaVersion: typeof PR_WATCH_SCHEMA_VERSION;
    readonly status: 'committed';
    readonly startKeyDigest: string;
    readonly startIntentDigest: string;
    readonly watchId: string;
    readonly preparedAt: string;
    readonly committedAt: string;
    readonly repoRoot: string;
    readonly initializationDigest: string;
  }
  | {
    readonly schemaVersion: typeof PR_WATCH_SCHEMA_VERSION;
    readonly status: 'reclaimed';
    readonly startKeyDigest: string;
    readonly startIntentDigest: string;
    readonly watchId: string;
    readonly reclaimedAt: string;
    readonly priorCommittedAt: string;
    readonly repoRoot: string;
    readonly initializationDigest: string;
  };

export interface PrWatchStartInitializationV1 {
  readonly repository: string;
  readonly anchorPrNumber: number;
  readonly repoRoot: string;
  readonly effectiveConfig: PrWatchEffectiveConfigV1;
  readonly expectedHeads: Readonly<Record<string, string>>;
  readonly headUpdateObservedAt?: Readonly<Record<string, string>>;
  readonly providerCapability?: Readonly<Record<string, unknown>>;
  readonly policyEvidence?: Readonly<Record<string, unknown>>;
  readonly watchExpiresAt?: string;
}
