import { sha256Canonical } from './canonical.js';
import {
  fetchFreshPrWatchActionAuthority,
  prWatchTopologyHash,
} from './action-authority.js';
import type { ProviderCommandRunner } from './provider-runner.js';
import {
  authorizePrWatchActions,
  preparePrWatchWorktreeLease,
  revokePrWatchActions,
  transitionToBlocked,
} from './reducer.js';
import { PrWatchStore } from './store.js';
import type {
  PrWatchActionGrantV1,
  PrWatchEffectKind,
  PrWatchStateV1,
} from './types.js';
import { PrWatchWorktreeManager } from './action-worktree.js';

export interface AuthorizePrWatchActionsInput {
  readonly watchId: string;
  readonly expectedGeneration: number;
  readonly expectedPolicyHash: string;
  readonly expectedTopologyHash: string;
  readonly effectKinds: readonly PrWatchEffectKind[];
  readonly maxActionRounds: number;
  readonly maxActionableWakes: number;
  readonly expiresAt?: string;
  readonly confirmed: true;
  readonly signal?: AbortSignal;
}

export class PrWatchActionBlockedError extends Error {
  constructor(readonly state: PrWatchStateV1) {
    super('pr_watch.action_authorization_blocked');
    this.name = 'PrWatchActionBlockedError';
  }
}

export class PrWatchActionController {
  constructor(
    readonly store: PrWatchStore,
    private readonly runner: ProviderCommandRunner,
    private readonly now: () => Date = () => new Date(),
    private readonly worktreeManagerFactory: (
      crewHome: string,
      repoRoot: string,
    ) => PrWatchWorktreeManager = (crewHome, repoRoot) => (
      new PrWatchWorktreeManager(crewHome, repoRoot)
    ),
  ) {}

  async authorize(input: AuthorizePrWatchActionsInput): Promise<{
    readonly state: PrWatchStateV1;
    readonly grant: PrWatchActionGrantV1;
  }> {
    if (input.confirmed !== true) throw new Error('pr_watch.authorization_confirmation_required');
    const snapshotState = this.store.read(input.watchId).state;
    const prNumbers = Object.keys(snapshotState.expectedHeads).map(Number).sort((a, b) => a - b);
    if (prNumbers.length === 0) throw new Error('pr_watch.authorization_topology_uninitialized');
    const topologyHash = prWatchTopologyHash(snapshotState);
    if (topologyHash !== input.expectedTopologyHash) {
      throw new Error('pr_watch.authorization_topology_changed');
    }
    if (snapshotState.effectiveConfig.policyHash !== input.expectedPolicyHash) {
      throw new Error('pr_watch.authorization_policy_changed');
    }
    const remote = await fetchFreshPrWatchActionAuthority({
      state: snapshotState,
      runner: this.runner,
      failureScope: 'authorization',
      signal: input.signal,
      now: this.now,
    });
    const observedHeads = remote.observedHeads;
    const anchor = remote.anchor;

    const worktrees = this.worktreeManagerFactory(this.store.crewHome, snapshotState.repoRoot);
    return worktrees.withHostMutationExclusion(async (hostSignal) => this.store.withWatchLock(
      input.watchId,
      async () => {
        let current = this.store.read(input.watchId).state;
        if (
          current.generation !== snapshotState.generation
          || sha256Canonical(current.expectedHeads) !== sha256Canonical(observedHeads)
        ) {
          throw new Error('pr_watch.authorization_snapshot_stale');
        }
        if (hostSignal.aborted) throw new Error('pr_watch.authorization_cancelled');
        if (current.worktreeLease === undefined) {
          const preparedLease = await worktrees.prepareLeaseInsideHostLock({
            state: current,
            branch: anchor.headRefName,
            headSha: anchor.headSha,
            signal: hostSignal,
            now: this.now(),
          });
          current = this.store.mutateLocked(input.watchId, (locked) =>
            preparePrWatchWorktreeLease(locked, preparedLease, this.now())).state;
        }
        let lease;
        try {
          lease = await worktrees.ensureLeaseInsideHostLock({
            state: current,
            branch: anchor.headRefName,
            headSha: anchor.headSha,
            signal: hostSignal,
            now: this.now(),
          });
        } catch (error) {
          if (!current.preparedWorktreeLease) throw error;
          const retryable = isPreparedLeaseRetryableError(error);
          if (!retryable && !isPreparedLeaseRecoveryError(error)) throw error;
          const prepared = current.preparedWorktreeLease;
          const message = error instanceof Error ? error.message : String(error);
          const blocked = this.store.mutateLocked(input.watchId, (locked, read) => transitionToBlocked(
            locked,
            {
              blocker: {
                causeId: sha256Canonical({
                  watchId: locked.watchId,
                  kind: 'lease_lost',
                  subject: prepared.worktreePath,
                  firstObservedSequence: read.checkpoint.ledgerSequence + 1,
                }),
                version: 1,
                kind: 'lease_lost',
                class: retryable ? 'revalidate' : 'restart_required',
                message: retryable
                  ? 'Action-worktree provisioning timed out or was cancelled before finalization; revalidate and retry the same prepared lease.'
                  : 'The prepared action worktree could not be finalized safely; inspect it and start a new watch.',
                evidence: {
                  subject: prepared.worktreePath,
                  worktreePath: prepared.worktreePath,
                  leaseId: prepared.leaseId,
                  error: message,
                },
                allowedConsumingReasons: retryable ? ['blocked_resolved'] : [],
              },
              firstObservedSequence: read.checkpoint.ledgerSequence + 1,
              now: this.now(),
            },
          ));
          throw new PrWatchActionBlockedError(blocked.state);
        }
        const committed = this.store.mutateLocked(input.watchId, (locked) => authorizePrWatchActions(
          locked,
          {
            expectedGeneration: input.expectedGeneration,
            effectKinds: input.effectKinds,
            maxActionRounds: input.maxActionRounds,
            maxActionableWakes: input.maxActionableWakes,
            expectedPolicyHash: input.expectedPolicyHash,
            expectedTopologyHash: input.expectedTopologyHash,
            observedHeads,
            worktreeLease: lease,
            ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
            now: this.now(),
          },
        ));
        if (!committed.state.actionGrant) throw new Error('pr_watch.authorization_grant_missing');
        return { state: committed.state, grant: committed.state.actionGrant };
      },
    ), input.signal);
  }

  async revoke(watchId: string, reason = 'user_revoked'): Promise<PrWatchStateV1> {
    const committed = await this.store.mutate(watchId, (state) => revokePrWatchActions(
      state,
      { reason, now: this.now() },
    ));
    return committed.state;
  }
}

function isPreparedLeaseRecoveryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('pr_watch.git_failed')
    || message.includes('pr_watch.worktree_lease_dirty')
    || message.includes('pr_watch.worktree_lease_missing');
}

function isPreparedLeaseRetryableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('pr_watch.git_timeout')
    || message.includes('pr_watch.git_cancelled');
}

export { prWatchTopologyHash } from './action-authority.js';
