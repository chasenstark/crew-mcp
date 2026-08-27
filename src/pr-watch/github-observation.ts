import { sha256Canonical } from './canonical.js';
import type { ResolvedPrWatchPolicyV1 } from './config.js';
import { assertReadOnlyGraphql } from './github-provider.js';
import type { PrWatchEventIdentityV1, PrWatchEventRecordV1 } from './types.js';

export type GitHubCheckConclusion =
  | 'SUCCESS'
  | 'FAILURE'
  | 'CANCELLED'
  | 'TIMED_OUT'
  | 'ACTION_REQUIRED'
  | 'SKIPPED'
  | 'NEUTRAL'
  | null;

export interface GitHubCheckObservation {
  readonly context: string;
  readonly sourceId: string;
  readonly attempt: number;
  readonly status: 'QUEUED' | 'IN_PROGRESS' | 'COMPLETED' | 'EXPECTED';
  readonly conclusion: GitHubCheckConclusion;
}

export interface GitHubReviewObservation {
  readonly id: string;
  readonly author: string;
  readonly state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';
  readonly submittedAt: string;
  readonly commitSha?: string;
}

export interface GitHubThreadObservation {
  readonly id: string;
  readonly isResolved: boolean;
  readonly isOutdated: boolean;
  readonly updatedAt: string;
  readonly lastCommentDatabaseId?: number;
}

export interface GitHubCommentObservation {
  readonly id: string;
  readonly author: string;
  readonly updatedAt: string;
  readonly body: string;
}

export interface PrWatchVerdictSource {
  readonly author: string;
  readonly marker: string;
}

export interface GitHubPullRequestObservation {
  readonly number: number;
  readonly url: string;
  readonly state: 'OPEN' | 'CLOSED' | 'MERGED';
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly headRepository: string;
  readonly baseRepository: string;
  readonly headSha: string;
  readonly headCommittedAt: string;
  readonly author: string;
  readonly reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  readonly checks: readonly GitHubCheckObservation[];
  readonly reviews: readonly GitHubReviewObservation[];
  readonly threads: readonly GitHubThreadObservation[];
  readonly comments: readonly GitHubCommentObservation[];
  readonly paginationComplete: boolean;
  readonly detailsComplete: boolean;
}

export interface GitHubSnapshotObservation {
  readonly repository: string;
  readonly viewer: string;
  readonly observedAt: string;
  readonly prs: readonly GitHubPullRequestObservation[];
  readonly queryCost: number;
  readonly rateRemaining: number;
  readonly rateResetAt: string;
  readonly apiCalls: number;
}

export interface PrWatchApprovalPolicy {
  readonly mode: 'github' | 'reviewer' | 'reviewer_head';
  readonly reviewer?: string;
  readonly goals?: readonly {
    readonly pr: number;
    readonly mode: 'github' | 'reviewer' | 'reviewer_head';
    readonly reviewer?: string;
  }[];
}

export interface GitHubEvaluation {
  readonly complete: boolean;
  readonly incompleteReasons: readonly string[];
  readonly actionableEvents: readonly PrWatchEventRecordV1[];
  readonly terminalCandidate: boolean;
  readonly allClosed: boolean;
  readonly terminalFingerprint?: string;
  readonly projectedPointSpend: number;
}

export interface TerminalStabilityState {
  readonly fingerprint: string;
  readonly firstObservedAt: string;
}

export interface TerminalStabilityResult {
  readonly terminal: boolean;
  readonly next?: TerminalStabilityState;
}

export function discoverLinearPrStack(args: {
  readonly prs: readonly GitHubPullRequestObservation[];
  readonly anchorPrNumber: number;
  readonly repository: string;
  readonly maxPrs: number;
}): readonly GitHubPullRequestObservation[] {
  const open = args.prs.filter((pr) => pr.state === 'OPEN');
  const anchor = open.find((pr) => pr.number === args.anchorPrNumber);
  if (!anchor) throw new Error('pr_watch.anchor_pr_not_open');
  for (const pr of open) {
    if (pr.headRepository !== args.repository || pr.baseRepository !== args.repository) {
      if (pr.number === args.anchorPrNumber) throw new Error('pr_watch.cross_repo_stack');
    }
  }
  const byHead = new Map<string, GitHubPullRequestObservation>();
  for (const pr of open.filter((candidate) =>
    candidate.headRepository === args.repository && candidate.baseRepository === args.repository)) {
    if (byHead.has(pr.headRefName)) throw new Error('pr_watch.duplicate_stack_head');
    byHead.set(pr.headRefName, pr);
  }

  const children = new Map<string, GitHubPullRequestObservation[]>();
  for (const pr of byHead.values()) {
    const list = children.get(pr.baseRefName) ?? [];
    list.push(pr);
    children.set(pr.baseRefName, list);
  }
  const lower: GitHubPullRequestObservation[] = [];
  let cursor: GitHubPullRequestObservation | undefined = anchor;
  const seen = new Set<number>();
  while (cursor) {
    if (seen.has(cursor.number)) throw new Error('pr_watch.stack_cycle');
    seen.add(cursor.number);
    lower.unshift(cursor);
    cursor = byHead.get(cursor.baseRefName);
  }
  cursor = onlyChild(children.get(anchor.headRefName));
  while (cursor) {
    if (seen.has(cursor.number)) throw new Error('pr_watch.stack_cycle');
    seen.add(cursor.number);
    lower.push(cursor);
    cursor = onlyChild(children.get(cursor.headRefName));
  }
  if (lower.length > args.maxPrs) throw new Error('pr_watch.stack_limit_exceeded');
  return lower;
}

function onlyChild(
  candidates: readonly GitHubPullRequestObservation[] | undefined,
): GitHubPullRequestObservation | undefined {
  if ((candidates?.length ?? 0) > 1) throw new Error('pr_watch.ambiguous_stack_children');
  return candidates?.[0];
}

export function buildGitHubSnapshotQuery(
  owner: string,
  repo: string,
  prNumbers: readonly number[],
): string {
  validateRepoPart(owner);
  validateRepoPart(repo);
  if (
    prNumbers.length === 0
    || prNumbers.length > 100
    || new Set(prNumbers).size !== prNumbers.length
    || prNumbers.some((number) => !Number.isSafeInteger(number) || number < 1)
  ) {
    throw new Error('pr_watch.invalid_snapshot_pr_numbers');
  }
  const aliases = prNumbers.map((number, index) => `
      pr${index}: pullRequest(number: ${number}) {
        number url state headRefName baseRefName headRefOid
        headRepository { nameWithOwner }
        baseRepository { nameWithOwner }
        author { login }
        reviewDecision
        commits(last: 1) { nodes { commit { committedDate } } }
        reviewThreads(first: 100) { pageInfo { hasNextPage } nodes { id isResolved isOutdated comments(last: 1) { nodes { databaseId updatedAt } } } }
        reviews(last: 100) { pageInfo { hasNextPage } nodes { id state submittedAt commit { oid } author { login } } }
        comments(last: 100) { pageInfo { hasNextPage } nodes { id updatedAt author { login } body } }
        commits(last: 1) { nodes { commit { oid statusCheckRollup { contexts(first: 100) { pageInfo { hasNextPage } nodes {
          __typename
          ... on CheckRun { id name status conclusion databaseId }
          ... on StatusContext { id context state }
        } } } } } }
      }`).join('\n');
  const query = `query CrewPrWatchSnapshot {
    viewer { login }
    rateLimit { cost remaining resetAt }
    repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) {${aliases}
    }
  }`;
  assertReadOnlyGraphql(query);
  return query;
}

export function evaluateGitHubSnapshot(args: {
  readonly snapshot: GitHubSnapshotObservation;
  readonly policy: ResolvedPrWatchPolicyV1;
  readonly approval: PrWatchApprovalPolicy;
  readonly cadenceSeconds: number;
  readonly verdictSources?: readonly PrWatchVerdictSource[];
}): GitHubEvaluation {
  const incomplete = new Set<string>();
  const events: PrWatchEventRecordV1[] = [];
  const terminalPieces: unknown[] = [];
  let allClosed = args.snapshot.prs.length > 0;
  let allGreen = args.snapshot.prs.length > 0;
  const verdictSources = (args.verdictSources ?? []).map((source) => ({
    author: source.author.toLowerCase(),
    marker: source.marker,
  }));

  if (args.snapshot.prs.length === 0) incomplete.add('stack_empty');
  if (args.snapshot.apiCalls > 3 && args.snapshot.prs.length <= 50) incomplete.add('steady_state_call_budget_exceeded');

  for (const pr of args.snapshot.prs) {
    allClosed &&= pr.state !== 'OPEN';
    if (pr.state === 'CLOSED') {
      allGreen = false;
      events.push(eventFromIdentity({
        prNumber: pr.number,
        headSha: pr.headSha,
        kind: 'pr_closed',
        providerSourceId: `pr:${pr.number}:closed`,
        attempt: 1,
      }, args.snapshot.observedAt));
    }
    if (!pr.paginationComplete) incomplete.add(`pr_${pr.number}:pagination_incomplete`);
    if (!pr.detailsComplete) incomplete.add(`pr_${pr.number}:details_incomplete`);
    const byContext = new Map(pr.checks.map((check) => [check.context, check]));
    for (const check of pr.checks) {
      if (
        check.status === 'COMPLETED'
        && check.conclusion !== 'SUCCESS'
        && check.conclusion !== 'SKIPPED'
        && check.conclusion !== 'NEUTRAL'
      ) {
        allGreen = false;
        events.push(eventFromIdentity({
          prNumber: pr.number,
          headSha: pr.headSha,
          kind: 'check_failure',
          providerSourceId: check.sourceId,
          attempt: check.attempt,
        }, args.snapshot.observedAt));
      }
    }
    if (args.policy.requiredGitHubChecks.length === 0 && !args.policy.allowCheckless && pr.checks.length === 0) {
      incomplete.add(`pr_${pr.number}:expected_checks_unknown`);
    }
    for (const context of args.policy.requiredGitHubChecks) {
      const check = byContext.get(context);
      if (!check) {
        incomplete.add(`pr_${pr.number}:missing_check:${context}`);
        allGreen = false;
        continue;
      }
      if (check.status !== 'COMPLETED') {
        incomplete.add(`pr_${pr.number}:check_pending:${context}`);
        allGreen = false;
      } else if (check.conclusion !== 'SUCCESS') {
        allGreen = false;
      }
    }

    for (const thread of pr.threads) {
      if (!thread.isResolved && !thread.isOutdated) {
        allGreen = false;
        events.push(eventFromIdentity({
          prNumber: pr.number,
          headSha: pr.headSha,
          kind: 'review_thread',
          providerSourceId: thread.id,
          attempt: 1,
        }, args.snapshot.observedAt, thread.updatedAt, thread.lastCommentDatabaseId));
      }
    }
    for (const comment of pr.comments) {
      if (verdictSources.some((source) => (
        source.author === comment.author.toLowerCase()
        && comment.body.includes(source.marker)
      ))) {
        events.push(eventFromIdentity({
          prNumber: pr.number,
          headSha: pr.headSha,
          kind: 'comment',
          providerSourceId: comment.id,
          attempt: commentVersionAttempt(comment.updatedAt),
        }, args.snapshot.observedAt, comment.updatedAt));
      }
    }
    if (pr.state === 'OPEN' && !isApproved(pr, args.approval)) {
      allGreen = false;
      incomplete.add(`pr_${pr.number}:approval_incomplete`);
    }
    terminalPieces.push({
      number: pr.number,
      state: pr.state,
      headSha: pr.headSha,
      headCommittedAt: pr.headCommittedAt,
      checks: args.policy.requiredGitHubChecks.map((context) => byContext.get(context) ?? null),
      reviewDecision: pr.reviewDecision,
    });
  }

  const resetSeconds = Math.max(
    0,
    Math.ceil((Date.parse(args.snapshot.rateResetAt) - Date.parse(args.snapshot.observedAt)) / 1000),
  );
  const projectedPointSpend = args.snapshot.queryCost
    * Math.ceil(resetSeconds / Math.max(1, args.cadenceSeconds));
  if (projectedPointSpend > Math.floor(args.snapshot.rateRemaining * 0.25)) {
    incomplete.add('github_rate_projection_exceeded');
  }

  const complete = incomplete.size === 0;
  const terminalCandidate = complete && (allClosed || (allGreen && events.length === 0));
  const terminalFingerprint = terminalCandidate
    ? sha256Canonical({
      repository: args.snapshot.repository,
      policyHash: args.policy.policyHash,
      provider: 'github',
      allClosed,
      prs: terminalPieces,
    })
    : undefined;
  return {
    complete,
    incompleteReasons: [...incomplete].sort(),
    actionableEvents: dedupeEvents(events),
    terminalCandidate,
    allClosed,
    ...(terminalFingerprint ? { terminalFingerprint } : {}),
    projectedPointSpend,
  };
}

function commentVersionAttempt(updatedAt: string): number {
  const attempt = Date.parse(updatedAt);
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error('pr_watch.invalid_comment_version');
  }
  return attempt;
}

export function evaluateTerminalStability(args: {
  readonly evaluation: GitHubEvaluation;
  readonly previous?: TerminalStabilityState;
  readonly observedAt: string;
  readonly lastHeadUpdateObservedAt: string;
  readonly minimumDwellMs: number;
}): TerminalStabilityResult {
  if (!args.evaluation.terminalCandidate || args.evaluation.terminalFingerprint === undefined) {
    return { terminal: false };
  }
  const current: TerminalStabilityState = {
    fingerprint: args.evaluation.terminalFingerprint,
    firstObservedAt: args.observedAt,
  };
  if (!args.previous || args.previous.fingerprint !== current.fingerprint) {
    return { terminal: false, next: current };
  }
  const observedAt = Date.parse(args.observedAt);
  const stableSince = Math.max(
    Date.parse(args.previous.firstObservedAt),
    Date.parse(args.lastHeadUpdateObservedAt),
  );
  return {
    terminal: observedAt - stableSince >= args.minimumDwellMs,
    next: args.previous,
  };
}

export function nextGithubCadenceMs(args: {
  readonly unchangedCycles: number;
  readonly expectedPushUntil?: string;
  readonly ratePressure: boolean;
  readonly now?: Date;
}): number {
  const now = (args.now ?? new Date()).getTime();
  if (args.ratePressure) return 5 * 60_000;
  if (args.expectedPushUntil && now < Date.parse(args.expectedPushUntil)) return 30_000;
  return Math.min(120_000 + args.unchangedCycles * 10_000, 5 * 60_000);
}

function isApproved(pr: GitHubPullRequestObservation, policy: PrWatchApprovalPolicy): boolean {
  const goal = policy.goals?.find((candidate) => candidate.pr === pr.number);
  if (policy.goals !== undefined && goal === undefined) return true;
  const effective = goal ?? policy;
  if (pr.reviewDecision !== 'APPROVED') return false;
  if (effective.mode === 'github') return true;
  if (!effective.reviewer) return false;
  const reviews = pr.reviews
    .filter((review) => review.author.toLowerCase() === effective.reviewer?.toLowerCase())
    .sort((left, right) => Date.parse(right.submittedAt) - Date.parse(left.submittedAt));
  const latest = reviews[0];
  if (!latest || latest.state !== 'APPROVED') return false;
  return effective.mode !== 'reviewer_head' || latest.commitSha === pr.headSha;
}

function eventFromIdentity(
  identity: PrWatchEventIdentityV1,
  observedAt: string,
  versionTimestamp?: string,
  replyCommentId?: number,
): PrWatchEventRecordV1 {
  return {
    id: sha256Canonical(identity),
    identity,
    firstObservedAt: observedAt,
    lastObservedAt: observedAt,
    ...(versionTimestamp ? { versionTimestamp } : {}),
    ...(replyCommentId !== undefined ? { replyCommentId } : {}),
    fixAttemptCount: 0,
  };
}

function dedupeEvents(events: readonly PrWatchEventRecordV1[]): readonly PrWatchEventRecordV1[] {
  return [...new Map(events.map((event) => [event.id, event])).values()]
    .sort((left, right) => left.id.localeCompare(right.id));
}

function validateRepoPart(value: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value) || value === '.' || value === '..') {
    throw new Error('pr_watch.invalid_repository_identity');
  }
}
