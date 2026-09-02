import { describe, expect, it } from 'vitest';

import {
  discoverOpenGitHubPullRequests,
  fetchGitHubProbe,
  fetchGitHubRulesBaseline,
  fetchGitHubSnapshot,
} from '../../src/pr-watch/github-client.js';
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
          pageInfo: { hasNextPage: false },
          nodes: [{ pattern: 'main', requiredStatusCheckContexts: ['unit'] }],
        },
        rulesets: {
          pageInfo: { hasNextPage: false },
          nodes: [{
            id: 'ruleset-1',
            name: 'checks',
            enforcement: 'ACTIVE',
            rules: {
              pageInfo: { hasNextPage: false },
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

  it('fails closed when the status check rollup key is missing', async () => {
    await expect(fetchGitHubSnapshot({
      repository: 'example/repo',
      prNumbers: [5],
      context: { runner: snapshotRunner({}) },
    })).rejects.toThrow('pr_watch.invalid_github_response: statusCheckRollup');
  });
});

function snapshotRunner(commitExtras: Record<string, unknown>): ProviderCommandRunner {
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
        reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
        reviews: { pageInfo: { hasNextPage: false }, nodes: [] },
        comments: { pageInfo: { hasNextPage: false }, nodes: [] },
        commits: { nodes: [{ commit: {
          oid: '5'.repeat(40),
          committedDate: '2026-09-02T11:00:00.000Z',
          ...commitExtras,
        } }] },
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
    });

    expect(document).toContain('query CrewPrWatchProbe');
    expect(probe).toMatchObject({
      repository: 'example/repo',
      viewer: 'watch-bot',
      observedAt: '2026-09-02T12:00:00.000Z',
      queryCost: 1,
      rateRemaining: 4990,
    });
    expect(probe.signals['7']).toEqual({
      state: 'OPEN',
      updatedAt: '2026-09-02T11:30:00.000Z',
      headSha: '7'.repeat(40),
      baseRefName: 'main',
      reviewDecision: 'REVIEW_REQUIRED',
      isDraft: false,
      rollupState: 'PENDING',
    });
    expect(probe.signals['9']).toMatchObject({ state: 'MERGED', reviewDecision: null, rollupState: null });
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
