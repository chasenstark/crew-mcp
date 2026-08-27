import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { PrWatchController } from '../../src/pr-watch/controller.js';
import { hashPrWatchStartKey } from '../../src/pr-watch/id.js';
import { ProviderCommandError, type ProviderCommandRunner } from '../../src/pr-watch/provider-runner.js';
import { transitionToBlocked } from '../../src/pr-watch/reducer.js';
import { PrWatchStartIndex } from '../../src/pr-watch/start-index.js';
import { PrWatchStore } from '../../src/pr-watch/store.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('PrWatchController', () => {
  it('persists a typed blocked watch for missing gh and resumes the same idempotent target', async () => {
    const root = tempRoot();
    const repo = tempRoot();
    const store = new PrWatchStore(root);
    const controller = new PrWatchController(
      store,
      new PrWatchStartIndex(root),
      { run: async () => { throw new Error('spawn ENOENT'); } },
    );
    const first = await controller.start({
      repoRoot: repo,
      repository: 'example/repo',
      anchorPrNumber: 1,
      idempotencyKey: 'start-1',
      approval: { mode: 'github' },
    });
    expect(first.state.status).toBe('blocked');
    if (first.state.status !== 'blocked') throw new Error('expected blocked');
    expect(first.state.blocker.kind).toBe('provider_missing');
    const retry = await controller.start({
      repoRoot: repo,
      repository: 'example/repo',
      anchorPrNumber: 1,
      idempotencyKey: 'start-1',
      approval: { mode: 'github' },
    });
    expect(retry.idempotent).toBe(true);
    expect(retry.watchId).toBe(first.watchId);
  });

  it('leaves no partial watch when provider preflight times out', async () => {
    const root = tempRoot();
    const repo = tempRoot();
    const store = new PrWatchStore(root);
    const controller = new PrWatchController(
      store,
      new PrWatchStartIndex(root),
      { run: async () => { throw new ProviderCommandError('timeout', 'hung'); } },
    );
    await expect(controller.start({
      repoRoot: repo,
      repository: 'example/repo',
      anchorPrNumber: 1,
      idempotencyKey: 'start-timeout',
      approval: { mode: 'github' },
    })).rejects.toThrow('start_provider_timeout');
    expect(store.listWatchIds()).toEqual([]);
  });

  it('starts from bounded live evidence and settles only after two stable polls', async () => {
    const root = tempRoot();
    const repo = tempRoot();
    let nowMs = Date.parse('2026-08-27T12:00:00.000Z');
    const runner = successfulRunner(() => new Date(nowMs));
    const store = new PrWatchStore(root);
    const controller = new PrWatchController(
      store,
      new PrWatchStartIndex(root),
      runner,
      { now: () => new Date(nowMs) },
    );
    const started = await controller.start({
      repoRoot: repo,
      repository: 'example/repo',
      anchorPrNumber: 1,
      idempotencyKey: 'start-green',
      approval: { mode: 'github' },
    });
    expect(started.state.status).toBe('active');
    nowMs += 120_000;
    const first = await controller.pollOnce(started.watchId);
    expect(first.state.status).toBe('active');
    expect(first.state.terminalStability).toBeDefined();
    nowMs += 120_000;
    const second = await controller.pollOnce(started.watchId);
    expect(second.state.status).toBe('terminal');
    if (second.state.status !== 'terminal') throw new Error('expected terminal');
    expect(second.state.outcome).toBe('green');
  });

  it('preserves an explicit max_prs override across polling and revalidation hashes', async () => {
    const root = tempRoot();
    const repo = tempRoot();
    const now = new Date('2026-08-27T12:00:00.000Z');
    const store = new PrWatchStore(root);
    const controller = new PrWatchController(
      store,
      new PrWatchStartIndex(root),
      successfulRunner(() => now),
      { now: () => now },
    );
    const started = await controller.start({
      repoRoot: repo,
      repository: 'example/repo',
      anchorPrNumber: 1,
      idempotencyKey: 'start-explicit-max-prs',
      approval: { mode: 'github' },
      maxPrs: 10,
    });

    expect(started.state.effectiveConfig.maxPrs).toBe(10);
    expect(started.state.policyEvidence).toMatchObject({
      resolvedPolicy: { maxPrsSource: 'tool' },
    });
    const polled = await controller.pollOnce(started.watchId);
    expect(polled.state.status).toBe('active');
  });

  it('preserves immutable verdict sources through blocked revalidation', async () => {
    const root = tempRoot();
    const repo = tempRoot();
    const now = new Date('2026-08-27T12:00:00.000Z');
    const store = new PrWatchStore(root);
    const controller = new PrWatchController(
      store,
      new PrWatchStartIndex(root),
      successfulRunner(() => now),
      { now: () => now },
    );
    const verdictSources = [{ author: 'review-bot', marker: 'All green!' }] as const;
    const started = await controller.start({
      repoRoot: repo,
      repository: 'example/repo',
      anchorPrNumber: 1,
      idempotencyKey: 'start-verdict-revalidation',
      approval: { mode: 'github' },
      verdictSources,
    });
    const blocked = await store.mutate(started.watchId, (state) => transitionToBlocked(state, {
      blocker: {
        causeId: 'provider-timeout-1',
        version: 1,
        kind: 'provider_timeout',
        class: 'revalidate',
        message: 'retry provider evidence',
        evidence: {},
        allowedConsumingReasons: ['blocked_resolved'],
      },
      now,
    }));
    if (blocked.state.status !== 'blocked') throw new Error('expected blocked fixture');

    const revalidated = await controller.revalidateBlocked(started.watchId, {
      expectedGeneration: blocked.state.generation,
      blockerCauseId: blocked.state.blocker.causeId,
      blockerVersion: blocked.state.blocker.version,
      receiptKey: 'revalidate-verdict-sources',
    });

    expect(revalidated.state.policyEvidence).toMatchObject({ verdictSources });
  });

  it('quarantines a corrupt prepared index before allocating a validated replacement', async () => {
    const root = tempRoot();
    const repo = tempRoot();
    const index = new PrWatchStartIndex(root);
    const idempotencyKey = 'corrupt-prepared';
    const startKeyDigest = hashPrWatchStartKey({ repoRoot: realpathSync(repo), idempotencyKey });
    writeFileSync(join(index.root, `${startKeyDigest}.json`), '{"watchId":"../../forged"}\n');
    const controller = new PrWatchController(
      new PrWatchStore(root),
      index,
      successfulRunner(() => new Date('2026-08-27T12:00:00.000Z')),
    );

    const started = await controller.start({
      repoRoot: repo,
      repository: 'example/repo',
      anchorPrNumber: 1,
      idempotencyKey,
      approval: { mode: 'github' },
    });

    expect(started.state.status).toBe('active');
    expect(index.read(startKeyDigest)).toMatchObject({
      status: 'committed',
      watchId: started.watchId,
    });
    expect(readdirSync(index.root).filter((name) => (
      name.startsWith(`${startKeyDigest}.json.corrupt-`)
    ))).toHaveLength(1);
  });
});

function successfulRunner(now: () => Date): ProviderCommandRunner {
  return {
    run: async (spec) => {
      if (spec.args[0] === '--version') {
        return { stdout: 'gh version 2.80.1 (2026-01-01)\n', stderr: '', exitCode: 0 };
      }
      if (spec.args[0] === 'auth') {
        return {
          stdout: '',
          stderr: "Logged in to github.com\nToken scopes: 'repo'\n",
          exitCode: 0,
        };
      }
      const query = spec.args.find((arg) => arg.startsWith('query='))?.slice('query='.length) ?? '';
      if (query.includes('CrewPrWatchDiscovery')) {
        return jsonResult({ data: { repository: { pullRequests: {
          pageInfo: { hasNextPage: false },
          nodes: [discoveryPr()],
        } } } });
      }
      if (query.includes('CrewPrWatchRules')) {
        return jsonResult({ data: { repository: {
          branchProtectionRules: {
            pageInfo: { hasNextPage: false },
            nodes: [{ pattern: 'main', requiredStatusCheckContexts: ['unit'] }],
          },
          rulesets: { pageInfo: { hasNextPage: false }, nodes: [] },
        } } });
      }
      if (query.includes('CrewPrWatchSnapshot')) {
        return jsonResult({ data: {
          viewer: { login: 'watch-bot' },
          rateLimit: {
            cost: 1,
            remaining: 5000,
            resetAt: new Date(now().getTime() + 3_600_000).toISOString(),
          },
          repository: { pr0: snapshotPr() },
        } });
      }
      throw new Error(`unexpected query: ${query.slice(0, 80)}`);
    },
  };
}

function discoveryPr() {
  return {
    number: 1,
    url: 'https://github.com/example/repo/pull/1',
    state: 'OPEN',
    headRefName: 'feature',
    baseRefName: 'main',
    headRefOid: 'abc123',
    headRepository: { nameWithOwner: 'example/repo' },
    baseRepository: { nameWithOwner: 'example/repo' },
    author: { login: 'author' },
    reviewDecision: 'APPROVED',
    commits: { nodes: [{ commit: { committedDate: '2026-08-27T11:00:00.000Z' } }] },
  };
}

function snapshotPr() {
  return {
    ...discoveryPr(),
    reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
    reviews: { pageInfo: { hasNextPage: false }, nodes: [] },
    comments: { pageInfo: { hasNextPage: false }, nodes: [] },
    commits: { nodes: [{ commit: {
      oid: 'abc123',
      committedDate: '2026-08-27T11:00:00.000Z',
      statusCheckRollup: { contexts: {
        pageInfo: { hasNextPage: false },
        nodes: [{
          __typename: 'CheckRun',
          id: 'check-node-1',
          databaseId: 101,
          name: 'unit',
          status: 'COMPLETED',
          conclusion: 'SUCCESS',
        }],
      } },
    } }] },
  };
}

function jsonResult(value: unknown) {
  return { stdout: `${JSON.stringify(value)}\n`, stderr: '', exitCode: 0 };
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'crew-pr-watch-controller-service-'));
  roots.push(root);
  return root;
}
