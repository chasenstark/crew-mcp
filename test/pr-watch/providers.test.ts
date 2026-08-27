import { describe, expect, it } from 'vitest';

import { toCircleCiCommandSpec } from '../../src/pr-watch/circleci-provider.js';
import {
  assertReadOnlyGraphql,
  detectGhCapability,
  parseGhScopes,
  toGitHubCommandSpec,
} from '../../src/pr-watch/github-provider.js';
import type { ProviderCommandRunner } from '../../src/pr-watch/provider-runner.js';

describe('typed read-only provider commands', () => {
  it('rejects GraphQL mutation documents before spawning', () => {
    expect(() => assertReadOnlyGraphql('mutation { addComment(input: {}) { clientMutationId } }'))
      .toThrow('github_mutation_forbidden');
    expect(() => toGitHubCommandSpec({
      kind: 'graphql',
      hostname: 'github.com',
      document: 'mutation Update { closePullRequest(input: {}) { clientMutationId } }',
    })).toThrow('github_mutation_forbidden');
  });

  it('builds only the frozen gh and CircleCI read forms', () => {
    expect(toGitHubCommandSpec({
      kind: 'graphql',
      hostname: 'github.com',
      document: 'query Read { viewer { login } }',
      variables: { owner: 'example' },
    }).args).toEqual([
      'api', 'graphql', '--hostname', 'github.com', '-f',
      'query=query Read { viewer { login } }', '-F', 'owner=example',
    ]);
    expect(toCircleCiCommandSpec({
      kind: 'run_list',
      projectSlug: 'gh/example/repo',
      branch: 'feature',
    }).args).toEqual([
      'run', 'list', '--project', 'gh/example/repo', '--branch', 'feature', '--limit', '25', '--json',
    ]);
    expect(() => toCircleCiCommandSpec({
      kind: 'run_get',
      runId: '--method=POST',
    })).toThrow('invalid_circleci_run_id');
  });

  it('detects supported gh auth and exact required scopes through an injected runner', async () => {
    const seen: readonly string[][] = [];
    const mutableSeen = seen as string[][];
    const runner: ProviderCommandRunner = {
      run: async (spec) => {
        mutableSeen.push([...spec.args]);
        if (spec.args[0] === '--version') {
          return { stdout: 'gh version 2.80.1 (2026-01-01)\n', stderr: '', exitCode: 0 };
        }
        return {
          stdout: '',
          stderr: "Logged in to github.com\n  - Token scopes: 'repo', 'read:org'\n",
          exitCode: 0,
        };
      },
    };
    const capability = await detectGhCapability({
      runner,
      requiredScopes: ['repo', 'read:org'],
    });
    expect(capability).toMatchObject({ ok: true, version: '2.80.1' });
    expect(capability.scopes).toEqual(['read:org', 'repo']);
    expect(seen).toHaveLength(2);
  });

  it('parses quoted scope tokens without exposing other auth output', () => {
    expect(parseGhScopes("Token scopes: 'gist', 'repo', 'repo'"))
      .toEqual(['gist', 'repo']);
  });
});
