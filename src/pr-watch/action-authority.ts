import { sha256Canonical } from './canonical.js';
import {
  loadEffectivePrWatchProfile,
  resolvePrWatchPolicy,
  type ResolvedPrWatchPolicyV1,
} from './config.js';
import {
  discoverOpenGitHubPullRequests,
  fetchGitHubRulesBaseline,
  fetchGitHubSnapshot,
} from './github-client.js';
import {
  discoverLinearPrStack,
  type GitHubPullRequestObservation,
} from './github-observation.js';
import { detectGhCapability } from './github-provider.js';
import type { ProviderCommandRunner } from './provider-runner.js';
import { withPrWatchTransitionDeadline } from './transition-deadline.js';
import type { PrWatchStateV1 } from './types.js';

export interface PrWatchTopologyEntryV1 {
  readonly number: number;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly headRepository: string;
  readonly baseRepository: string;
}

export interface FreshPrWatchActionAuthority {
  readonly anchor: GitHubPullRequestObservation;
  readonly observedHeads: Readonly<Record<string, string>>;
  readonly topology: readonly PrWatchTopologyEntryV1[];
  readonly topologyHash: string;
}

export function prWatchTopologyFromPrs(
  prs: readonly GitHubPullRequestObservation[],
): readonly PrWatchTopologyEntryV1[] {
  return prs.map((pr) => ({
    number: pr.number,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    headRepository: pr.headRepository,
    baseRepository: pr.baseRepository,
  }));
}

export function prWatchTopologyHash(state: PrWatchStateV1): string {
  const rawTopology = (state.policyEvidence as { readonly topology?: unknown } | undefined)?.topology;
  if (rawTopology === undefined) {
    return sha256Canonical({
      repository: state.repository,
      anchorPrNumber: state.anchorPrNumber,
      watchedPrNumbers: Object.keys(state.expectedHeads).map(Number).sort((left, right) => left - right),
    });
  }
  const topology = parseTopology(rawTopology);
  return topologyHash(state.repository, state.anchorPrNumber, topology);
}

export async function fetchFreshPrWatchActionAuthority(args: {
  readonly state: PrWatchStateV1;
  readonly runner: ProviderCommandRunner;
  readonly failureScope: 'authorization' | 'action_grant';
  readonly recoveringPushHead?: string;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}): Promise<FreshPrWatchActionAuthority> {
  const persisted = readPolicyEvidence(args.state);
  return withPrWatchTransitionDeadline(async (signal) => {
    const context = { runner: args.runner, signal };
    const capability = await detectGhCapability(context);
    if (!capability.ok) {
      throw failure(
        args.failureScope,
        `capability_${capability.blockedReason ?? 'failed'}`,
      );
    }
    let loaded;
    try {
      loaded = loadEffectivePrWatchProfile(
        args.state.repoRoot,
        persisted.resolvedPolicy.maxPrsSource === 'tool'
          ? args.state.effectiveConfig.maxPrs
          : undefined,
      );
    } catch {
      throw failure(args.failureScope, 'policy_changed');
    }
    if (sha256Canonical(loaded) !== persisted.resolvedPolicy.profileHash) {
      throw failure(args.failureScope, 'policy_changed');
    }
    const profile = loaded.profile;
    const discovered = await discoverOpenGitHubPullRequests({
      repository: args.state.repository,
      maxPrs: args.state.effectiveConfig.maxPrs,
      context,
    });
    let discoveredStack;
    try {
      discoveredStack = discoverLinearPrStack({
        prs: discovered,
        anchorPrNumber: args.state.anchorPrNumber,
        repository: args.state.repository,
        maxPrs: args.state.effectiveConfig.maxPrs,
      });
    } catch {
      throw failure(args.failureScope, 'topology_changed');
    }
    const anchor = discoveredStack.find((pr) => pr.number === args.state.anchorPrNumber);
    if (!anchor) throw failure(args.failureScope, 'topology_changed');
    const stack = persisted.scope === 'single' ? [anchor] : discoveredStack;
    const topology = prWatchTopologyFromPrs(stack);
    const currentTopologyHash = topologyHash(
      args.state.repository,
      args.state.anchorPrNumber,
      topology,
    );
    if (currentTopologyHash !== prWatchTopologyHash(args.state)) {
      throw failure(args.failureScope, 'topology_changed');
    }
    const rules = await fetchGitHubRulesBaseline({
      repository: args.state.repository,
      baseBranch: stack[0].baseRefName,
      context,
    });
    let currentPolicy;
    try {
      currentPolicy = resolvePrWatchPolicy({
        profile,
        maxPrsSource: loaded.maxPrsSource,
        rulesBaseline: rules,
        confirmationHash: persisted.resolvedPolicy.comparisonHash,
      });
    } catch {
      throw failure(args.failureScope, 'policy_changed');
    }
    if (currentPolicy.policyHash !== args.state.effectiveConfig.policyHash) {
      throw failure(args.failureScope, 'policy_changed');
    }
    const snapshot = await fetchGitHubSnapshot({
      repository: args.state.repository,
      prNumbers: stack.map((pr) => pr.number),
      context,
      now: args.now,
    });
    const observedHeads = Object.fromEntries(
      snapshot.prs.map((pr) => [String(pr.number), pr.headSha]),
    );
    const permittedHeads = args.recoveringPushHead === undefined
      ? args.state.expectedHeads
      : {
          ...args.state.expectedHeads,
          [String(args.state.anchorPrNumber)]: args.recoveringPushHead,
        };
    if (
      sha256Canonical(observedHeads) !== sha256Canonical(args.state.expectedHeads)
      && sha256Canonical(observedHeads) !== sha256Canonical(permittedHeads)
    ) {
      throw failure(args.failureScope, 'external_heads_changed');
    }
    const snapshotAnchor = snapshot.prs.find((pr) => pr.number === args.state.anchorPrNumber);
    if (
      !snapshotAnchor
      || snapshotAnchor.state !== 'OPEN'
      || (args.state.worktreeLease
        && snapshotAnchor.headRefName !== args.state.worktreeLease.branch)
    ) {
      throw failure(args.failureScope, 'topology_changed');
    }
    return { anchor: snapshotAnchor, observedHeads, topology, topologyHash: currentTopologyHash };
  }, { signal: args.signal, timeoutMs: 30_000 });
}

function readPolicyEvidence(state: PrWatchStateV1): {
  readonly resolvedPolicy: ResolvedPrWatchPolicyV1;
  readonly scope: 'single' | 'stack';
  readonly topology: readonly PrWatchTopologyEntryV1[];
} {
  const evidence = state.policyEvidence as {
    readonly resolvedPolicy?: ResolvedPrWatchPolicyV1;
    readonly scope?: 'single' | 'stack';
    readonly topology?: unknown;
  } | undefined;
  if (!evidence?.resolvedPolicy || !evidence.scope) {
    throw new Error('pr_watch.action_authority_policy_uninitialized');
  }
  return {
    resolvedPolicy: evidence.resolvedPolicy,
    scope: evidence.scope,
    topology: parseTopology(evidence.topology),
  };
}

function parseTopology(value: unknown): readonly PrWatchTopologyEntryV1[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new Error('pr_watch.action_authority_topology_uninitialized');
  }
  const numbers = new Set<number>();
  return value.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('pr_watch.action_authority_topology_invalid');
    }
    const row = entry as Record<string, unknown>;
    const number = row.number;
    if (!Number.isSafeInteger(number) || (number as number) < 1 || numbers.has(number as number)) {
      throw new Error('pr_watch.action_authority_topology_invalid');
    }
    numbers.add(number as number);
    for (const key of ['headRefName', 'baseRefName', 'headRepository', 'baseRepository']) {
      if (typeof row[key] !== 'string' || row[key].length === 0 || row[key].length > 256) {
        throw new Error('pr_watch.action_authority_topology_invalid');
      }
    }
    return {
      number: number as number,
      headRefName: row.headRefName as string,
      baseRefName: row.baseRefName as string,
      headRepository: row.headRepository as string,
      baseRepository: row.baseRepository as string,
    };
  });
}

function topologyHash(
  repository: string,
  anchorPrNumber: number,
  topology: readonly PrWatchTopologyEntryV1[],
): string {
  return sha256Canonical({ repository, anchorPrNumber, topology });
}

function failure(scope: 'authorization' | 'action_grant', reason: string): Error {
  return new Error(`pr_watch.${scope}_${reason}`);
}
