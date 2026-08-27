import { describe, expect, it } from 'vitest';

import {
  discoverOpenGitHubPullRequests,
  fetchGitHubRulesBaseline,
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
