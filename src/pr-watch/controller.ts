import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';

import { prWatchTopologyFromPrs, prWatchTopologyHash } from './action-authority.js';
import { readConfigFile } from '../utils/config-store.js';
import { sha256Canonical } from './canonical.js';
import type { CircleCiWorkflowEvidence } from './circleci-evidence.js';
import { evaluateCircleCiEvidence } from './circleci-evidence.js';
import { CircleCiCliReader } from './circleci-provider.js';
import {
  defaultProfile,
  loadEffectivePrWatchProfile,
  loadPrWatchProfile,
  resolvePrWatchPolicy,
  type ResolvedPrWatchPolicyV1,
} from './config.js';
import {
  discoverOpenGitHubPullRequests,
  fetchGitHubProbe,
  fetchGitHubRulesBaseline,
  fetchGitHubSnapshot,
  type GitHubClientContext,
} from './github-client.js';
import {
  PR_WATCH_FULL_REFRESH_INTERVAL_MS,
  cacheAfterFullRefresh,
  mergeDeltaObservation,
  planPrWatchObservation,
  readPrWatchObservationCache,
  selectDirtyPrNumbers,
  writePrWatchObservationCache,
  type PrWatchFullRefreshReason,
  type PrWatchObservationCacheV1,
  type PrWatchPollMode,
} from './observation-cache.js';
import {
  commentSignalPolicyFor,
  discoverLinearPrStack,
  evaluateGitHubSnapshot,
  evaluateTerminalStability,
  type GitHubSnapshotObservation,
  type PrWatchApprovalPolicy,
  type PrWatchCommentSignalPolicy,
  type PrWatchVerdictSource,
} from './github-observation.js';
import { detectGhCapability, type GhCapability } from './github-provider.js';
import { hashPrWatchStartKey, parsePrWatchId } from './id.js';
import type { ProviderCommandRunner } from './provider-runner.js';
import {
  createInitialPrWatchState,
  markPrWatchTerminal,
  recordObservedEvents,
  rearmPrWatch,
  revokePrWatchActions,
  supersedeEventsForNewHead,
  transitionToActionable,
  transitionToBlocked,
  tryExpirePrWatch,
} from './reducer.js';
import {
  PR_WATCH_POLL_LOG_DIRTY_LIST_CAP,
  PR_WATCH_POLL_LOG_REASON_CAP,
  appendPrWatchPollLog,
} from './poll-log.js';
import { PrWatchStartIndex } from './start-index.js';
import { PrWatchStore, type AuthoritativePrWatchRead } from './store.js';
import { withPrWatchTransitionDeadline } from './transition-deadline.js';
import type {
  PrWatchBlockerCauseV1,
  PrWatchEventRecordV1,
  PrWatchRearmReceiptV1,
  PrWatchStartInitializationV1,
  PrWatchStateV1,
} from './types.js';

const NOMINAL_CADENCE_MS = 120_000;

export interface PrWatchCircleCiReader {
  read(args: {
    readonly repository: string;
    readonly branch: string;
    readonly headSha: string;
    readonly projectSlug: string;
    readonly requiredWorkflows: readonly string[];
    readonly signal: AbortSignal;
  }): Promise<readonly CircleCiWorkflowEvidence[]>;
}

export interface StartPrWatchInput {
  readonly repoRoot: string;
  readonly repository: string;
  readonly anchorPrNumber: number;
  readonly idempotencyKey: string;
  readonly approval: PrWatchApprovalPolicy;
  readonly scope?: 'single' | 'stack';
  readonly maxPrs?: number;
  readonly policyConfirmationHash?: string;
  readonly verdictSources?: readonly PrWatchVerdictSource[];
  readonly resumeWatchId?: string;
  readonly signal?: AbortSignal;
}

export interface StartPrWatchResult {
  readonly watchId: string;
  readonly state: PrWatchStateV1;
  readonly idempotent: boolean;
  readonly capability: GhCapability;
}

export interface PollPrWatchResult {
  readonly state: PrWatchStateV1;
  readonly queried: boolean;
  readonly evaluation?: ReturnType<typeof evaluateGitHubSnapshot>;
}

interface GitHubObservationResult {
  readonly snapshot: GitHubSnapshotObservation;
  readonly mode: PrWatchPollMode;
  readonly projectedPollCost: number;
  /** In-memory cache after this observation, whether or not it persisted. */
  readonly cache: PrWatchObservationCacheV1;
  /** False when any sidecar write in this poll failed. */
  readonly persisted: boolean;
}

interface GitHubObservationContinuation {
  readonly queryCost: number;
  readonly apiCalls: number;
  readonly cache: PrWatchObservationCacheV1;
  readonly persisted: boolean;
}

export interface RevalidateBlockedPrWatchResult {
  readonly state: PrWatchStateV1;
  readonly receipt: PrWatchRearmReceiptV1;
}

export class PrWatchController {
  private readonly circleci: PrWatchCircleCiReader;

  constructor(
    readonly store: PrWatchStore,
    readonly startIndex: PrWatchStartIndex,
    private readonly runner: ProviderCommandRunner,
    private readonly options: {
      readonly circleci?: PrWatchCircleCiReader;
      readonly now?: () => Date;
      /** Delta-polling full-refresh ceiling; tests shorten it. */
      readonly fullRefreshIntervalMs?: number;
    } = {},
  ) {
    this.circleci = this.options.circleci ?? new CircleCiCliReader(this.runner);
  }

  async start(input: StartPrWatchInput): Promise<StartPrWatchResult> {
    const repoRoot = realpathSync(input.repoRoot);
    if (input.resumeWatchId !== undefined) {
      const watchId = parsePrWatchId(input.resumeWatchId);
      if (!this.store.exists(watchId)) throw new Error('pr_watch.unknown_watch');
      const state = this.store.read(watchId).state;
      if (state.repoRoot !== repoRoot || state.repository !== input.repository) {
        throw new Error('pr_watch.resume_target_mismatch');
      }
      if (input.maxPrs !== undefined && input.maxPrs !== state.effectiveConfig.maxPrs) {
        throw new Error('pr_watch.resume_immutable_config_mismatch');
      }
      return {
        watchId,
        state,
        idempotent: true,
        capability: persistedCapability(state),
      };
    }

    const startKeyDigest = hashPrWatchStartKey({ repoRoot, idempotencyKey: input.idempotencyKey });
    const startIntentDigest = sha256Canonical({
      repoRoot,
      repository: input.repository,
      anchorPrNumber: input.anchorPrNumber,
      approval: input.approval,
      scope: input.scope ?? 'stack',
      maxPrs: input.maxPrs ?? null,
      policyConfirmationHash: input.policyConfirmationHash ?? null,
      verdictSources: input.verdictSources ?? [],
    });
    return this.startIndex.withLock(startKeyDigest, async () => {
      let existing;
      try {
        existing = this.startIndex.read(startKeyDigest);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith('pr_watch.corrupt_start_index:')) {
          throw error;
        }
        this.startIndex.quarantine(startKeyDigest);
        existing = undefined;
      }
      if (existing && existing.startIntentDigest !== startIntentDigest) {
        throw new Error('pr_watch.idempotency_conflict');
      }
      if (existing?.status === 'committed') {
        if (!this.store.exists(existing.watchId)) {
          throw new Error('pr_watch.committed_watch_missing');
        }
        const state = this.store.read(existing.watchId).state;
        return {
          watchId: existing.watchId,
          state,
          idempotent: true,
          capability: persistedCapability(state),
        };
      }
      if (existing?.status === 'reclaimed') {
        this.startIndex.removeReclaimedLocked(startKeyDigest, existing.watchId);
        existing = undefined;
      }

      let prepared: {
        readonly capability: GhCapability;
        readonly initialization: PrWatchStartInitializationV1;
        readonly blocker?: PrWatchBlockerCauseV1;
      };
      if (existing?.status === 'prepared') {
        const capability = existing.initialization.providerCapability as unknown as GhCapability;
        prepared = {
          capability,
          initialization: existing.initialization,
          ...(!capability.ok ? { blocker: capabilityBlocker(capability) } : {}),
        };
      } else {
        const loaded = loadEffectivePrWatchProfile(repoRoot, input.maxPrs);
        const loadedProfile = loaded.profile;
        const effectiveMaxPrs = loadedProfile.limits.maxPrs;
        if (!Number.isSafeInteger(effectiveMaxPrs) || effectiveMaxPrs < 1 || effectiveMaxPrs > 100) {
          throw new Error('pr_watch.invalid_max_prs');
        }
        const profile = loadedProfile;
        const crewConfig = readConfigFile(this.store.crewHome);
        prepared = await withPrWatchTransitionDeadline(async (signal) => {
      const context: GitHubClientContext = { runner: this.runner, signal };
      const capability = await detectGhCapability({ runner: this.runner, signal });
      if (
        capability.blockedReason === 'provider_timeout'
        || capability.blockedReason === 'provider_cancelled'
      ) {
        throw new Error(`pr_watch.start_${capability.blockedReason}`);
      }
      if (!capability.ok) {
        return {
          capability,
          initialization: makeInitialization({
            repoRoot,
            repository: input.repository,
            anchorPrNumber: input.anchorPrNumber,
            maxPrs: profile.limits.maxPrs,
            config: crewConfig.prWatch,
            policyHash: sha256Canonical({
              profile,
              maxPrsSource: loaded.maxPrsSource,
              capability,
            }),
            expectedHeads: {},
            headUpdateObservedAt: {},
            providerCapability: capability as unknown as Readonly<Record<string, unknown>>,
            policyEvidence: {
              profile,
              maxPrsSource: loaded.maxPrsSource,
              approval: input.approval,
              scope: input.scope ?? 'stack',
              verdictSources: input.verdictSources ?? [],
            },
            now: this.now(),
          }),
          blocker: capabilityBlocker(capability),
        };
      }

      const discovered = await discoverOpenGitHubPullRequests({
        repository: input.repository,
        maxPrs: profile.limits.maxPrs,
        context,
      });
      const stack = discoverLinearPrStack({
        prs: discovered,
        anchorPrNumber: input.anchorPrNumber,
        repository: input.repository,
        maxPrs: profile.limits.maxPrs,
      });
      const anchor = stack.find((pr) => pr.number === input.anchorPrNumber);
      let selectedStack = stack;
      if (input.scope === 'single') {
        if (anchor === undefined) {
          throw new Error(`pr_watch.topology_changed: anchor PR #${input.anchorPrNumber} is no longer open`);
        }
        selectedStack = [anchor];
      }
      const rules = await fetchGitHubRulesBaseline({
        repository: input.repository,
        baseBranch: selectedStack[0].baseRefName,
        context,
      });
      const policy = resolvePrWatchPolicy({
        profile,
        maxPrsSource: loaded.maxPrsSource,
        rulesBaseline: rules,
        ...(input.policyConfirmationHash
          ? { confirmationHash: input.policyConfirmationHash }
          : {}),
      });
      const snapshot = await fetchGitHubSnapshot({
        repository: input.repository,
        prNumbers: selectedStack.map((pr) => pr.number),
        context,
        now: () => this.now(),
      });
      const expectedHeads = Object.fromEntries(
        snapshot.prs.map((pr) => [String(pr.number), pr.headSha]),
      );
      const headUpdateObservedAt = Object.fromEntries(
        snapshot.prs.map((pr) => [String(pr.number), snapshot.observedAt]),
      );
      return {
        capability,
        initialization: makeInitialization({
          repoRoot,
          repository: input.repository,
          anchorPrNumber: input.anchorPrNumber,
          maxPrs: profile.limits.maxPrs,
          config: crewConfig.prWatch,
          policyHash: policy.policyHash,
          expectedHeads,
          headUpdateObservedAt,
          providerCapability: capability as unknown as Readonly<Record<string, unknown>>,
          policyEvidence: {
            resolvedPolicy: policy,
            approval: input.approval,
            scope: input.scope ?? 'stack',
            verdictSources: input.verdictSources ?? [],
            topology: prWatchTopologyFromPrs(selectedStack),
          },
          now: this.now(),
        }),
      };
        }, { signal: input.signal });
        existing = this.startIndex.prepareLocked({
          startKeyDigest,
          startIntentDigest,
          initialization: prepared.initialization,
          now: this.now(),
        });
      }

      if (!existing || existing.status !== 'prepared') {
        throw new Error('pr_watch.start_index_missing_preparation');
      }
      const watchId = existing.watchId;
      return this.store.withWatchLock(watchId, async () => {
        if (this.store.exists(watchId)) {
          const recovered = this.store.read(watchId).state;
          this.startIndex.markCommittedLocked(startKeyDigest, watchId, this.now());
          return { watchId, state: recovered, idempotent: true, capability: prepared.capability };
        }

        const active = createInitialPrWatchState({
          watchId,
          initialization: prepared.initialization,
          reverseStartKeyDigest: startKeyDigest,
          now: this.now(),
        });
        const initial = prepared.blocker
          ? transitionToBlocked(active, {
              blocker: prepared.blocker,
              firstObservedSequence: 1,
              now: this.now(),
            })
          : { state: active, transactionId: randomUUID() };
        await this.store.create(initial.state, initial.transactionId);
        this.startIndex.markCommittedLocked(startKeyDigest, watchId, this.now());
        return {
          watchId,
          state: initial.state,
          idempotent: false,
          capability: prepared.capability,
        };
      });
    });
  }

  async pollOnce(
    watchId: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<PollPrWatchResult> {
    const snapshotRead = this.store.read(parsePrWatchId(watchId));
    const snapshotState = snapshotRead.state;
    if (snapshotState.status !== 'active') return { state: snapshotState, queried: false };
    const now = this.now();
    if (
      snapshotState.watchExpiresAt !== undefined
      && now.getTime() >= Date.parse(snapshotState.watchExpiresAt)
    ) {
      const expired = await this.store.mutate(watchId, (state) => tryExpirePrWatch(state, { now }));
      return { state: expired.state, queried: false };
    }
    const evidence = snapshotState.policyEvidence as {
      readonly resolvedPolicy?: ResolvedPrWatchPolicyV1;
      readonly approval?: PrWatchApprovalPolicy;
      readonly verdictSources?: readonly PrWatchVerdictSource[];
    } | undefined;
    const policy = evidence?.resolvedPolicy;
    const approval = evidence?.approval;
    const current = loadEffectivePrWatchProfile(
      snapshotState.repoRoot,
      policy?.maxPrsSource === 'tool' ? snapshotState.effectiveConfig.maxPrs : undefined,
    );
    const currentProfileHash = sha256Canonical(current);
    if (!policy || !approval || currentProfileHash !== policy.profileHash) {
      const blocked = await this.blockIfCurrent(snapshotRead, {
        causeId: 'unbound',
        version: 1,
        kind: 'policy_changed',
        // A watch's policy is snapshotted at start. Revalidation compares the
        // same changed profile and would refuse, so the honest remedy is to
        // cancel this watch and start a new one under the new profile.
        class: 'restart_required',
        message: 'Repository PR-watch profile (.crew/pr-watch.yaml) changed since this watch started; cancel it and start a new watch under the current profile.',
        evidence: { expectedPolicyHash: policy?.profileHash, observedProfileHash: currentProfileHash },
        allowedConsumingReasons: [],
      });
      return { state: blocked, queried: false };
    }

    const pollStartedMs = Date.now();
    let observeMs = 0;
    let forcedRefresh = false;
    const logFailedPoll = (state: PrWatchStateV1, error: unknown): void => {
      appendPrWatchPollLog(this.store.watchDir(watchId), {
        v: 1,
        ts: this.now().toISOString(),
        watchId,
        generation: snapshotState.generation,
        prCount: Object.keys(snapshotState.expectedHeads).length,
        forcedRefresh,
        apiCalls: 0,
        queryCost: 0,
        probeCost: 0,
        detailCost: 0,
        dirtyCount: 0,
        dirtyPrNumbers: [],
        cachePersisted: false,
        projectedPollCost: 0,
        observeMs,
        totalMs: Date.now() - pollStartedMs,
        status: state.status,
        ...(state.status === 'blocked' ? { blockerKind: state.blocker.kind } : {}),
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      });
    };
    let observed: GitHubObservationResult;
    try {
      const observeStartedMs = Date.now();
      observed = await withPrWatchTransitionDeadline(
        (signal) => this.observeGitHub(snapshotState, signal),
        { signal: options.signal },
      );
      observeMs += Date.now() - observeStartedMs;
    } catch (error) {
      observeMs = Date.now() - pollStartedMs;
      const blocked = await this.blockIfCurrent(snapshotRead, providerPollBlocker(error));
      logFailedPoll(blocked, error);
      return { state: blocked, queried: true };
    }
    // Fold every provider into one assessment so the terminal-candidate
    // decision below sees CircleCI's veto before paying for a full re-read.
    const disposedEventIds = new Set(
      Object.values(snapshotState.events)
        .filter((event) => event.disposition !== undefined)
        .map((event) => event.id),
    );
    const assess = async (observation: GitHubObservationResult) => {
      let evaluation = evaluateGitHubSnapshot({
        snapshot: observation.snapshot,
        policy,
        approval,
        cadenceSeconds: NOMINAL_CADENCE_MS / 1000,
        verdictSources: evidence.verdictSources ?? [],
        projectedPollCost: observation.projectedPollCost,
        disposedEventIds,
      });
      const allEvents: PrWatchEventRecordV1[] = [...evaluation.actionableEvents];
      const circleFingerprints: string[] = [];
      const circleci = policy.profile.ci.circleci;
      if (circleci) {
        for (const pr of observation.snapshot.prs) {
          let circleEvidence: readonly CircleCiWorkflowEvidence[];
          try {
            circleEvidence = await withPrWatchTransitionDeadline((signal) =>
              this.circleci.read({
                repository: snapshotState.repository,
                branch: pr.headRefName,
                headSha: pr.headSha,
                projectSlug: circleci.projectSlug ?? `gh/${snapshotState.repository}`,
                requiredWorkflows: circleci.requiredWorkflows,
                signal,
              }), { signal: options.signal });
          } catch (error) {
            evaluation = {
              ...evaluation,
              complete: false,
              terminalCandidate: false,
              incompleteReasons: [
                ...evaluation.incompleteReasons,
                `circleci:provider_error:${providerErrorCode(error)}`,
              ].sort(),
            };
            continue;
          }
          const circle = evaluateCircleCiEvidence({
            prNumber: pr.number,
            headSha: pr.headSha,
            requiredWorkflows: circleci.requiredWorkflows,
            evidence: circleEvidence,
            observedAt: observation.snapshot.observedAt,
          });
          allEvents.push(...circle.actionableEvents);
          circleFingerprints.push(circle.fingerprint);
          if (!circle.complete || !circle.successful) {
            evaluation = {
              ...evaluation,
              complete: false,
              terminalCandidate: false,
              incompleteReasons: [...evaluation.incompleteReasons, ...circle.incompleteReasons].sort(),
            };
          }
        }
      }
      if (evaluation.terminalCandidate && evaluation.terminalFingerprint && circleFingerprints.length > 0) {
        evaluation = {
          ...evaluation,
          terminalFingerprint: sha256Canonical({
            github: evaluation.terminalFingerprint,
            circleci: circleFingerprints,
          }),
        };
      }
      return { evaluation, allEvents };
    };
    let assessed = await assess(observed);
    if (assessed.evaluation.terminalCandidate && observed.mode !== 'full') {
      // A terminal verdict is never certified from cached detail. The probe
      // cannot see every change (it never reads submitted reviews, so a
      // reviewer-goal approval can lapse while reviewDecision stays APPROVED),
      // so any green or all-closed candidate re-reads every PR first.
      // Running after the CircleCI fold means a pending required workflow
      // vetoes the candidate without paying for that re-read every poll.
      forcedRefresh = true;
      try {
        const rereadStartedMs = Date.now();
        observed = await withPrWatchTransitionDeadline(
          (signal) => this.observeGitHub(snapshotState, signal, {
            forceFull: 'terminal_candidate',
            continuation: {
              queryCost: observed.snapshot.queryCost,
              apiCalls: observed.snapshot.apiCalls,
              cache: observed.cache,
              persisted: observed.persisted,
            },
          }),
          { signal: options.signal },
        );
        observeMs += Date.now() - rereadStartedMs;
      } catch (error) {
        const blocked = await this.blockIfCurrent(snapshotRead, providerPollBlocker(error));
        logFailedPoll(blocked, error);
        return { state: blocked, queried: true };
      }
      assessed = await assess(observed);
    }
    let { evaluation } = assessed;
    const { allEvents } = assessed;
    const githubSnapshot = observed.snapshot;

    const committed = await this.store.mutate(watchId, (current, authoritative) => {
      if (
        current.status !== 'active'
        || current.generation !== snapshotState.generation
        || current.effectiveConfig.policyHash !== snapshotState.effectiveConfig.policyHash
      ) {
        throw new Error('pr_watch.poll_snapshot_stale');
      }
      if (current.watchExpiresAt !== undefined && this.now().getTime() >= Date.parse(current.watchExpiresAt)) {
        return tryExpirePrWatch(current, { now: this.now() });
      }
      let next: PrWatchStateV1 = current;
      const headUpdates = { ...(next.headUpdateObservedAt ?? {}) };
      for (const pr of githubSnapshot.prs) {
        const key = String(pr.number);
        if (next.expectedHeads[key] !== pr.headSha) {
          next = supersedeEventsForNewHead(next, {
            prNumber: pr.number,
            headSha: pr.headSha,
            now: new Date(githubSnapshot.observedAt),
          }).state;
          if (next.actionGrant && next.actionGrant.revokedAt === undefined) {
            next = revokePrWatchActions(next, {
              reason: 'pr_watch.action_grant_external_heads_changed',
              now: new Date(githubSnapshot.observedAt),
            }).state;
          }
          headUpdates[key] = githubSnapshot.observedAt;
        }
      }
      next = recordObservedEvents(next, dedupeEvents(allEvents), new Date(githubSnapshot.observedAt)).state;
      const lastHeadUpdate = Object.values(headUpdates).sort().at(-1) ?? githubSnapshot.observedAt;
      const stability = evaluateTerminalStability({
        evaluation,
        previous: next.terminalStability,
        observedAt: githubSnapshot.observedAt,
        lastHeadUpdateObservedAt: lastHeadUpdate,
        minimumDwellMs: NOMINAL_CADENCE_MS,
      });
      const { terminalStability: _priorStability, lastObservation: _priorObservation, ...base } = next;
      next = {
        ...base,
        headUpdateObservedAt: headUpdates,
        ...(stability.next ? { terminalStability: stability.next } : {}),
        lastObservation: {
          observedAt: githubSnapshot.observedAt,
          complete: evaluation.complete,
          incompleteReasons: evaluation.incompleteReasons,
          queryCost: githubSnapshot.queryCost,
          projectedPointSpend: evaluation.projectedPointSpend,
          ...(evaluation.terminalFingerprint
            ? { terminalFingerprint: evaluation.terminalFingerprint }
            : {}),
        },
        updatedAt: githubSnapshot.observedAt,
      } as PrWatchStateV1;
      if (evaluation.incompleteReasons.includes('github_rate_projection_exceeded')) {
        return transitionToBlocked(next, {
          blocker: {
            causeId: 'unbound',
            version: 1,
            kind: 'evidence_incomplete',
            class: 'revalidate',
            message: 'Projected GitHub query spend exceeds the watch budget.',
            evidence: { projectedPointSpend: evaluation.projectedPointSpend },
            allowedConsumingReasons: ['blocked_resolved'],
          },
          firstObservedSequence: authoritative.checkpoint.ledgerSequence + 1,
          now: new Date(githubSnapshot.observedAt),
        });
      }
      if (stability.terminal && evaluation.terminalFingerprint) {
        return markPrWatchTerminal(next, {
          outcome: evaluation.allClosed ? 'all_closed' : 'green',
          fingerprint: evaluation.terminalFingerprint,
          now: new Date(githubSnapshot.observedAt),
        });
      }
      const pendingEventIds = dedupeEvents(allEvents)
        .map((event) => event.id)
        .filter((eventId) => next.events[eventId]?.disposition === undefined);
      if (pendingEventIds.length > 0 && next.observationMode === 'full') {
        return transitionToActionable(next, {
          eventIds: pendingEventIds,
          inclusiveLedgerSequenceWatermark: authoritative.checkpoint.ledgerSequence + 1,
          now: new Date(githubSnapshot.observedAt),
        });
      }
      if (isRepeatedObservationOnly(current, next)) {
        return { state: current, transactionId: randomUUID() };
      }
      return { state: next, transactionId: randomUUID() };
    });
    const lastPoll = observed.cache.lastPoll;
    const dirtyPrNumbers = lastPoll?.dirtyPrNumbers ?? [];
    appendPrWatchPollLog(this.store.watchDir(watchId), {
      v: 1,
      ts: githubSnapshot.observedAt,
      watchId,
      generation: snapshotState.generation,
      prCount: githubSnapshot.prs.length,
      mode: observed.mode,
      ...(lastPoll?.fullRefreshReason !== undefined ? { fullRefreshReason: lastPoll.fullRefreshReason } : {}),
      forcedRefresh,
      apiCalls: githubSnapshot.apiCalls,
      queryCost: githubSnapshot.queryCost,
      probeCost: lastPoll?.probeCost ?? 0,
      detailCost: lastPoll?.detailCost ?? githubSnapshot.queryCost,
      dirtyCount: dirtyPrNumbers.length,
      dirtyPrNumbers: dirtyPrNumbers.slice(0, PR_WATCH_POLL_LOG_DIRTY_LIST_CAP),
      cachePersisted: observed.persisted,
      projectedPollCost: observed.projectedPollCost,
      projectedPointSpend: evaluation.projectedPointSpend,
      rateRemaining: githubSnapshot.rateRemaining,
      rateResetAt: githubSnapshot.rateResetAt,
      observeMs,
      totalMs: Date.now() - pollStartedMs,
      complete: evaluation.complete,
      incompleteReasons: evaluation.incompleteReasons.slice(0, PR_WATCH_POLL_LOG_REASON_CAP),
      eventsObserved: dedupeEvents(allEvents).length,
      eventsPending: Object.values(committed.state.events)
        .filter((event) => event.disposition === undefined).length,
      terminalCandidate: evaluation.terminalCandidate,
      status: committed.state.status,
      ...(committed.state.status === 'blocked' ? { blockerKind: committed.state.blocker.kind } : {}),
    });
    return { state: committed.state, queried: true, evaluation };
  }

  async revalidateBlocked(
    watchId: string,
    args: {
      readonly expectedGeneration: number;
      readonly blockerCauseId: string;
      readonly blockerVersion: number;
      readonly receiptKey: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<RevalidateBlockedPrWatchResult> {
    const snapshot = this.store.read(parsePrWatchId(watchId)).state;
    if (
      snapshot.status !== 'blocked'
      || snapshot.generation !== args.expectedGeneration
      || snapshot.blocker.causeId !== args.blockerCauseId
      || snapshot.blocker.version !== args.blockerVersion
      || snapshot.blocker.class !== 'revalidate'
    ) {
      throw new Error('pr_watch.blocker_not_revalidatable');
    }
    const evidence = snapshot.policyEvidence as {
      readonly resolvedPolicy?: ResolvedPrWatchPolicyV1;
      readonly profile?: ReturnType<typeof loadPrWatchProfile>;
      readonly approval?: PrWatchApprovalPolicy;
      readonly scope?: 'single' | 'stack';
      readonly verdictSources?: readonly PrWatchVerdictSource[];
    } | undefined;
    const persistedPolicy = evidence?.resolvedPolicy;
    const approval = evidence?.approval;
    if (!approval) throw new Error('pr_watch.policy_evidence_missing');

    const revalidated = await withPrWatchTransitionDeadline(async (signal) => {
      const context: GitHubClientContext = { runner: this.runner, signal };
      const capability = await detectGhCapability({ runner: this.runner, signal });
      if (!capability.ok) {
        throw new Error(`pr_watch.revalidation_${capability.blockedReason ?? 'failed'}`);
      }
      const loaded = loadEffectivePrWatchProfile(
        snapshot.repoRoot,
        persistedPolicy?.maxPrsSource === 'tool' ? snapshot.effectiveConfig.maxPrs : undefined,
      );
      const profile = loaded.profile;
      if (persistedPolicy && sha256Canonical(loaded) !== persistedPolicy.profileHash) {
        throw new Error('pr_watch.revalidation_policy_changed');
      }
      const discovered = await discoverOpenGitHubPullRequests({
        repository: snapshot.repository,
        maxPrs: snapshot.effectiveConfig.maxPrs,
        context,
      });
      const discoveredStack = discoverLinearPrStack({
        prs: discovered,
        anchorPrNumber: snapshot.anchorPrNumber,
        repository: snapshot.repository,
        maxPrs: snapshot.effectiveConfig.maxPrs,
      });
      const anchor = discoveredStack.find((pr) => pr.number === snapshot.anchorPrNumber);
      let stack = discoveredStack;
      if (evidence?.scope === 'single') {
        if (anchor === undefined) {
          throw new Error('pr_watch.revalidation_topology_or_head_changed');
        }
        stack = [anchor];
      }
      const observedHeads = Object.fromEntries(stack.map((pr) => [String(pr.number), pr.headSha]));
      if (
        persistedPolicy
        && sha256Canonical(observedHeads) !== sha256Canonical(snapshot.expectedHeads)
      ) {
        throw new Error('pr_watch.revalidation_topology_or_head_changed');
      }
      const topology = prWatchTopologyFromPrs(stack);
      if (
        persistedPolicy
        && sha256Canonical({
          repository: snapshot.repository,
          anchorPrNumber: snapshot.anchorPrNumber,
          topology,
        }) !== prWatchTopologyHash(snapshot)
      ) {
        throw new Error('pr_watch.revalidation_topology_or_head_changed');
      }
      const rules = await fetchGitHubRulesBaseline({
        repository: snapshot.repository,
        baseBranch: stack[0].baseRefName,
        context,
      });
      const currentPolicy = resolvePrWatchPolicy({
        profile,
        maxPrsSource: loaded.maxPrsSource,
        rulesBaseline: rules,
        ...(persistedPolicy ? { confirmationHash: persistedPolicy.comparisonHash } : {}),
      });
      if (persistedPolicy && currentPolicy.policyHash !== snapshot.effectiveConfig.policyHash) {
        throw new Error('pr_watch.revalidation_policy_hash_changed');
      }
      const observedAt = this.now().toISOString();
      return {
        capability,
        policy: currentPolicy,
        topology,
        expectedHeads: observedHeads,
        headUpdateObservedAt: Object.fromEntries(
          Object.keys(observedHeads).map((prNumber) => [prNumber, observedAt]),
        ),
      };
    }, { signal: args.signal });

    const committed = await this.store.mutate(watchId, (current) => {
      const refreshed = {
        ...current,
        providerCapability: revalidated.capability as unknown as Readonly<Record<string, unknown>>,
        policyEvidence: {
          ...evidence,
          resolvedPolicy: revalidated.policy,
          approval,
          scope: evidence?.scope ?? 'stack',
          topology: revalidated.topology,
        },
        expectedHeads: revalidated.expectedHeads,
        headUpdateObservedAt: revalidated.headUpdateObservedAt,
        effectiveConfig: {
          ...current.effectiveConfig,
          policyHash: revalidated.policy.policyHash,
        },
      } as PrWatchStateV1;
      return rearmPrWatch(refreshed, {
        reason: 'blocked_resolved',
        expectedGeneration: args.expectedGeneration,
        receiptKey: args.receiptKey,
        blockerCauseId: args.blockerCauseId,
        blockerVersion: args.blockerVersion,
        revalidationPassed: true,
        now: this.now(),
      });
    });
    const receipt = committed.state.receipts[args.receiptKey];
    if (!receipt) throw new Error('pr_watch.rearm_receipt_missing');
    return { state: committed.state, receipt };
  }

  /**
   * Delta polling. A scalar probe over every watched PR decides which PRs
   * changed since their cached detail observation; only those pay for the
   * full per-PR query. A periodic full refresh bounds anything the probe
   * cannot see. The merged result is shaped exactly like a full snapshot, so
   * evaluation and the reducer are unaware of the cache.
   */
  private async observeGitHub(
    state: PrWatchStateV1,
    signal: AbortSignal,
    options: {
      readonly forceFull?: PrWatchFullRefreshReason;
      /**
       * Spend and cache state from earlier in this same poll. The in-memory
       * cache is authoritative over disk here: a sidecar write that failed
       * moments ago must not be forgotten by re-reading the stale file.
       */
      readonly continuation?: GitHubObservationContinuation;
    } = {},
  ): Promise<GitHubObservationResult> {
    const prNumbers = Object.keys(state.expectedHeads).map(Number).sort((a, b) => a - b);
    const context: GitHubClientContext = { runner: this.runner, signal };
    const watchDir = this.store.watchDir(state.watchId);
    const cadenceSeconds = NOMINAL_CADENCE_MS / 1000;
    const fullRefreshIntervalMs = this.options.fullRefreshIntervalMs ?? PR_WATCH_FULL_REFRESH_INTERVAL_MS;
    const commentPolicy = commentSignalPolicyOf(state);
    const prior = options.continuation
      ? options.continuation.cache
      : readPrWatchObservationCache(watchDir, state.watchId);
    const previouslyPersisted = options.continuation?.persisted ?? true;
    const plan = options.forceFull
      ? { mode: 'full' as const, reason: options.forceFull }
      : planPrWatchObservation({
        cache: prior,
        repository: state.repository,
        now: this.now(),
        fullRefreshIntervalMs,
      });
    if (plan.mode === 'full') {
      const fresh = await fetchGitHubSnapshot({
        repository: state.repository,
        prNumbers,
        context,
        now: () => this.now(),
        commentSignalPolicy: commentPolicy,
      });
      const refreshed = cacheAfterFullRefresh({
        prior,
        watchId: state.watchId,
        snapshot: fresh,
        reason: plan.reason,
        cadenceSeconds,
        fullRefreshIntervalMs,
        commentPolicy,
        ...(options.continuation ? { continuation: options.continuation } : {}),
      });
      // An unpersisted cache means the next poll pays full price again, so
      // the amortized projection would understate spend. Project the actual
      // cost instead; a persistently unwritable cache then trips the gate.
      const persisted = writePrWatchObservationCache(watchDir, refreshed.cache, { detailsChanged: true })
        && previouslyPersisted;
      const snapshot: GitHubSnapshotObservation = options.continuation
        ? {
            ...fresh,
            queryCost: fresh.queryCost + options.continuation.queryCost,
            apiCalls: fresh.apiCalls + options.continuation.apiCalls,
          }
        : fresh;
      return {
        snapshot,
        mode: 'full',
        projectedPollCost: persisted ? refreshed.projectedPollCost : snapshot.queryCost,
        cache: refreshed.cache,
        persisted,
      };
    }
    const probe = await fetchGitHubProbe({
      repository: state.repository,
      prNumbers,
      context,
      now: () => this.now(),
      commentSignalPolicy: commentPolicy,
    });
    const dirtyPrNumbers = selectDirtyPrNumbers({ probe, cache: plan.cache, prNumbers });
    const details = dirtyPrNumbers.length === 0
      ? undefined
      : await fetchGitHubSnapshot({
        repository: state.repository,
        prNumbers: dirtyPrNumbers,
        context,
        now: () => this.now(),
        commentSignalPolicy: commentPolicy,
      });
    const merged = mergeDeltaObservation({
      cache: plan.cache,
      probe,
      details,
      dirtyPrNumbers,
      prNumbers,
      observedAt: (details ?? probe).observedAt,
      cadenceSeconds,
      fullRefreshIntervalMs,
      commentPolicy,
    });
    const persisted = writePrWatchObservationCache(watchDir, merged.cache, {
      detailsChanged: merged.detailsChanged,
    }) && previouslyPersisted;
    return {
      snapshot: merged.snapshot,
      mode: merged.detailsChanged ? 'partial' : 'probe',
      projectedPollCost: persisted ? merged.projectedPollCost : merged.snapshot.queryCost,
      cache: merged.cache,
      persisted,
    };
  }

  private async blockIfCurrent(
    snapshot: AuthoritativePrWatchRead,
    blocker: PrWatchBlockerCauseV1,
  ): Promise<PrWatchStateV1> {
    const result = await this.store.mutate(snapshot.state.watchId, (current, authoritative) => {
      if (current.generation !== snapshot.state.generation || current.status !== 'active') {
        throw new Error('pr_watch.poll_snapshot_stale');
      }
      const guarded = blocker.kind === 'policy_changed'
        && current.actionGrant
        && current.actionGrant.revokedAt === undefined
        ? revokePrWatchActions(current, {
            reason: 'pr_watch.action_grant_policy_changed',
            now: this.now(),
          }).state
        : current;
      return transitionToBlocked(guarded, {
        blocker,
        firstObservedSequence: authoritative.checkpoint.ledgerSequence + 1,
        now: this.now(),
      });
    });
    return result.state;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function isRepeatedObservationOnly(
  prior: PrWatchStateV1,
  next: PrWatchStateV1,
): boolean {
  if (prior.lastObservation === undefined || next.lastObservation === undefined) return false;
  const {
    observedAt: _priorObservedAt,
    queryCost: _priorQueryCost,
    ...priorObservation
  } = prior.lastObservation;
  const {
    observedAt: _nextObservedAt,
    queryCost: _nextQueryCost,
    ...nextObservation
  } = next.lastObservation;
  if (sha256Canonical(priorObservation) !== sha256Canonical(nextObservation)) return false;
  return sha256Canonical({
    ...next,
    updatedAt: prior.updatedAt,
    lastObservation: prior.lastObservation,
  }) === sha256Canonical(prior);
}

function makeInitialization(args: {
  readonly repoRoot: string;
  readonly repository: string;
  readonly anchorPrNumber: number;
  readonly maxPrs: number;
  readonly config: {
    readonly maxActionableWakes: number;
    readonly maxActionRounds: number;
    readonly maxWatchAgeDays: number;
  };
  readonly policyHash: string;
  readonly expectedHeads: Readonly<Record<string, string>>;
  readonly headUpdateObservedAt: Readonly<Record<string, string>>;
  readonly providerCapability: Readonly<Record<string, unknown>>;
  readonly policyEvidence: Readonly<Record<string, unknown>>;
  readonly now: Date;
}): PrWatchStartInitializationV1 {
  return {
    repository: args.repository,
    anchorPrNumber: args.anchorPrNumber,
    repoRoot: args.repoRoot,
    effectiveConfig: {
      maxPrs: args.maxPrs,
      maxActionableWakes: args.config.maxActionableWakes,
      maxActionRounds: args.config.maxActionRounds,
      maxWatchAgeDays: args.config.maxWatchAgeDays,
      policyHash: args.policyHash,
    },
    expectedHeads: args.expectedHeads,
    headUpdateObservedAt: args.headUpdateObservedAt,
    providerCapability: args.providerCapability,
    policyEvidence: args.policyEvidence,
    ...(args.config.maxWatchAgeDays === -1
      ? {}
      : { watchExpiresAt: new Date(
        args.now.getTime() + args.config.maxWatchAgeDays * 86_400_000,
      ).toISOString() }),
  };
}

function capabilityBlocker(capability: GhCapability): PrWatchBlockerCauseV1 {
  const kind = capability.blockedReason;
  if (!kind) throw new Error('pr_watch.invalid_capability_blocker');
  return {
    causeId: 'unbound',
    version: 1,
    kind,
    class: 'revalidate',
    message: capability.detail ?? `GitHub capability blocked: ${kind}`,
    evidence: capability as unknown as Readonly<Record<string, unknown>>,
    allowedConsumingReasons: ['blocked_resolved'],
  };
}

function providerPollBlocker(error: unknown): PrWatchBlockerCauseV1 {
  const message = error instanceof Error ? error.message : String(error);
  const kind = message.includes('cancel') ? 'provider_cancelled'
    : message.includes('timeout') ? 'provider_timeout'
      : 'evidence_incomplete';
  return {
    causeId: 'unbound',
    version: 1,
    kind,
    class: 'revalidate',
    message,
    evidence: {},
    allowedConsumingReasons: ['blocked_resolved'],
  };
}

function providerErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('cancel')) return 'cancelled';
  if (message.includes('timeout')) return 'timeout';
  if (message.includes('auth') || message.includes('unauthorized')) return 'auth';
  if (message.includes('scope') || message.includes('forbidden')) return 'scope';
  if (message.includes('json') || message.includes('shape')) return 'malformed';
  return 'unavailable';
}

/**
 * The watch's comment policy: its immutable verdict sources plus the
 * repository profile's review-bot settings, both persisted at start. The
 * same policy shapes the probe digest, evaluation, and cache compaction, so
 * a compacted cache stays evaluation-equivalent.
 */
function commentSignalPolicyOf(state: PrWatchStateV1): PrWatchCommentSignalPolicy {
  const evidence = state.policyEvidence as {
    readonly resolvedPolicy?: ResolvedPrWatchPolicyV1;
    readonly verdictSources?: readonly PrWatchVerdictSource[];
  } | undefined;
  const bots = evidence?.resolvedPolicy?.profile.bots ?? defaultProfile().bots;
  return commentSignalPolicyFor(bots, evidence?.verdictSources ?? []);
}

function persistedCapability(state: PrWatchStateV1): GhCapability {
  return (state.providerCapability ?? {
    ok: false,
    hostname: 'github.com',
    scopes: [],
    blockedReason: 'provider_missing',
  }) as unknown as GhCapability;
}

function dedupeEvents(events: readonly PrWatchEventRecordV1[]): readonly PrWatchEventRecordV1[] {
  return [...new Map(events.map((event) => [event.id, event])).values()];
}
