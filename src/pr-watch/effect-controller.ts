import { sha256Canonical } from './canonical.js';
import {
  fetchFreshPrWatchActionAuthority,
  prWatchTopologyHash,
} from './action-authority.js';
import { PrWatchEffectJournal } from './effect-journal.js';
import { fetchGitHubSnapshot } from './github-client.js';
import { GitHubEffectAdapter, githubEffectCommandSpec } from './github-effects.js';
import type { ProviderCommandRunner } from './provider-runner.js';
import { recordEventDispositions, rearmPrWatch, revokePrWatchActions } from './reducer.js';
import { PrWatchStore } from './store.js';
import type {
  PrWatchActionGrantV1,
  PrWatchEffectKind,
  PrWatchEventDisposition,
  PrWatchStateV1,
} from './types.js';
import {
  git,
  PrWatchWorktreeManager,
  pushSingleBranchOutsideHostLock,
} from './action-worktree.js';

export interface ExecutePrWatchEffectInput {
  readonly watchId: string;
  readonly expectedGeneration: number;
  readonly actionBatchId: string;
  readonly eventId: string;
  readonly kind: PrWatchEffectKind;
  readonly target: Readonly<Record<string, string | number>>;
  readonly body?: string;
  readonly disposition?: PrWatchEventDisposition;
  readonly signal?: AbortSignal;
}

export interface ExecutePrWatchEffectResult {
  readonly effectId: string;
  readonly state: PrWatchStateV1;
  readonly remoteMutationApplied: boolean;
  readonly recovered: boolean;
}

export class PrWatchEffectController {
  readonly journal: PrWatchEffectJournal;
  private readonly github: GitHubEffectAdapter;

  constructor(
    readonly store: PrWatchStore,
    private readonly runner: ProviderCommandRunner,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.journal = new PrWatchEffectJournal(store);
    this.github = new GitHubEffectAdapter(runner);
  }

  async execute(input: ExecutePrWatchEffectInput): Promise<ExecutePrWatchEffectResult> {
    const effectId = this.journal.makeEffectId({
      watchId: input.watchId,
      generation: input.expectedGeneration,
      eventId: input.eventId,
      kind: input.kind,
      target: input.target,
    });
    return this.journal.withEffectLock(input.watchId, effectId, async () => {
      try {
        return await this.executeLocked(input, effectId);
      } catch (error) {
        await this.revokeAfterGuardFailure(input.watchId, error);
        throw error;
      }
    });
  }

  private async executeLocked(
    input: ExecutePrWatchEffectInput,
    effectId: string,
  ): Promise<ExecutePrWatchEffectResult> {
    const intentDigest = sha256Canonical({
      body: input.body ?? null,
      target: input.target,
      disposition: input.disposition ?? 'resolved',
    });
    const marker = `<!-- crew-pr-watch-effect:${effectId} -->`;
    const latest = this.journal.latestPhase(input.watchId, effectId);
    if (latest !== undefined && latest.intentDigest !== intentDigest) {
      throw new Error('pr_watch.effect_id_conflict');
    }
    if (latest?.phase === 'settled') {
      return {
        effectId,
        state: this.store.read(input.watchId).state,
        remoteMutationApplied: false,
        recovered: true,
      };
    }
    const receiptKey = sha256Canonical({ kind: 'effect_settle', effectId });
    const currentState = this.store.read(input.watchId).state;
    const settledState = currentState.receipts[receiptKey] !== undefined
      ? currentState
      : this.store.findStateByTransaction(input.watchId, receiptKey);
    if (settledState !== undefined) {
      if (latest?.phase !== 'verified') {
        throw new Error('pr_watch.effect_settle_without_verified_journal');
      }
      await this.journal.append({
        watchId: input.watchId,
        effectId,
        generation: input.expectedGeneration,
        kind: input.kind,
        target: input.target,
        intentDigest,
        marker,
        phase: 'settled',
        evidence: {
          resultingGeneration: settledState.generation,
          status: settledState.status,
          recoveredFromLedger: true,
        },
        now: this.now(),
      });
      return {
        effectId,
        state: settledState,
        remoteMutationApplied: false,
        recovered: true,
      };
    }
    const initial = this.store.read(input.watchId).state;
    assertEffectGuard(initial, input, this.now());
    const recoveringPushHead = input.kind === 'push_single_branch' && latest !== undefined
      ? requiredTargetString(input.target, 'intended_sha')
      : undefined;
    await this.assertRemoteHeadsCurrent(initial, input.signal, recoveringPushHead);
    if (input.kind === 'push_single_branch') {
      requiredTargetString(input.target, 'intended_sha');
    } else {
      githubEffectCommandSpec({
        repository: initial.repository,
        kind: input.kind,
        target: input.target,
        ...(input.body !== undefined ? { body: input.body } : {}),
        marker,
      });
    }
    await this.journal.append({
      watchId: input.watchId,
      effectId,
      generation: input.expectedGeneration,
      kind: input.kind,
      target: input.target,
      intentDigest,
      marker,
      phase: 'prepared',
      now: this.now(),
    });

    let remoteMutationApplied = false;
    if (input.kind === 'push_single_branch') {
      remoteMutationApplied = await this.applyPush(
        input,
        effectId,
        intentDigest,
        marker,
        latest !== undefined,
      );
    } else {
      const request = {
        repository: initial.repository,
        kind: input.kind,
        target: input.target,
        ...(input.body !== undefined ? { body: input.body } : {}),
        marker,
      } as const;
      const alreadyApplied = await this.github.observe(request, input.signal);
      if (!alreadyApplied) {
        await this.journal.append({
          watchId: input.watchId,
          effectId,
          generation: input.expectedGeneration,
          kind: input.kind,
          target: input.target,
          intentDigest,
          marker,
          phase: 'observed_absent',
          now: this.now(),
        });
        try {
          assertEffectGuard(this.store.read(input.watchId).state, input, this.now());
          await this.github.apply(request, input.signal);
          remoteMutationApplied = true;
          await this.journal.append({
            watchId: input.watchId,
            effectId,
            generation: input.expectedGeneration,
            kind: input.kind,
            target: input.target,
            intentDigest,
            marker,
            phase: 'applied',
            now: this.now(),
          });
        } catch (error) {
          await this.journal.append({
            watchId: input.watchId,
            effectId,
            generation: input.expectedGeneration,
            kind: input.kind,
            target: input.target,
            intentDigest,
            marker,
            phase: 'ambiguous',
            evidence: { error: error instanceof Error ? error.message : String(error) },
            now: this.now(),
          });
          throw error;
        }
      }
      if (!await this.github.observe(request, input.signal)) {
        throw new Error('pr_watch.effect_not_observable_after_apply');
      }
      await this.journal.append({
        watchId: input.watchId,
        effectId,
        generation: input.expectedGeneration,
        kind: input.kind,
        target: input.target,
        intentDigest,
        marker,
        phase: 'verified',
        evidence: { marker },
        now: this.now(),
      });
    }

    await this.assertRemoteHeadsCurrent(
      this.store.read(input.watchId).state,
      input.signal,
      input.kind === 'push_single_branch'
        ? requiredTargetString(input.target, 'intended_sha')
        : undefined,
    );
    const state = await this.settle(input, effectId);
    await this.journal.append({
      watchId: input.watchId,
      effectId,
      generation: input.expectedGeneration,
      kind: input.kind,
      target: input.target,
      intentDigest,
      marker,
      phase: 'settled',
      evidence: { resultingGeneration: state.generation, status: state.status },
      now: this.now(),
    });
    return { effectId, state, remoteMutationApplied, recovered: latest !== undefined };
  }

  private async applyPush(
    input: ExecutePrWatchEffectInput,
    effectId: string,
    intentDigest: string,
    marker: string,
    recovering: boolean,
  ): Promise<boolean> {
    const state = this.store.read(input.watchId).state;
    if (Object.keys(state.expectedHeads).length !== 1) {
      throw new Error('pr_watch.multi_pr_branch_mutation_forbidden');
    }
    const intendedSha = requiredTargetString(input.target, 'intended_sha');
    const prNumber = Number(Object.keys(state.expectedHeads)[0]);
    const observedBefore = await this.fetchSinglePrHead(state, prNumber, input.signal);
    const expectedBefore = state.expectedHeads[String(prNumber)];
    if (observedBefore === intendedSha) {
      if (!recovering && observedBefore !== expectedBefore) {
        throw new Error('pr_watch.push_remote_head_changed');
      }
      await this.appendPushVerified(input, effectId, intentDigest, marker, intendedSha);
      return false;
    }
    if (observedBefore !== expectedBefore) throw new Error('pr_watch.push_remote_head_changed');
    await this.journal.append({
      watchId: input.watchId,
      effectId,
      generation: input.expectedGeneration,
      kind: input.kind,
      target: input.target,
      intentDigest,
      marker,
      phase: 'observed_absent',
      evidence: { remoteHead: observedBefore },
      now: this.now(),
    });
    const lease = state.worktreeLease;
    if (!lease) throw new Error('pr_watch.worktree_lease_required');
    const worktrees = new PrWatchWorktreeManager(this.store.crewHome, state.repoRoot);
    let validatedRemoteUrl: string | undefined;
    let pushAttempted = false;
    try {
      await worktrees.withHostMutationExclusion(async (hostSignal) => this.store.withWatchLock(
        input.watchId,
        async () => {
        const current = this.store.read(input.watchId).state;
        assertEffectGuard(current, input, this.now());
        if (current.worktreeLease?.leaseId !== lease.leaseId) {
          throw new Error('pr_watch.worktree_lease_changed');
        }
        const status = await git(lease.worktreePath, ['status', '--porcelain=v2'], hostSignal);
        if (status.trim().length > 0) throw new Error('pr_watch.worktree_lease_dirty');
        const localHead = (await git(lease.worktreePath, ['rev-parse', 'HEAD'], hostSignal)).trim();
        if (localHead !== intendedSha) throw new Error('pr_watch.push_intended_head_not_checked_out');
        try {
          await git(lease.worktreePath, ['merge-base', '--is-ancestor', observedBefore, intendedSha], hostSignal);
        } catch {
          throw new Error('pr_watch.non_fast_forward_push_forbidden');
        }
        const remoteUrl = (await git(
          lease.worktreePath,
          ['remote', 'get-url', lease.remote],
          hostSignal,
        )).trim();
        if (!remoteMatchesRepository(remoteUrl, current.repository)) {
          throw new Error('pr_watch.push_remote_repository_mismatch');
        }
        validatedRemoteUrl = remoteUrl;
        },
      ), input.signal);
      if (validatedRemoteUrl === undefined) {
        throw new Error('pr_watch.push_remote_not_validated');
      }
      pushAttempted = true;
      await pushSingleBranchOutsideHostLock({
        cwd: lease.worktreePath,
        remoteUrl: validatedRemoteUrl,
        branch: lease.branch,
        intendedSha,
        signal: input.signal,
      });
    } catch (error) {
      if (pushAttempted) {
        await this.journal.append({
          watchId: input.watchId,
          effectId,
          generation: input.expectedGeneration,
          kind: input.kind,
          target: input.target,
          intentDigest,
          marker,
          phase: 'ambiguous',
          evidence: { error: error instanceof Error ? error.message : String(error) },
          now: this.now(),
        });
      }
      throw error;
    }
    await this.journal.append({
      watchId: input.watchId,
      effectId,
      generation: input.expectedGeneration,
      kind: input.kind,
      target: input.target,
      intentDigest,
      marker,
      phase: 'applied',
      now: this.now(),
    });
    const observedAfter = await this.fetchSinglePrHead(state, prNumber, input.signal);
    if (observedAfter !== intendedSha) throw new Error('pr_watch.push_result_not_observed');
    await worktrees.withHostMutationExclusion(async (hostSignal) => this.store.withWatchLock(
      input.watchId,
      async () => {
        const current = this.store.read(input.watchId).state;
        assertEffectGuard(current, input, this.now());
        const localHead = (await git(lease.worktreePath, ['rev-parse', 'HEAD'], hostSignal)).trim();
        if (localHead !== intendedSha) throw new Error('pr_watch.push_local_head_changed');
      },
    ), input.signal);
    await this.appendPushVerified(input, effectId, intentDigest, marker, intendedSha);
    return true;
  }

  private async appendPushVerified(
    input: ExecutePrWatchEffectInput,
    effectId: string,
    intentDigest: string,
    marker: string,
    intendedSha: string,
  ): Promise<void> {
    await this.journal.append({
      watchId: input.watchId,
      effectId,
      generation: input.expectedGeneration,
      kind: input.kind,
      target: input.target,
      intentDigest,
      marker,
      phase: 'verified',
      evidence: { remoteHead: intendedSha },
      now: this.now(),
    });
  }

  private async settle(input: ExecutePrWatchEffectInput, effectId: string): Promise<PrWatchStateV1> {
    const receiptKey = sha256Canonical({ kind: 'effect_settle', effectId });
    const existing = this.store.read(input.watchId).state;
    if (existing.receipts[receiptKey]) return existing;
    const verified = this.journal.read(input.watchId).some((record) => (
      record.effectId === effectId && record.phase === 'verified'
    ));
    if (!verified) throw new Error('pr_watch.effect_not_verified');
    const committed = await this.store.mutate(input.watchId, (current) => {
      assertEffectGuard(current, input, this.now());
      const disposed = recordEventDispositions(current, {
        actionBatchId: input.actionBatchId,
        dispositions: {
          [input.eventId]: { disposition: input.disposition ?? 'resolved' },
        },
        now: this.now(),
      }).state;
      const spent = disposed.actionRoundBudget.spent + 1;
      const intendedSha = input.kind === 'push_single_branch'
        ? requiredTargetString(input.target, 'intended_sha')
        : undefined;
      const prNumber = Object.keys(disposed.expectedHeads)[0];
      const updatedHeads = intendedSha
        ? { ...disposed.expectedHeads, [prNumber]: intendedSha }
        : disposed.expectedHeads;
      const updated = {
        ...disposed,
        expectedHeads: updatedHeads,
        actionRoundBudget: { ...disposed.actionRoundBudget, spent },
        ...(disposed.actionGrant ? {
          actionGrant: { ...disposed.actionGrant, observedHeads: updatedHeads },
        } : {}),
        ...(intendedSha && disposed.worktreeLease ? {
          worktreeLease: { ...disposed.worktreeLease, expectedHeadSha: intendedSha },
        } : {}),
      } as PrWatchStateV1;
      if (
        updated.status === 'actionable'
        && updated.batch.eventIds.every((eventId) => updated.events[eventId]?.disposition !== undefined)
      ) {
        return rearmPrWatch(updated, {
          reason: 'disposed_batch',
          expectedGeneration: input.expectedGeneration,
          receiptKey,
          actionBatchId: input.actionBatchId,
          now: this.now(),
        });
      }
      return { state: updated, transactionId: receiptKey };
    });
    return committed.state;
  }

  private async fetchSinglePrHead(
    state: PrWatchStateV1,
    prNumber: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const snapshot = await fetchGitHubSnapshot({
      repository: state.repository,
      prNumbers: [prNumber],
      context: { runner: this.runner, signal: signal ?? new AbortController().signal },
      now: this.now,
    });
    const pr = snapshot.prs[0];
    if (!pr) throw new Error('pr_watch.push_pr_missing');
    return pr.headSha;
  }

  private async assertRemoteHeadsCurrent(
    state: PrWatchStateV1,
    signal?: AbortSignal,
    recoveringPushHead?: string,
  ): Promise<void> {
    await fetchFreshPrWatchActionAuthority({
      state,
      runner: this.runner,
      failureScope: 'action_grant',
      ...(recoveringPushHead !== undefined ? { recoveringPushHead } : {}),
      signal,
      now: this.now,
    });
  }

  private async revokeAfterGuardFailure(watchId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    if (!REVOCATION_FAILURES.some((failure) => message.includes(failure))) return;
    try {
      await this.store.mutate(watchId, (state) => revokePrWatchActions(state, {
        reason: message.slice(0, 500),
        now: this.now(),
      }));
    } catch {
      // Preserve the original guard failure. A concurrent transition may have
      // already replaced or revoked the grant.
    }
  }
}

const REVOCATION_FAILURES = [
  'pr_watch.action_grant_policy_changed',
  'pr_watch.action_grant_topology_changed',
  'pr_watch.action_grant_heads_changed',
  'pr_watch.action_grant_external_heads_changed',
  'pr_watch.action_grant_capability_',
  'pr_watch.action_grant_expired',
  'pr_watch.action_round_budget_exhausted',
  'pr_watch.actionable_wake_budget_exhausted',
  'pr_watch.worktree_lease_required',
  'pr_watch.worktree_lease_changed',
  'pr_watch.worktree_lease_dirty',
  'pr_watch.push_remote_head_changed',
  'pr_watch.push_remote_repository_mismatch',
] as const;

function assertEffectGuard(
  state: PrWatchStateV1,
  input: ExecutePrWatchEffectInput,
  now: Date,
): asserts state is PrWatchStateV1 & { readonly actionGrant: PrWatchActionGrantV1 } {
  if (state.generation !== input.expectedGeneration) throw new Error('pr_watch.stale_generation');
  if (state.status !== 'actionable' || state.batch.actionBatchId !== input.actionBatchId) {
    throw new Error('pr_watch.stale_action_batch');
  }
  if (!state.batch.eventIds.includes(input.eventId) || !state.events[input.eventId]) {
    throw new Error('pr_watch.effect_event_not_in_batch');
  }
  if (state.events[input.eventId].disposition !== undefined) {
    throw new Error('pr_watch.effect_event_already_disposed');
  }
  assertEffectTargetBound(state, input);
  const grant = state.actionGrant;
  if (!grant || grant.revokedAt !== undefined) throw new Error('pr_watch.action_authorization_required');
  if (!grant.effectKinds.includes(input.kind)) throw new Error('pr_watch.effect_kind_not_authorized');
  if (grant.expectedPolicyHash !== state.effectiveConfig.policyHash) {
    throw new Error('pr_watch.action_grant_policy_changed');
  }
  if (grant.expectedTopologyHash !== prWatchTopologyHash(state)) {
    throw new Error('pr_watch.action_grant_topology_changed');
  }
  if (sha256Canonical(grant.observedHeads) !== sha256Canonical(state.expectedHeads)) {
    throw new Error('pr_watch.action_grant_heads_changed');
  }
  if (grant.expiresAt !== undefined && now.getTime() >= Date.parse(grant.expiresAt)) {
    throw new Error('pr_watch.action_grant_expired');
  }
  if (state.watchExpiresAt !== undefined && now.getTime() >= Date.parse(state.watchExpiresAt)) {
    throw new Error('pr_watch.expired');
  }
  if (!state.worktreeLease) throw new Error('pr_watch.worktree_lease_required');
  if (
    state.actionRoundBudget.spent >= state.actionRoundBudget.limit
    || state.actionRoundBudget.spent >= grant.maxActionRounds
  ) {
    throw new Error('pr_watch.action_round_budget_exhausted');
  }
  if (state.actionableWakeBudget.spent > grant.maxActionableWakes) {
    throw new Error('pr_watch.actionable_wake_budget_exhausted');
  }
}

function assertEffectTargetBound(
  state: PrWatchStateV1,
  input: ExecutePrWatchEffectInput,
): void {
  const event = state.events[input.eventId];
  if (!event || state.expectedHeads[String(event.identity.prNumber)] !== event.identity.headSha) {
    throw new Error('pr_watch.effect_target_not_watched');
  }
  if (input.kind === 'push_single_branch') return;
  if (input.kind === 'post_pr_comment') {
    if (requiredTargetNumber(input.target, 'pr') !== event.identity.prNumber) {
      throw new Error('pr_watch.effect_target_event_mismatch');
    }
    return;
  }
  if (input.kind === 'reply_review_comment') {
    if (
      event.identity.kind !== 'review_thread'
      || requiredTargetNumber(input.target, 'pr') !== event.identity.prNumber
      || requiredTargetNumber(input.target, 'comment_id') !== event.replyCommentId
    ) {
      throw new Error('pr_watch.effect_target_event_mismatch');
    }
    return;
  }
  if (
    event.identity.kind !== 'review_thread'
    || requiredTargetString(input.target, 'thread_id') !== event.identity.providerSourceId
  ) {
    throw new Error('pr_watch.effect_target_event_mismatch');
  }
}

function requiredTargetNumber(
  target: Readonly<Record<string, string | number>>,
  key: string,
): number {
  const value = target[key];
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`pr_watch.invalid_effect_target_${key}`);
  }
  return value as number;
}

function requiredTargetString(target: Readonly<Record<string, string | number>>, key: string): string {
  const value = target[key];
  if (typeof value !== 'string' || (key === 'intended_sha'
    ? !/^[0-9a-f]{40}$/.test(value)
    : !/^[A-Za-z0-9._/-]{1,256}$/.test(value))) {
    throw new Error(`pr_watch.invalid_effect_target_${key}`);
  }
  return value;
}

function remoteMatchesRepository(remoteUrl: string, repository: string): boolean {
  const normalized = remoteUrl.replace(/\.git$/, '');
  return normalized.endsWith(`/${repository}`) || normalized.endsWith(`:${repository}`);
}
