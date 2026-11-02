import { describe, expect, it } from 'vitest';

import {
  discoverOpenGitHubPullRequests,
  fetchGitHubProbe,
  fetchGitHubRulesBaseline,
  fetchGitHubSnapshot,
} from '../../src/pr-watch/github-client.js';
import {
  DEFAULT_COMMENT_SIGNAL_POLICY,
  type PrWatchCommentSignalPolicy,
} from '../../src/pr-watch/github-observation.js';
import type { ProviderCommandRunner } from '../../src/pr-watch/provider-runner.js';

describe('GitHub PR-watch discovery client', () => {
  it('paginates the repository-wide open PR set before stack reduction', async () => {
    const cursors: Array<string | undefined> = [];
    const runner: ProviderCommandRunner = {
      run: async (spec) => {
        const cursor = spec.args.find((arg) => arg.startsWith('cursor='))?.slice('cursor='.length);
        cursors.push(cursor);
        return jsonResult({ data: { repository: { pullRequests: cursor === undefined
          ? {
              pageInfo: { hasNextPage: true, endCursor: 'page-2' },
              nodes: [discoveryPr(1, 'one', 'main')],
            }
          : {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [discoveryPr(2, 'two', 'one')],
            } } } });
      },
    };

    const prs = await discoverOpenGitHubPullRequests({
      repository: 'example/repo',
      maxPrs: 50,
      context: { runner },
    });

    expect(cursors).toEqual([undefined, 'page-2']);
    expect(prs.map((pr) => pr.number)).toEqual([1, 2]);
  });

  it('fails closed when pagination cannot provide the next cursor', async () => {
    const runner: ProviderCommandRunner = {
      run: async () => jsonResult({ data: { repository: { pullRequests: {
        pageInfo: { hasNextPage: true, endCursor: null },
        nodes: [discoveryPr(1, 'one', 'main')],
      } } } }),
    };

    await expect(discoverOpenGitHubPullRequests({
      repository: 'example/repo',
      maxPrs: 50,
      context: { runner },
    })).rejects.toThrow('pr_watch.discovery_pagination_incomplete');
  });

  it('reads required checks from the current GitHub RepositoryRule schema', async () => {
    const runner: ProviderCommandRunner = {
      run: async () => jsonResult({ data: { repository: {
        branchProtectionRules: {
          pageInfo: { hasNextPage: false, hasPreviousPage: false },
          nodes: [{ pattern: 'main', requiredStatusCheckContexts: ['unit'] }],
        },
        rulesets: {
          pageInfo: { hasNextPage: false, hasPreviousPage: false },
          nodes: [{
            id: 'ruleset-1',
            name: 'checks',
            enforcement: 'ACTIVE',
            rules: {
              pageInfo: { hasNextPage: false, hasPreviousPage: false },
              nodes: [{
                type: 'REQUIRED_STATUS_CHECKS',
                parameters: {
                  __typename: 'RequiredStatusChecksParameters',
                  requiredStatusChecks: [{ context: 'integration' }],
                },
              }],
            },
          }],
        },
      } } }),
    };

    await expect(fetchGitHubRulesBaseline({
      repository: 'example/repo',
      baseBranch: 'main',
      context: { runner },
    })).resolves.toMatchObject({
      status: 'resolved',
      requiredChecks: ['integration', 'unit'],
    });
  });
});

describe('GitHub PR-watch snapshot client', () => {
  it('treats a null status check rollup as an empty, complete check set', async () => {
    const snapshot = await fetchGitHubSnapshot({
      repository: 'example/repo',
      prNumbers: [5],
      context: { runner: snapshotRunner({ statusCheckRollup: null }) },
    });

    expect(snapshot.prs[0]).toMatchObject({
      number: 5,
      checks: [],
      paginationComplete: true,
      detailsComplete: true,
      changeSignal: {
        state: 'OPEN',
        updatedAt: '2026-09-02T11:30:00.000Z',
        headSha: '5'.repeat(40),
        baseRefName: 'main',
        reviewDecision: null,
        isDraft: true,
        rollupState: null,
      },
    });
  });

  it('reads backward pagination through hasPreviousPage and fails closed on the wrong flag', async () => {
    const truncated = await fetchGitHubSnapshot({
      repository: 'example/repo',
      prNumbers: [5],
      context: { runner: snapshotRunner({ statusCheckRollup: null }, {
        comments: { pageInfo: { hasNextPage: false, hasPreviousPage: true }, nodes: [] },
      }) },
    });
    expect(truncated.prs[0]).toMatchObject({ paginationComplete: false, detailsComplete: false });
    const complete = await fetchGitHubSnapshot({
      repository: 'example/repo',
      prNumbers: [5],
      context: { runner: snapshotRunner({ statusCheckRollup: null }) },
    });
    expect(complete.prs[0].changeSignal?.commentsDigest).not.toBe(truncated.prs[0].changeSignal?.commentsDigest);
    await expect(fetchGitHubSnapshot({
      repository: 'example/repo',
      prNumbers: [5],
      context: { runner: snapshotRunner({ statusCheckRollup: null }, {
        comments: { pageInfo: { hasNextPage: false }, nodes: [] },
      }) },
    })).rejects.toThrow('pr_watch.invalid_github_response: hasPreviousPage');
  });

  it('fails closed when the status check rollup key is missing', async () => {
    await expect(fetchGitHubSnapshot({
      repository: 'example/repo',
      prNumbers: [5],
      context: { runner: snapshotRunner({}) },
    })).rejects.toThrow('pr_watch.invalid_github_response: statusCheckRollup');
  });
});

function snapshotRunner(
  commitExtras: Record<string, unknown>,
  prExtras: Record<string, unknown> = {},
): ProviderCommandRunner {
  return {
    run: async () => jsonResult({ data: {
      viewer: { login: 'watch-bot' },
      rateLimit: { cost: 2, remaining: 4990, resetAt: '2026-09-02T13:00:00.000Z' },
      repository: { pr0: {
        number: 5,
        url: 'https://github.com/example/repo/pull/5',
        state: 'OPEN',
        headRefName: 'five',
        baseRefName: 'main',
        headRefOid: '5'.repeat(40),
        updatedAt: '2026-09-02T11:30:00.000Z',
        isDraft: true,
        headRepository: { nameWithOwner: 'example/repo' },
        baseRepository: { nameWithOwner: 'example/repo' },
        author: { login: 'author' },
        reviewDecision: null,
        reviewThreads: { pageInfo: { hasNextPage: false, hasPreviousPage: false }, nodes: [] },
        reviews: { pageInfo: { hasNextPage: false, hasPreviousPage: false }, nodes: [] },
        comments: { pageInfo: { hasNextPage: false, hasPreviousPage: false }, nodes: [] },
        commits: { nodes: [{ commit: {
          oid: '5'.repeat(40),
          committedDate: '2026-09-02T11:00:00.000Z',
          ...commitExtras,
        } }] },
        ...prExtras,
      } },
    } }),
  };
}

describe('GitHub PR-watch change probe client', () => {
  it('parses one change signal per requested PR, tolerating absent rollups', async () => {
    let document = '';
    const runner: ProviderCommandRunner = {
      run: async (spec) => {
        document = spec.args.find((arg) => arg.startsWith('query='))?.slice('query='.length) ?? '';
        return jsonResult({ data: {
          viewer: { login: 'watch-bot' },
          rateLimit: { cost: 1, remaining: 4990, resetAt: '2026-09-02T13:00:00.000Z' },
          repository: {
            pr0: probePr(7, { statusCheckRollup: { state: 'PENDING' } }),
            pr1: probePr(9, { statusCheckRollup: null, state: 'MERGED', reviewDecision: null }),
          },
        } });
      },
    };

    const probe = await fetchGitHubProbe({
      repository: 'example/repo',
      prNumbers: [7, 9],
      context: { runner },
      now: () => new Date('2026-09-02T12:00:00.000Z'),
      commentSignalPolicy: DEFAULT_COMMENT_SIGNAL_POLICY,
    });

    expect(document).toContain('query CrewPrWatchProbe');
    expect(probe).toMatchObject({
      repository: 'example/repo',
      viewer: 'watch-bot',
      observedAt: '2026-09-02T12:00:00.000Z',
      queryCost: 1,
      rateRemaining: 4990,
    });
    expect(probe.signals['7']).toMatchObject({
      state: 'OPEN',
      updatedAt: '2026-09-02T11:30:00.000Z',
      headSha: '7'.repeat(40),
      baseRefName: 'main',
      reviewDecision: 'REVIEW_REQUIRED',
      isDraft: false,
      rollupState: 'PENDING',
    });
    expect(probe.signals['7'].commentsDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(probe.signals['7'].threadsDigest).toMatch(/^[0-9a-f]{64}$/);
    // Same empty comment and thread sets → same digests across PRs.
    expect(probe.signals['9'].commentsDigest).toBe(probe.signals['7'].commentsDigest);
    expect(probe.signals['9']).toMatchObject({ state: 'MERGED', reviewDecision: null, rollupState: null });
  });

  it('produces the same change signal as the snapshot parser for the same PR state', async () => {
    const comments = [
      { id: 'IC_1', createdAt: '2026-09-01T10:00:00.000Z', lastEditedAt: null, author: { __typename: 'User', login: 'human' }, updatedAt: '2026-09-01T10:00:00.000Z', body: 'lgtm?' },
      { id: 'IC_2', createdAt: '2026-09-01T11:00:00.000Z', lastEditedAt: '2026-09-02T12:05:29.000Z', author: { __typename: 'Bot', login: '143-dev' }, updatedAt: '2026-09-02T12:05:29.000Z', body: 'verdict' },
    ];
    const threads = [
      { id: 'PRRT_1', isResolved: false, isOutdated: false, comments: { nodes: [{ databaseId: 7, updatedAt: '2026-09-01T12:00:00.000Z' }] } },
      { id: 'PRRT_2', isResolved: true, isOutdated: false, comments: { nodes: [{ databaseId: 8, updatedAt: '2026-09-01T12:30:00.000Z' }] } },
    ];
    const snapshotFor = (policy: PrWatchCommentSignalPolicy) => fetchGitHubSnapshot({
      repository: 'example/repo',
      prNumbers: [5],
      context: { runner: snapshotRunner({ statusCheckRollup: { state: 'PENDING', contexts: { pageInfo: { hasNextPage: false, hasPreviousPage: false }, nodes: [] } } }, {
        comments: { pageInfo: { hasNextPage: false, hasPreviousPage: false }, nodes: comments },
        reviewThreads: { pageInfo: { hasNextPage: false, hasPreviousPage: false }, nodes: threads },
      }) },
      commentSignalPolicy: policy,
    });
    // The probe carries only the digest inputs, in a different order.
    const probeFor = (policy: PrWatchCommentSignalPolicy, editedAt = comments[1].lastEditedAt) => fetchGitHubProbe({
      repository: 'example/repo',
      prNumbers: [5],
      context: { runner: {
        run: async () => jsonResult({ data: {
          viewer: { login: 'watch-bot' },
          rateLimit: { cost: 2, remaining: 4990, resetAt: '2026-09-02T13:00:00.000Z' },
          repository: { pr0: probePr(5, {
            updatedAt: '2026-09-02T11:30:00.000Z',
            reviewDecision: null,
            isDraft: true,
            statusCheckRollup: { state: 'PENDING' },
            comments: { pageInfo: { hasNextPage: false, hasPreviousPage: false }, nodes: [...comments].reverse().map(({ id, createdAt, lastEditedAt, author }) => ({
              id, createdAt, lastEditedAt: id === 'IC_2' ? editedAt : lastEditedAt, author,
            })) },
            reviewThreads: { pageInfo: { hasNextPage: false, hasPreviousPage: false }, nodes: [...threads].reverse().map(({ id, isResolved, isOutdated }) => ({ id, isResolved, isOutdated })) },
          }) },
        } }),
      } },
      commentSignalPolicy: policy,
    });

    const snapshot = await snapshotFor(DEFAULT_COMMENT_SIGNAL_POLICY);
    const probe = await probeFor(DEFAULT_COMMENT_SIGNAL_POLICY);
    expect(snapshot.prs[0].comments[1]).toMatchObject({ author: '143-dev', authorType: 'Bot', lastEditedAt: '2026-09-02T12:05:29.000Z' });
    expect(probe.signals['5']).toEqual(snapshot.prs[0].changeSignal);
    expect(probe.signals['5'].commentsDigest).toMatch(/^[0-9a-f]{64}$/);

    // A bot edit moves the digest; the same edit by a muted bot does not.
    const edited = await probeFor(DEFAULT_COMMENT_SIGNAL_POLICY, '2026-09-02T12:30:00.000Z');
    expect(edited.signals['5'].commentsDigest).not.toBe(probe.signals['5'].commentsDigest);
    const muted: PrWatchCommentSignalPolicy = { ...DEFAULT_COMMENT_SIGNAL_POLICY, ignoredBots: new Set(['143-dev']) };
    const mutedBefore = await probeFor(muted);
    const mutedAfter = await probeFor(muted, '2026-09-02T12:30:00.000Z');
    expect(mutedAfter.signals['5'].commentsDigest).toBe(mutedBefore.signals['5'].commentsDigest);
    expect((await snapshotFor(muted)).prs[0].changeSignal).toEqual(mutedBefore.signals['5']);
  });

  it('fails closed when a probe omits the status check rollup entirely', async () => {
    const runner: ProviderCommandRunner = {
      run: async () => jsonResult({ data: {
        viewer: { login: 'watch-bot' },
        rateLimit: { cost: 1, remaining: 4990, resetAt: '2026-09-02T13:00:00.000Z' },
        repository: { pr0: { ...probePr(7), commits: { nodes: [{ commit: {} }] } } },
      } }),
    };
    await expect(fetchGitHubProbe({
      repository: 'example/repo',
      prNumbers: [7],
      context: { runner },
      commentSignalPolicy: DEFAULT_COMMENT_SIGNAL_POLICY,
    })).rejects.toThrow('pr_watch.invalid_github_response: statusCheckRollup');
  });

  it('fails closed when the probe response identifies a different PR', async () => {
    const runner: ProviderCommandRunner = {
      run: async () => jsonResult({ data: {
        viewer: { login: 'watch-bot' },
        rateLimit: { cost: 1, remaining: 4990, resetAt: '2026-09-02T13:00:00.000Z' },
        repository: { pr0: probePr(8) },
      } }),
    };
    await expect(fetchGitHubProbe({
      repository: 'example/repo',
      prNumbers: [7],
      context: { runner },
      commentSignalPolicy: DEFAULT_COMMENT_SIGNAL_POLICY,
    })).rejects.toThrow('pr_watch.probe_pr_identity_mismatch');
  });
});

function probePr(number: number, overrides: Record<string, unknown> = {}) {
  const { statusCheckRollup, ...rest } = overrides;
  return {
    number,
    state: 'OPEN',
    updatedAt: '2026-09-02T11:30:00.000Z',
    headRefOid: String(number).repeat(40),
    baseRefName: 'main',
    reviewDecision: 'REVIEW_REQUIRED',
    isDraft: false,
    commits: { nodes: [{ commit: {
      statusCheckRollup: statusCheckRollup === undefined ? { state: 'SUCCESS' } : statusCheckRollup,
    } }] },
    comments: { pageInfo: { hasNextPage: false, hasPreviousPage: false }, nodes: [] },
    reviewThreads: { pageInfo: { hasNextPage: false, hasPreviousPage: false }, nodes: [] },
    ...rest,
  };
}

function discoveryPr(number: number, headRefName: string, baseRefName: string) {
  return {
    number,
    url: `https://github.com/example/repo/pull/${number}`,
    state: 'OPEN',
    headRefName,
    baseRefName,
    headRefOid: String(number).repeat(40),
    headRepository: { nameWithOwner: 'example/repo' },
    baseRepository: { nameWithOwner: 'example/repo' },
    author: { login: 'author' },
    reviewDecision: 'APPROVED',
    commits: { nodes: [{ commit: { committedDate: '2026-08-27T11:00:00.000Z' } }] },
  };
}

function jsonResult(value: unknown) {
  return { stdout: `${JSON.stringify(value)}\n`, stderr: '', exitCode: 0 };
}
