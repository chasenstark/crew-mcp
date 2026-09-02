import { describe, expect, it } from 'vitest';

import { defaultProfile, resolvePrWatchPolicy } from '../../src/pr-watch/config.js';
import {
  buildGitHubProbeQuery,
  buildGitHubSnapshotQuery,
  discoverLinearPrStack,
  evaluateGitHubSnapshot,
  evaluateTerminalStability,
  type GitHubCommentObservation,
  type GitHubPullRequestObservation,
  type GitHubSnapshotObservation,
} from '../../src/pr-watch/github-observation.js';
import { startPrWatchInputSchema } from '../../src/orchestrator/tools/pr-watch.js';

const OBSERVED_AT = '2026-08-27T12:00:00.000Z';

describe('GitHub PR-watch observation', () => {
  it('discovers the anchor-containing stack in bottom-to-top order', () => {
    const prs = [
      pr({ number: 3, headRefName: 'top', baseRefName: 'middle' }),
      pr({ number: 1, headRefName: 'bottom', baseRefName: 'main' }),
      pr({ number: 2, headRefName: 'middle', baseRefName: 'bottom' }),
    ];
    expect(discoverLinearPrStack({
      prs,
      anchorPrNumber: 2,
      repository: 'example/repo',
      maxPrs: 50,
    }).map((entry) => entry.number)).toEqual([1, 2, 3]);
  });

  it('rejects ambiguous stack children and over-wide stacks', () => {
    const prs = [
      pr({ number: 1, headRefName: 'bottom', baseRefName: 'main' }),
      pr({ number: 2, headRefName: 'child-a', baseRefName: 'bottom' }),
      pr({ number: 3, headRefName: 'child-b', baseRefName: 'bottom' }),
    ];
    expect(() => discoverLinearPrStack({
      prs,
      anchorPrNumber: 1,
      repository: 'example/repo',
      maxPrs: 50,
    })).toThrow('ambiguous_stack_children');
    expect(() => discoverLinearPrStack({
      prs: prs.slice(0, 2),
      anchorPrNumber: 1,
      repository: 'example/repo',
      maxPrs: 1,
    })).toThrow('stack_limit_exceeded');
  });

  it('builds one read-only aliased snapshot query for a bounded stack', () => {
    const query = buildGitHubSnapshotQuery('example', 'repo', [10, 11, 12]);
    expect(query).toContain('pr0: pullRequest(number: 10)');
    expect(query).toContain('pr2: pullRequest(number: 12)');
    expect(query).toContain('updatedAt isDraft');
    expect(query).toContain('statusCheckRollup { state contexts(first: 100)');
    expect(query).not.toMatch(/\bmutation\b/i);
  });

  it('builds a flat change probe with no nested per-thread connections', () => {
    const query = buildGitHubProbeQuery('example', 'repo', [10, 11]);
    expect(query).toContain('query CrewPrWatchProbe');
    expect(query).toContain('pr1: pullRequest(number: 11)');
    expect(query).toContain('number state updatedAt headRefOid baseRefName reviewDecision isDraft');
    expect(query).toContain('commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }');
    // Backward-paginated connections must ask for hasPreviousPage, forward ones for hasNextPage.
    expect(query).toContain('comments(last: 100) { pageInfo { hasPreviousPage } nodes { id createdAt lastEditedAt author { __typename login } } }');
    expect(query).toContain('reviewThreads(first: 100) { pageInfo { hasNextPage } nodes { id isResolved isOutdated } }');
    // The expensive shapes stay out: no nested thread comments, review bodies, or check contexts.
    for (const connection of ['comments(last: 1)', 'reviews(', 'contexts(', 'body']) {
      expect(query).not.toContain(connection);
    }
    expect(query).not.toMatch(/\bmutation\b/i);
    expect(() => buildGitHubProbeQuery('example', 'repo', [])).toThrow('invalid_probe_pr_numbers');
    expect(() => buildGitHubProbeQuery('example', 'repo', [1, 1])).toThrow('invalid_probe_pr_numbers');
  });

  it('projects rate spend from the steady-state poll cost rather than one expensive refresh', () => {
    const expensive = { ...snapshot([pr()]), queryCost: 53, rateRemaining: 5000 };
    const naive = evaluateGitHubSnapshot({
      snapshot: expensive,
      policy: resolvedPolicy(['unit']),
      approval: { mode: 'github' },
      cadenceSeconds: 120,
    });
    expect(naive.incompleteReasons).toContain('github_rate_projection_exceeded');
    expect(naive.projectedPointSpend).toBe(53 * 30);
    const amortized = evaluateGitHubSnapshot({
      snapshot: expensive,
      policy: resolvedPolicy(['unit']),
      approval: { mode: 'github' },
      cadenceSeconds: 120,
      projectedPollCost: 9,
    });
    expect(amortized.incompleteReasons).not.toContain('github_rate_projection_exceeded');
    expect(amortized.projectedPointSpend).toBe(9 * 30);
    expect(() => evaluateGitHubSnapshot({
      snapshot: expensive,
      policy: resolvedPolicy(['unit']),
      approval: { mode: 'github' },
      cadenceSeconds: 120,
      projectedPollCost: -1,
    })).toThrow('invalid_projected_poll_cost');
  });

  it('fails closed for missing or progressively registered checks', () => {
    const policy = resolvedPolicy(['unit', 'lint']);
    const evaluation = evaluateGitHubSnapshot({
      snapshot: snapshot([pr({ checks: [{
        context: 'unit',
        sourceId: 'unit-1',
        attempt: 1,
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
      }] })]),
      policy,
      approval: { mode: 'github' },
      cadenceSeconds: 120,
    });
    expect(evaluation.complete).toBe(false);
    expect(evaluation.terminalCandidate).toBe(false);
    expect(evaluation.incompleteReasons).toContain('pr_1:missing_check:lint');
  });

  it('gives same-name reruns distinct stable event identities', () => {
    const policy = resolvedPolicy(['unit']);
    const evaluateAttempt = (attempt: number, sourceId: string) => evaluateGitHubSnapshot({
      snapshot: snapshot([pr({ checks: [{
        context: 'unit',
        sourceId,
        attempt,
        status: 'COMPLETED',
        conclusion: 'FAILURE',
      }] })]),
      policy,
      approval: { mode: 'github' },
      cadenceSeconds: 120,
    });
    const first = evaluateAttempt(1, 'check-run-10');
    const rerun = evaluateAttempt(2, 'check-run-11');
    expect(first.actionableEvents[0].id).not.toBe(rerun.actionableEvents[0].id);
  });

  it('emits pr_closed and refuses a green terminal candidate for closed-unmerged PRs', () => {
    const evaluation = evaluateGitHubSnapshot({
      snapshot: snapshot([
        pr({ number: 1, state: 'CLOSED' }),
        pr({ number: 2, state: 'OPEN' }),
      ]),
      policy: resolvedPolicy(['unit']),
      approval: { mode: 'github' },
      cadenceSeconds: 120,
    });

    expect(evaluation.actionableEvents).toEqual([
      expect.objectContaining({
        identity: expect.objectContaining({
          prNumber: 1,
          kind: 'pr_closed',
          providerSourceId: 'pr:1:closed',
        }),
      }),
    ]);
    expect(evaluation.terminalCandidate).toBe(false);
  });

  it('allows the distinct all-closed terminal path after every watched PR closes', () => {
    const evaluation = evaluateGitHubSnapshot({
      snapshot: snapshot([
        pr({ number: 1, state: 'CLOSED' }),
        pr({ number: 2, state: 'MERGED' }),
      ]),
      policy: resolvedPolicy(['unit']),
      approval: { mode: 'github' },
      cadenceSeconds: 120,
    });

    expect(evaluation.allClosed).toBe(true);
    expect(evaluation.terminalCandidate).toBe(true);
  });

  it('emits only configured verdict markers and keys edits on the last edit time', () => {
    const evaluateComment = (lastEditedAt: string | null, body: string, author = 'review-bot') => (
      evaluateGitHubSnapshot({
        snapshot: snapshot([pr({ comments: [comment({ id: 'comment-10', author, lastEditedAt, body })] })]),
        policy: resolvedPolicy(['unit']),
        approval: { mode: 'github' },
        cadenceSeconds: 120,
        verdictSources: [{ author: 'Review-Bot', marker: 'Verdict: changes requested' }],
      })
    );

    expect(evaluateComment(null, 'ordinary progress note').actionableEvents).toEqual([]);
    expect(evaluateComment(null, 'Verdict: changes requested', 'other-user').actionableEvents).toEqual([]);
    const initial = evaluateComment(null, 'Verdict: changes requested');
    const edited = evaluateComment('2026-08-27T12:01:00.000Z', 'Verdict: changes requested\nupdated');
    expect(initial.actionableEvents).toHaveLength(1);
    expect(initial.actionableEvents[0]).toMatchObject({
      identity: { attempt: Date.parse('2026-08-27T11:00:00.000Z') },
      versionTimestamp: '2026-08-27T11:00:00.000Z',
    });
    expect(edited.actionableEvents).toHaveLength(1);
    expect(edited.actionableEvents[0]).toMatchObject({
      identity: { attempt: Date.parse('2026-08-27T12:01:00.000Z') },
      versionTimestamp: '2026-08-27T12:01:00.000Z',
    });
    expect(initial.actionableEvents[0].id).not.toBe(edited.actionableEvents[0].id);
  });

  it('treats GitHub-App and [bot] authors as review sources unless ignored', () => {
    const evaluateBots = (
      comments: readonly GitHubCommentObservation[],
      profile = defaultProfile(),
    ) => evaluateGitHubSnapshot({
      snapshot: snapshot([pr({ comments })]),
      policy: resolvePrWatchPolicy({
        profile,
        rulesBaseline: { status: 'resolved', requiredChecks: ['unit'], provenance: {} },
      }),
      approval: { mode: 'github' },
      cadenceSeconds: 120,
    }).actionableEvents;

    const appBot = comment({ id: 'IC_app', author: '143-dev', authorType: 'Bot', body: '✅ approved' });
    const legacyBot = comment({ id: 'IC_legacy', author: 'github-actions[bot]', authorType: 'User', body: 'deployed' });
    const human = comment({ id: 'IC_human', author: 'reviewer', authorType: 'User', body: 'looks good' });
    const events = evaluateBots([appBot, legacyBot, human]);
    expect(events.map((event) => event.identity.providerSourceId).sort()).toEqual(['IC_app', 'IC_legacy']);
    expect(events.every((event) => event.identity.kind === 'comment')).toBe(true);

    const ignoring = {
      ...defaultProfile(),
      bots: { autoDetect: true, ignore: ['GitHub-Actions[bot]'] },
    };
    expect(evaluateBots([appBot, legacyBot, human], ignoring).map((event) => event.identity.providerSourceId))
      .toEqual(['IC_app']);
    const disabled = { ...defaultProfile(), bots: { autoDetect: false, ignore: [] } };
    expect(evaluateBots([appBot, legacyBot, human], disabled)).toEqual([]);
  });

  it('validates bounded unique verdict-source inputs', () => {
    expect(startPrWatchInputSchema.parse({
      verdict_sources: [{ author: 'review-bot', marker: 'Verdict: approve' }],
    }).verdict_sources).toEqual([{ author: 'review-bot', marker: 'Verdict: approve' }]);
    expect(() => startPrWatchInputSchema.parse({
      verdict_sources: [
        { author: 'Review-Bot', marker: 'Verdict: approve' },
        { author: 'review-bot', marker: 'Verdict: approve' },
      ],
    })).toThrow('verdict sources must be unique');
  });

  it('requires two complete identical observations separated by dwell and after head update', () => {
    const evaluation = evaluateGitHubSnapshot({
      snapshot: snapshot([pr()]),
      policy: resolvedPolicy(['unit']),
      approval: { mode: 'github' },
      cadenceSeconds: 120,
    });
    expect(evaluation.terminalCandidate).toBe(true);
    const first = evaluateTerminalStability({
      evaluation,
      observedAt: OBSERVED_AT,
      lastHeadUpdateObservedAt: OBSERVED_AT,
      minimumDwellMs: 120_000,
    });
    expect(first.terminal).toBe(false);
    const tooSoon = evaluateTerminalStability({
      evaluation,
      previous: first.next,
      observedAt: '2026-08-27T12:01:59.000Z',
      lastHeadUpdateObservedAt: OBSERVED_AT,
      minimumDwellMs: 120_000,
    });
    expect(tooSoon.terminal).toBe(false);
    const stable = evaluateTerminalStability({
      evaluation,
      previous: first.next,
      observedAt: '2026-08-27T12:02:00.000Z',
      lastHeadUpdateObservedAt: OBSERVED_AT,
      minimumDwellMs: 120_000,
    });
    expect(stable.terminal).toBe(true);
  });
});

function resolvedPolicy(checks: readonly string[]) {
  return resolvePrWatchPolicy({
    profile: defaultProfile(),
    rulesBaseline: { status: 'resolved', requiredChecks: checks, provenance: {} },
  });
}

function snapshot(prs: readonly GitHubPullRequestObservation[]): GitHubSnapshotObservation {
  return {
    repository: 'example/repo',
    viewer: 'watch-bot',
    observedAt: OBSERVED_AT,
    prs,
    queryCost: 1,
    rateRemaining: 5000,
    rateResetAt: '2026-08-27T13:00:00.000Z',
    apiCalls: 1,
  };
}

function comment(overrides: Partial<GitHubCommentObservation> & { readonly id: string }): GitHubCommentObservation {
  const createdAt = overrides.createdAt ?? '2026-08-27T11:00:00.000Z';
  const lastEditedAt = overrides.lastEditedAt ?? null;
  return {
    author: 'review-bot',
    authorType: 'User',
    createdAt,
    updatedAt: lastEditedAt ?? createdAt,
    lastEditedAt,
    body: '',
    ...overrides,
  };
}

function pr(overrides: Partial<GitHubPullRequestObservation> = {}): GitHubPullRequestObservation {
  return {
    number: 1,
    url: 'https://github.com/example/repo/pull/1',
    state: 'OPEN',
    headRefName: 'feature',
    baseRefName: 'main',
    headRepository: 'example/repo',
    baseRepository: 'example/repo',
    headSha: 'abc123',
    headCommittedAt: '2026-08-27T11:00:00.000Z',
    author: 'author',
    reviewDecision: 'APPROVED',
    checks: [{
      context: 'unit',
      sourceId: 'check-run-1',
      attempt: 1,
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
    }],
    reviews: [],
    threads: [],
    comments: [],
    paginationComplete: true,
    detailsComplete: true,
    ...overrides,
  };
}
