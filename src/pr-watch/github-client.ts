import type { GitHubRulesBaseline } from './config.js';
import {
  buildGitHubSnapshotQuery,
  type GitHubCheckConclusion,
  type GitHubPullRequestObservation,
  type GitHubSnapshotObservation,
} from './github-observation.js';
import { runGitHubReadCommand } from './github-provider.js';
import type { ProviderCommandRunner } from './provider-runner.js';

export interface GitHubClientContext {
  readonly runner: ProviderCommandRunner;
  readonly hostname?: string;
  readonly binary?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export async function discoverOpenGitHubPullRequests(args: {
  readonly repository: string;
  readonly maxPrs: number;
  readonly context: GitHubClientContext;
}): Promise<readonly GitHubPullRequestObservation[]> {
  const [owner, repo] = splitRepository(args.repository);
  const query = `query CrewPrWatchDiscovery($cursor: String) {
    repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) {
      pullRequests(first: 100, after: $cursor, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number url state headRefName baseRefName headRefOid
          headRepository { nameWithOwner }
          baseRepository { nameWithOwner }
          author { login }
          reviewDecision
          commits(last: 1) { nodes { commit { committedDate } } }
        }
      }
    }
  }`;
  const prs = new Map<number, GitHubPullRequestObservation>();
  let cursor: string | undefined;
  for (let page = 1; page <= 20; page += 1) {
    const result = await runGitHubReadCommand({
      kind: 'graphql',
      hostname: args.context.hostname ?? 'github.com',
      document: query,
      ...(cursor !== undefined ? { variables: { cursor } } : {}),
    }, args.context);
    const data = parseGraphqlEnvelope(result.stdout);
    const repository = objectField(data, 'repository');
    const connection = objectField(repository, 'pullRequests');
    for (const value of arrayField(connection, 'nodes')) {
      const pr = parseDiscoveryPr(value, args.repository);
      if (prs.has(pr.number)) throw new Error('pr_watch.discovery_duplicate_pr');
      prs.set(pr.number, pr);
    }
    const pageInfo = objectField(connection, 'pageInfo');
    if (pageInfo.hasNextPage !== true) return [...prs.values()];
    if (typeof pageInfo.endCursor !== 'string' || pageInfo.endCursor.length === 0) {
      throw new Error('pr_watch.discovery_pagination_incomplete');
    }
    cursor = pageInfo.endCursor;
  }
  throw new Error('pr_watch.discovery_page_limit_exceeded');
}

export async function fetchGitHubSnapshot(args: {
  readonly repository: string;
  readonly prNumbers: readonly number[];
  readonly context: GitHubClientContext;
  readonly now?: () => Date;
}): Promise<GitHubSnapshotObservation> {
  const [owner, repo] = splitRepository(args.repository);
  const query = buildGitHubSnapshotQuery(owner, repo, args.prNumbers);
  const result = await runGitHubReadCommand({
    kind: 'graphql',
    hostname: args.context.hostname ?? 'github.com',
    document: query,
  }, args.context);
  const envelope = JSON.parse(result.stdout) as unknown;
  const root = asRecord(envelope, 'GitHub response');
  if (Array.isArray(root.errors) && root.errors.length > 0) {
    throw new Error(`pr_watch.github_graphql_error: ${JSON.stringify(root.errors).slice(0, 2000)}`);
  }
  const data = asRecord(root.data, 'GitHub data');
  const repository = objectField(data, 'repository');
  const viewer = stringField(objectField(data, 'viewer'), 'login');
  const rateLimit = objectField(data, 'rateLimit');
  const observedAt = (args.now?.() ?? new Date()).toISOString();
  const prs = args.prNumbers.map((number, index) => parseSnapshotPr(
    repository[`pr${index}`],
    args.repository,
    number,
  ));
  return {
    repository: args.repository,
    viewer,
    observedAt,
    prs,
    queryCost: numberField(rateLimit, 'cost'),
    rateRemaining: numberField(rateLimit, 'remaining'),
    rateResetAt: stringField(rateLimit, 'resetAt'),
    apiCalls: 1,
  };
}

/**
 * Resolve a conservative required-check baseline from branch-protection rules
 * and every active repository ruleset. Treating every active ruleset context
 * as applicable may over-require, but never weakens protected evidence.
 */
export async function fetchGitHubRulesBaseline(args: {
  readonly repository: string;
  readonly baseBranch: string;
  readonly context: GitHubClientContext;
}): Promise<GitHubRulesBaseline> {
  const [owner, repo] = splitRepository(args.repository);
  const query = `query CrewPrWatchRules {
    repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) {
      branchProtectionRules(first: 100) {
        pageInfo { hasNextPage }
        nodes { pattern requiredStatusCheckContexts }
      }
      rulesets(first: 100, includeParents: true, targets: [BRANCH]) {
        pageInfo { hasNextPage }
        nodes {
          id name enforcement
          rules(first: 100) {
            pageInfo { hasNextPage }
            nodes {
              type
              parameters {
                __typename
                ... on RequiredStatusChecksParameters {
                  requiredStatusChecks { context }
                }
              }
            }
          }
        }
      }
    }
  }`;
  try {
    const result = await runGitHubReadCommand({
      kind: 'graphql',
      hostname: args.context.hostname ?? 'github.com',
      document: query,
    }, args.context);
    const data = parseGraphqlEnvelope(result.stdout);
    const repository = objectField(data, 'repository');
    const protection = objectField(repository, 'branchProtectionRules');
    const rulesets = objectField(repository, 'rulesets');
    if (
      objectField(protection, 'pageInfo').hasNextPage === true
      || objectField(rulesets, 'pageInfo').hasNextPage === true
    ) {
      return { status: 'ambiguous', requiredChecks: [], provenance: { reason: 'pagination' } };
    }
    const checks = new Set<string>();
    const protectionRows: unknown[] = [];
    for (const rawRule of arrayField(protection, 'nodes')) {
      const rule = asRecord(rawRule, 'branch protection rule');
      const pattern = stringField(rule, 'pattern');
      if (!branchPatternMatches(pattern, args.baseBranch)) continue;
      protectionRows.push({ pattern });
      for (const context of arrayField(rule, 'requiredStatusCheckContexts')) {
        if (typeof context === 'string' && context.length > 0) checks.add(context);
      }
    }
    const rulesetRows: unknown[] = [];
    for (const rawRuleset of arrayField(rulesets, 'nodes')) {
      const ruleset = asRecord(rawRuleset, 'ruleset');
      if (ruleset.enforcement === 'DISABLED') continue;
      const rules = objectField(ruleset, 'rules');
      if (objectField(rules, 'pageInfo').hasNextPage === true) {
        return { status: 'ambiguous', requiredChecks: [], provenance: { reason: 'ruleset_pagination' } };
      }
      const row = { id: ruleset.id, name: ruleset.name, enforcement: ruleset.enforcement };
      rulesetRows.push(row);
      for (const rawRule of arrayField(rules, 'nodes')) {
        const rule = asRecord(rawRule, 'ruleset rule');
        if (rule.type !== 'REQUIRED_STATUS_CHECKS') continue;
        const parameters = objectField(rule, 'parameters');
        if (parameters.__typename !== 'RequiredStatusChecksParameters') {
          return { status: 'ambiguous', requiredChecks: [], provenance: { reason: 'ruleset_parameters' } };
        }
        for (const rawCheck of arrayField(parameters, 'requiredStatusChecks')) {
          const context = stringField(asRecord(rawCheck, 'required status check'), 'context');
          checks.add(context);
        }
      }
    }
    return {
      status: 'resolved',
      requiredChecks: [...checks].sort(),
      provenance: { baseBranch: args.baseBranch, branchProtection: protectionRows, rulesets: rulesetRows },
    };
  } catch (error) {
    return {
      status: 'inaccessible',
      requiredChecks: [],
      provenance: { detail: error instanceof Error ? error.message : String(error) },
    };
  }
}

function parseGraphqlEnvelope(output: string): Record<string, unknown> {
  const envelope = asRecord(JSON.parse(output) as unknown, 'GitHub response');
  if (Array.isArray(envelope.errors) && envelope.errors.length > 0) {
    throw new Error(`pr_watch.github_graphql_error: ${JSON.stringify(envelope.errors).slice(0, 2000)}`);
  }
  return asRecord(envelope.data, 'GitHub data');
}

function parseDiscoveryPr(value: unknown, repository: string): GitHubPullRequestObservation {
  const pr = asRecord(value, 'pull request');
  const commits = objectField(pr, 'commits');
  const commit = objectField(asRecord(arrayField(commits, 'nodes')[0], 'commit node'), 'commit');
  return {
    number: numberField(pr, 'number'),
    url: stringField(pr, 'url'),
    state: enumField(pr, 'state', ['OPEN', 'CLOSED', 'MERGED']),
    headRefName: stringField(pr, 'headRefName'),
    baseRefName: stringField(pr, 'baseRefName'),
    headRepository: optionalNameWithOwner(pr.headRepository) ?? repository,
    baseRepository: optionalNameWithOwner(pr.baseRepository) ?? repository,
    headSha: stringField(pr, 'headRefOid'),
    headCommittedAt: stringField(commit, 'committedDate'),
    author: optionalLogin(pr.author),
    reviewDecision: nullableEnumField(pr, 'reviewDecision', ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']),
    checks: [],
    reviews: [],
    threads: [],
    comments: [],
    paginationComplete: true,
    detailsComplete: true,
  };
}

function parseSnapshotPr(value: unknown, repository: string, expectedNumber: number): GitHubPullRequestObservation {
  const pr = asRecord(value, `pull request ${expectedNumber}`);
  const number = numberField(pr, 'number');
  if (number !== expectedNumber) throw new Error('pr_watch.snapshot_pr_identity_mismatch');
  const commits = objectField(pr, 'commits');
  const commit = objectField(asRecord(arrayField(commits, 'nodes')[0], 'commit node'), 'commit');
  const rollup = objectField(commit, 'statusCheckRollup');
  const contexts = objectField(rollup, 'contexts');
  const reviewThreads = objectField(pr, 'reviewThreads');
  const reviews = objectField(pr, 'reviews');
  const comments = objectField(pr, 'comments');
  const paginationComplete = [contexts, reviewThreads, reviews, comments]
    .every((connection) => objectField(connection, 'pageInfo').hasNextPage === false);
  return {
    number,
    url: stringField(pr, 'url'),
    state: enumField(pr, 'state', ['OPEN', 'CLOSED', 'MERGED']),
    headRefName: stringField(pr, 'headRefName'),
    baseRefName: stringField(pr, 'baseRefName'),
    headRepository: optionalNameWithOwner(pr.headRepository) ?? repository,
    baseRepository: optionalNameWithOwner(pr.baseRepository) ?? repository,
    headSha: stringField(pr, 'headRefOid'),
    headCommittedAt: stringField(commit, 'committedDate'),
    author: optionalLogin(pr.author),
    reviewDecision: nullableEnumField(pr, 'reviewDecision', ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']),
    checks: arrayField(contexts, 'nodes').map(parseCheck),
    reviews: arrayField(reviews, 'nodes').map((raw) => {
      const review = asRecord(raw, 'review');
      const commitValue = review.commit === null ? undefined : asRecord(review.commit, 'review commit');
      return {
        id: stringField(review, 'id'),
        author: optionalLogin(review.author),
        state: enumField(review, 'state', ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED']),
        submittedAt: stringField(review, 'submittedAt'),
        ...(commitValue ? { commitSha: stringField(commitValue, 'oid') } : {}),
      };
    }),
    threads: arrayField(reviewThreads, 'nodes').map((raw) => {
      const thread = asRecord(raw, 'review thread');
      const threadComments = objectField(thread, 'comments');
      const last = arrayField(threadComments, 'nodes').at(-1);
      const lastComment = last ? asRecord(last, 'thread comment') : undefined;
      const databaseId = lastComment?.databaseId;
      return {
        id: stringField(thread, 'id'),
        isResolved: booleanField(thread, 'isResolved'),
        isOutdated: booleanField(thread, 'isOutdated'),
        updatedAt: lastComment ? stringField(lastComment, 'updatedAt') : '1970-01-01T00:00:00.000Z',
        ...(typeof databaseId === 'number' && Number.isSafeInteger(databaseId) && databaseId > 0
          ? { lastCommentDatabaseId: databaseId }
          : {}),
      };
    }),
    comments: arrayField(comments, 'nodes').map((raw) => {
      const comment = asRecord(raw, 'comment');
      return {
        id: stringField(comment, 'id'),
        author: optionalLogin(comment.author),
        updatedAt: stringField(comment, 'updatedAt'),
        body: stringField(comment, 'body'),
      };
    }),
    paginationComplete,
    detailsComplete: paginationComplete,
  };
}

function parseCheck(value: unknown) {
  const check = asRecord(value, 'check context');
  if (check.__typename === 'CheckRun') {
    return {
      context: stringField(check, 'name'),
      sourceId: typeof check.databaseId === 'number' ? String(check.databaseId) : stringField(check, 'id'),
      attempt: 1,
      status: enumField(check, 'status', ['QUEUED', 'IN_PROGRESS', 'COMPLETED', 'EXPECTED']),
      conclusion: check.conclusion === null
        ? null
        : enumField(check, 'conclusion', [
          'SUCCESS', 'FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'SKIPPED', 'NEUTRAL',
        ]) as GitHubCheckConclusion,
    };
  }
  const state = enumField(check, 'state', ['SUCCESS', 'FAILURE', 'ERROR', 'PENDING', 'EXPECTED']);
  return {
    context: stringField(check, 'context'),
    sourceId: stringField(check, 'id'),
    attempt: 1,
    status: state === 'PENDING' || state === 'EXPECTED' ? 'IN_PROGRESS' as const : 'COMPLETED' as const,
    conclusion: state === 'SUCCESS' ? 'SUCCESS' as const : state === 'PENDING' || state === 'EXPECTED' ? null : 'FAILURE' as const,
  };
}

function splitRepository(value: string): readonly [string, string] {
  const match = value.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match || match[1] === '.' || match[1] === '..' || match[2] === '.' || match[2] === '..') {
    throw new Error('pr_watch.invalid_repository_identity');
  }
  return [match[1], match[2]];
}

function branchPatternMatches(pattern: string, branch: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`).test(branch);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`pr_watch.invalid_github_response: ${label}`);
  }
  return value as Record<string, unknown>;
}

function objectField(record: Record<string, unknown>, field: string): Record<string, unknown> {
  return asRecord(record[field], field);
}

function arrayField(record: Record<string, unknown>, field: string): readonly unknown[] {
  const value = record[field];
  if (!Array.isArray(value)) throw new Error(`pr_watch.invalid_github_response: ${field}`);
  return value;
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`pr_watch.invalid_github_response: ${field}`);
  }
  return value;
}

function numberField(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`pr_watch.invalid_github_response: ${field}`);
  }
  return value;
}

function booleanField(record: Record<string, unknown>, field: string): boolean {
  const value = record[field];
  if (typeof value !== 'boolean') throw new Error(`pr_watch.invalid_github_response: ${field}`);
  return value;
}

function enumField<const T extends string>(
  record: Record<string, unknown>,
  field: string,
  values: readonly T[],
): T {
  const value = record[field];
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new Error(`pr_watch.invalid_github_response: ${field}`);
  }
  return value as T;
}

function nullableEnumField<const T extends string>(
  record: Record<string, unknown>,
  field: string,
  values: readonly T[],
): T | null {
  if (record[field] === null) return null;
  return enumField(record, field, values);
}

function optionalLogin(value: unknown): string {
  if (value === null) return 'ghost';
  return stringField(asRecord(value, 'actor'), 'login');
}

function optionalNameWithOwner(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return stringField(asRecord(value, 'repository'), 'nameWithOwner');
}
