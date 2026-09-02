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
  /** GraphQL actor `__typename`: `User`, `Bot`, `Mannequin`, ...; `Unknown` for a deleted author. */
  readonly authorType: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Null until the body has been edited at least once. */
  readonly lastEditedAt: string | null;
  readonly body: string;
}

/** The version identity of a comment: its last body edit, else its creation. */
export function commentVersionTimestamp(comment: {
  readonly createdAt: string;
  readonly lastEditedAt: string | null;
}): string {
  return comment.lastEditedAt ?? comment.createdAt;
}

/**
 * Review bots edit their verdict comment in place rather than posting a new
 * one, so GitHub-App (`Bot`) authors and legacy `[bot]` logins count as
 * review sources without per-watch configuration.
 */
export function isReviewBotAuthor(comment: {
  readonly author: string;
  readonly authorType: string;
}): boolean {
  return comment.authorType === 'Bot' || comment.author.toLowerCase().endsWith('[bot]');
}

/**
 * Which top-level comments can produce a `comment` event for a watch. The
 * same predicate drives evaluation, the change-signal digest, and cache
 * compaction, so a muted bot neither wakes the captain nor dirties its PR.
 */
export interface PrWatchCommentSignalPolicy {
  readonly autoDetectBots: boolean;
  readonly ignoredBots: ReadonlySet<string>;
  readonly verdictAuthors: ReadonlySet<string>;
}

export const DEFAULT_COMMENT_SIGNAL_POLICY: PrWatchCommentSignalPolicy = {
  autoDetectBots: true,
  ignoredBots: new Set(),
  verdictAuthors: new Set(),
};

export function commentCanProduceEvent(
  comment: { readonly author: string; readonly authorType: string },
  policy: PrWatchCommentSignalPolicy,
): boolean {
  const login = comment.author.toLowerCase();
  if (policy.verdictAuthors.has(login)) return true;
  return policy.autoDetectBots && isReviewBotAuthor(comment) && !policy.ignoredBots.has(login);
}

/**
 * Change-signal digests shared by the probe and the snapshot parser. Both
 * must hash exactly the same shape or every PR would look permanently dirty.
 * Only event-capable comments are hashed, so edits by muted or irrelevant
 * authors cost nothing. `truncated` is the connection's own completeness
 * flag for the direction it was read in (`hasPreviousPage` for `last:`,
 * `hasNextPage` for `first:`).
 */
export function commentsSignalDigest(
  comments: readonly {
    readonly id: string;
    readonly createdAt: string;
    readonly lastEditedAt: string | null;
    readonly author: string;
    readonly authorType: string;
  }[],
  truncated: boolean,
  policy: PrWatchCommentSignalPolicy,
): string {
  return sha256Canonical({
    truncated,
    comments: comments
      .filter((comment) => commentCanProduceEvent(comment, policy))
      .map((comment) => [comment.id, commentVersionTimestamp(comment)] as const)
      .sort((left, right) => left[0].localeCompare(right[0])),
  });
}

export function threadsSignalDigest(
  threads: readonly { readonly id: string; readonly isResolved: boolean; readonly isOutdated: boolean }[],
  truncated: boolean,
): string {
  return sha256Canonical({
    truncated,
    threads: threads
      .map((thread) => [thread.id, thread.isResolved, thread.isOutdated] as const)
      .sort((left, right) => left[0].localeCompare(right[0])),
  });
}

export interface PrWatchVerdictSource {
  readonly author: string;
  readonly marker: string;
}

export type GitHubRollupState = 'EXPECTED' | 'ERROR' | 'FAILURE' | 'PENDING' | 'SUCCESS';

/**
 * The scalar fields a cheap probe can read for every watched PR without any
 * connection cost. Two equal signals mean the PR's detailed observation can be
 * reused; any difference marks the PR dirty for a detail fetch.
 */
export interface GitHubPrChangeSignal {
  readonly state: 'OPEN' | 'CLOSED' | 'MERGED';
  readonly updatedAt: string;
  readonly headSha: string;
  readonly baseRefName: string;
  readonly reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  readonly isDraft: boolean;
  readonly rollupState: GitHubRollupState | null;
  /** Digest of every top-level comment's id and edit time; edits do not move `updatedAt`. */
  readonly commentsDigest: string;
  /** Digest of every review thread's id and resolved/outdated flags. */
  readonly threadsDigest: string;
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
  /** Present on every detail-fetched PR; absent on discovery-only rows. */
  readonly changeSignal?: GitHubPrChangeSignal;
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

export interface GitHubProbeObservation {
  readonly repository: string;
  readonly viewer: string;
  readonly observedAt: string;
  readonly signals: Readonly<Record<string, GitHubPrChangeSignal>>;
  readonly queryCost: number;
  readonly rateRemaining: number;
  readonly rateResetAt: string;
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
        number url state headRefName baseRefName headRefOid updatedAt isDraft
        headRepository { nameWithOwner }
        baseRepository { nameWithOwner }
        author { login }
        reviewDecision
        commits(last: 1) { nodes { commit { committedDate } } }
        reviewThreads(first: 100) { pageInfo { hasNextPage } nodes { id isResolved isOutdated comments(last: 1) { nodes { databaseId updatedAt } } } }
        reviews(last: 100) { pageInfo { hasPreviousPage } nodes { id state submittedAt commit { oid } author { login } } }
        comments(last: 100) { pageInfo { hasPreviousPage } nodes { id createdAt updatedAt lastEditedAt author { __typename login } body } }
        commits(last: 1) { nodes { commit { oid statusCheckRollup { state contexts(first: 100) { pageInfo { hasNextPage } nodes {
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

/**
 * Cheap change probe. GitHub prices GraphQL by requested connection calls,
 * so the three flat per-PR connections here (head commit, comment metadata,
 * thread flags) cost about two points for a 50-PR stack, against ~53 for the
 * detail query whose 100 threads each nest a comment lookup. Comment and
 * thread metadata are digested because a comment edit or a thread being
 * unresolved does not move the PR's `updatedAt`. Every field mirrors the
 * snapshot query so both produce identical change signals for the same state.
 */
export function buildGitHubProbeQuery(
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
    throw new Error('pr_watch.invalid_probe_pr_numbers');
  }
  const aliases = prNumbers.map((number, index) => `
      pr${index}: pullRequest(number: ${number}) {
        number state updatedAt headRefOid baseRefName reviewDecision isDraft
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
        comments(last: 100) { pageInfo { hasPreviousPage } nodes { id createdAt lastEditedAt author { __typename login } } }
        reviewThreads(first: 100) { pageInfo { hasNextPage } nodes { id isResolved isOutdated } }
      }`).join('\n');
  const query = `query CrewPrWatchProbe {
    viewer { login }
    rateLimit { cost remaining resetAt }
    repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) {${aliases}
    }
  }`;
  assertReadOnlyGraphql(query);
  return query;
}

export function changeSignalOf(pr: GitHubPullRequestObservation): GitHubPrChangeSignal {
  if (!pr.changeSignal) throw new Error(`pr_watch.change_signal_missing: ${pr.number}`);
  return pr.changeSignal;
}

export function changeSignalsEqual(left: GitHubPrChangeSignal, right: GitHubPrChangeSignal): boolean {
  return left.state === right.state
    && left.updatedAt === right.updatedAt
    && left.headSha === right.headSha
    && left.baseRefName === right.baseRefName
    && left.reviewDecision === right.reviewDecision
    && left.isDraft === right.isDraft
    && left.rollupState === right.rollupState
    && left.commentsDigest === right.commentsDigest
    && left.threadsDigest === right.threadsDigest;
}

export function evaluateGitHubSnapshot(args: {
  readonly snapshot: GitHubSnapshotObservation;
  readonly policy: ResolvedPrWatchPolicyV1;
  readonly approval: PrWatchApprovalPolicy;
  readonly cadenceSeconds: number;
  readonly verdictSources?: readonly PrWatchVerdictSource[];
  /**
   * Expected steady-state cost of one poll. Delta polling passes the
   * amortized probe + refresh + recent-detail figure so a single expensive
   * full refresh never projects as if every poll cost that much. Defaults to
   * the snapshot's own query cost.
   */
  readonly projectedPollCost?: number;
  /**
   * Event ids the ledger has already disposed. A persistent comment (a
   * review bot's verdict, say) is re-observed on every poll; once acked it
   * must not hold the watch out of terminal green forever. A fresh edit is
   * a new id and still blocks until it is disposed.
   */
  readonly disposedEventIds?: ReadonlySet<string>;
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
  const commentPolicy = commentSignalPolicyFor(args.policy.profile.bots, args.verdictSources ?? []);

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
      if (!commentCanProduceEvent(comment, commentPolicy)) continue;
      const verdictMatch = verdictSources.some((source) => (
        source.author === comment.author.toLowerCase()
        && comment.body.includes(source.marker)
      ));
      const botMatch = commentPolicy.autoDetectBots
        && isReviewBotAuthor(comment)
        && !commentPolicy.ignoredBots.has(comment.author.toLowerCase());
      if (verdictMatch || botMatch) {
        const version = commentVersionTimestamp(comment);
        events.push(eventFromIdentity({
          prNumber: pr.number,
          headSha: pr.headSha,
          kind: 'comment',
          providerSourceId: comment.id,
          attempt: commentVersionAttempt(version),
        }, args.snapshot.observedAt, version));
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
  const pollCost = args.projectedPollCost ?? args.snapshot.queryCost;
  if (!Number.isSafeInteger(pollCost) || pollCost < 0) {
    throw new Error('pr_watch.invalid_projected_poll_cost');
  }
  const projectedPointSpend = pollCost
    * Math.ceil(resetSeconds / Math.max(1, args.cadenceSeconds));
  if (projectedPointSpend > Math.floor(args.snapshot.rateRemaining * 0.25)) {
    incomplete.add('github_rate_projection_exceeded');
  }

  const complete = incomplete.size === 0;
  const actionableEvents = dedupeEvents(events);
  const disposed = args.disposedEventIds ?? new Set<string>();
  const undisposedEvents = actionableEvents.filter((event) => !disposed.has(event.id));
  const terminalCandidate = complete && (allClosed || (allGreen && undisposedEvents.length === 0));
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
    actionableEvents,
    terminalCandidate,
    allClosed,
    ...(terminalFingerprint ? { terminalFingerprint } : {}),
    projectedPointSpend,
  };
}

export function commentSignalPolicyFor(
  bots: { readonly autoDetect: boolean; readonly ignore: readonly string[] },
  verdictSources: readonly PrWatchVerdictSource[],
): PrWatchCommentSignalPolicy {
  return {
    autoDetectBots: bots.autoDetect,
    ignoredBots: new Set(bots.ignore.map((login) => login.toLowerCase())),
    verdictAuthors: new Set(verdictSources.map((source) => source.author.toLowerCase())),
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
