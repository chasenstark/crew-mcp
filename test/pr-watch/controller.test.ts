import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { PrWatchController, type PrWatchCircleCiReader } from '../../src/pr-watch/controller.js';
import { hashPrWatchStartKey } from '../../src/pr-watch/id.js';
import {
  PR_WATCH_OBSERVATION_CACHE_FILE,
  PR_WATCH_OBSERVATION_POLL_FILE,
  readPrWatchObservationCache,
} from '../../src/pr-watch/observation-cache.js';
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

describe('PrWatchController delta polling', () => {
  it('takes one full snapshot, then probe-only polls while nothing changes', async () => {
    const fixture = deltaFixture();
    const started = await startStack(fixture);

    fixture.advance(120_000);
    const first = await fixture.controller.pollOnce(started.watchId);
    expect(first.state.status).toBe('active');
    expect(fixture.calls).toEqual([{ kind: 'snapshot', numbers: [1, 2] }]);

    fixture.advance(120_000);
    const second = await fixture.controller.pollOnce(started.watchId);
    expect(second.state.status).toBe('active');
    expect(fixture.calls).toEqual([
      { kind: 'snapshot', numbers: [1, 2] },
      { kind: 'probe', numbers: [1, 2] },
    ]);
    expect(second.state.lastObservation).toMatchObject({
      queryCost: 1,
      incompleteReasons: ['pr_1:approval_incomplete', 'pr_2:approval_incomplete'],
    });
    const cache = readPrWatchObservationCache(fixture.store.watchDir(started.watchId), started.watchId);
    expect(cache?.lastPoll).toMatchObject({ mode: 'probe', apiCalls: 1, probeCost: 1, detailCost: 0, dirtyPrNumbers: [] });
    expect(Object.keys(cache?.prs ?? {})).toEqual(['1', '2']);
  });

  it('re-fetches only the PRs whose change signal moved and evaluates the merged stack', async () => {
    const fixture = deltaFixture();
    const started = await startStack(fixture);
    fixture.advance(120_000);
    await fixture.controller.pollOnce(started.watchId);

    fixture.prs.set(2, stackPr(2, 'branch-1', {
      updatedAt: '2026-09-02T12:03:00.000Z',
      reviewDecision: 'APPROVED',
    }));
    fixture.advance(120_000);
    const polled = await fixture.controller.pollOnce(started.watchId);

    expect(fixture.calls.slice(1)).toEqual([
      { kind: 'probe', numbers: [1, 2] },
      { kind: 'snapshot', numbers: [2] },
    ]);
    expect(polled.state.lastObservation).toMatchObject({
      queryCost: 2,
      incompleteReasons: ['pr_1:approval_incomplete'],
    });
    const cache = readPrWatchObservationCache(fixture.store.watchDir(started.watchId), started.watchId);
    expect(cache?.lastPoll).toMatchObject({ mode: 'partial', apiCalls: 2, dirtyPrNumbers: [2] });
    expect(cache?.prs['1']?.reviewDecision).toBe('REVIEW_REQUIRED');
    expect(cache?.prs['2']?.reviewDecision).toBe('APPROVED');
  });

  it('forces a full refresh once the interval elapses or the cache is unreadable', async () => {
    const fixture = deltaFixture({ fullRefreshIntervalMs: 300_000 });
    const started = await startStack(fixture);
    for (let poll = 0; poll < 4; poll += 1) {
      fixture.advance(120_000);
      await fixture.controller.pollOnce(started.watchId);
    }
    expect(fixture.calls.map((call) => call.kind)).toEqual(['snapshot', 'probe', 'probe', 'snapshot']);
    const watchDir = fixture.store.watchDir(started.watchId);
    expect(readPrWatchObservationCache(watchDir, started.watchId)?.lastPoll)
      .toMatchObject({ mode: 'full', fullRefreshReason: 'interval_elapsed' });

    writeFileSync(join(watchDir, PR_WATCH_OBSERVATION_CACHE_FILE), '{"schemaVersion":1');
    fixture.advance(120_000);
    const recovered = await fixture.controller.pollOnce(started.watchId);
    expect(recovered.state.status).toBe('active');
    expect(fixture.calls.at(-1)).toEqual({ kind: 'snapshot', numbers: [1, 2] });
    expect(readPrWatchObservationCache(watchDir, started.watchId)?.lastPoll)
      .toMatchObject({ mode: 'full', fullRefreshReason: 'no_cache' });
  });

  it('keeps an expensive stack under the rate projection through amortized steady-state cost', async () => {
    const fixture = deltaFixture({ snapshotCost: 53 });
    const started = await startStack(fixture);
    fixture.advance(120_000);
    const first = await fixture.controller.pollOnce(started.watchId);
    expect(first.state.status).toBe('active');
    // Probe estimate 1 + a 53-point refresh amortized over 7.5 polls, times 30 polls to reset.
    expect(first.state.lastObservation).toMatchObject({ queryCost: 53, projectedPointSpend: 9 * 30 });
    expect(first.state.lastObservation?.incompleteReasons).not.toContain('github_rate_projection_exceeded');
  });

  it('projects the actual poll cost when the cache cannot be persisted', async () => {
    const fixture = deltaFixture({ snapshotCost: 53 });
    const started = await startStack(fixture);
    // A directory at the cache path defeats both the read and the atomic rename.
    mkdirSync(join(fixture.store.watchDir(started.watchId), PR_WATCH_OBSERVATION_CACHE_FILE));
    fixture.advance(120_000);
    const polled = await fixture.controller.pollOnce(started.watchId);
    expect(fixture.calls).toEqual([{ kind: 'snapshot', numbers: [1, 2] }]);
    expect(polled.state.status).toBe('blocked');
    if (polled.state.status !== 'blocked') throw new Error('expected blocked');
    expect(polled.state.blocker).toMatchObject({
      kind: 'evidence_incomplete',
      evidence: { projectedPointSpend: 53 * 30 },
    });
  });

  it('never certifies a terminal outcome from cached detail', async () => {
    const fixture = deltaFixture();
    fixture.prs.set(1, stackPr(1, 'main', { reviewDecision: 'APPROVED' }));
    fixture.prs.set(2, stackPr(2, 'branch-1', { reviewDecision: 'APPROVED' }));
    const started = await startStack(fixture);
    fixture.advance(120_000);
    const first = await fixture.controller.pollOnce(started.watchId);
    expect(first.state.status).toBe('active');
    expect(first.state.terminalStability).toBeDefined();

    // Unresolve a thread on PR 2 without moving any probe field: the kind of
    // change the probe cannot see and the cache would happily reuse.
    fixture.prs.set(2, stackPr(2, 'branch-1', { reviewDecision: 'APPROVED', unresolvedThread: true }));
    fixture.advance(120_000);
    const second = await fixture.controller.pollOnce(started.watchId);
    expect(fixture.calls.slice(1)).toEqual([
      { kind: 'probe', numbers: [1, 2] },
      { kind: 'snapshot', numbers: [1, 2] },
    ]);
    expect(second.state.status).toBe('actionable');
    const watchDir = fixture.store.watchDir(started.watchId);
    expect(readPrWatchObservationCache(watchDir, started.watchId)?.lastPoll).toMatchObject({
      mode: 'full',
      fullRefreshReason: 'terminal_candidate',
      apiCalls: 2,
      probeCost: 1,
      detailCost: 1,
    });
  });

  it('confirms a green stack from a fresh full read and accounts for both reads', async () => {
    const fixture = deltaFixture({ snapshotCost: 53 });
    fixture.prs.set(1, stackPr(1, 'main', { reviewDecision: 'APPROVED' }));
    fixture.prs.set(2, stackPr(2, 'branch-1', { reviewDecision: 'APPROVED' }));
    const started = await startStack(fixture);
    fixture.advance(120_000);
    await fixture.controller.pollOnce(started.watchId);
    fixture.advance(120_000);
    const second = await fixture.controller.pollOnce(started.watchId);
    expect(fixture.calls.map((call) => call.kind)).toEqual(['snapshot', 'probe', 'snapshot']);
    expect(second.state).toMatchObject({ status: 'terminal', outcome: 'green' });
    // Probe 1 + forced re-read 53 are both charged to this poll; the re-read
    // folds into the detail window ([53] over a 5-sample floor = 10.6), so the
    // projection is 1 + 53×120/900 + 10.6 → 19 per poll, not 9 and not 63.
    expect(second.state.lastObservation).toMatchObject({ queryCost: 54, projectedPointSpend: 19 * 30 });
  });

  it('carries a delta-phase persistence failure through the forced re-read', async () => {
    const fixture = deltaFixture({ snapshotCost: 53 });
    fixture.prs.set(1, stackPr(1, 'main', { reviewDecision: 'APPROVED' }));
    fixture.prs.set(2, stackPr(2, 'branch-1', { reviewDecision: 'APPROVED' }));
    const started = await startStack(fixture);
    fixture.advance(120_000);
    await fixture.controller.pollOnce(started.watchId);
    // Details stay readable; only the per-poll record becomes unwritable, so
    // the probe phase persists its details but not its cost window. The
    // forced full re-read must not treat its own successful write as proof
    // that the whole poll persisted.
    const watchDir = fixture.store.watchDir(started.watchId);
    const pollPath = join(watchDir, PR_WATCH_OBSERVATION_POLL_FILE);
    rmSync(pollPath);
    mkdirSync(pollPath);
    // Clear the obstruction right before the forced full read so its own
    // write succeeds; only the carried-over failure can keep the poll unpersisted.
    fixture.beforeSnapshot = () => rmSync(pollPath, { recursive: true, force: true });
    fixture.advance(120_000);
    const second = await fixture.controller.pollOnce(started.watchId);
    expect(fixture.calls.map((call) => call.kind)).toEqual(['snapshot', 'probe', 'snapshot']);
    expect(statSync(pollPath).isFile()).toBe(true);
    expect(readPrWatchObservationCache(watchDir, started.watchId)?.lastPoll)
      .toMatchObject({ mode: 'full', fullRefreshReason: 'terminal_candidate' });
    expect(second.state.status).toBe('blocked');
    if (second.state.status !== 'blocked') throw new Error('expected blocked');
    expect(second.state.blocker).toMatchObject({
      kind: 'evidence_incomplete',
      evidence: { projectedPointSpend: 54 * 30 },
    });
  });

  it('lets pending CircleCI evidence veto a terminal candidate before any forced re-read', async () => {
    const fixture = deltaFixture({
      circleci: {
        read: async ({ headSha }) => [{
          workflowName: 'build',
          headSha,
          state: 'running',
          observedAt: '2026-09-02T12:00:00.000Z',
          attempt: 1,
        }],
      },
    });
    writeFileSync(
      join(fixture.repo, '.crew', 'pr-watch.yaml'),
      'schema_version: 1\nci:\n  circleci:\n    required_workflows: [build]\n',
    );
    fixture.prs.set(1, stackPr(1, 'main', { reviewDecision: 'APPROVED' }));
    fixture.prs.set(2, stackPr(2, 'branch-1', { reviewDecision: 'APPROVED' }));
    const started = await startStack(fixture);
    for (let poll = 0; poll < 3; poll += 1) {
      fixture.advance(120_000);
      const polled = await fixture.controller.pollOnce(started.watchId);
      expect(polled.state.status).toBe('active');
      expect(polled.state.lastObservation?.incompleteReasons)
        .toEqual(['circleci:build:running', 'circleci:build:running']);
    }
    expect(fixture.calls.map((call) => call.kind)).toEqual(['snapshot', 'probe', 'probe']);
  });
});

interface StackPr {
  readonly number: number;
  readonly baseRefName: string;
  readonly headSha: string;
  readonly updatedAt: string;
  readonly reviewDecision: 'APPROVED' | 'REVIEW_REQUIRED';
  /** Detail-only state the probe cannot observe. */
  readonly unresolvedThread?: boolean;
}

interface DeltaFixture {
  readonly repo: string;
  readonly store: PrWatchStore;
  readonly controller: PrWatchController;
  readonly calls: Array<{ kind: string; numbers: number[] }>;
  readonly prs: Map<number, StackPr>;
  /** Runs inside the fake provider just before it answers a snapshot query. */
  beforeSnapshot?: (numbers: readonly number[]) => void;
  advance(ms: number): void;
}

function deltaFixture(options: {
  readonly fullRefreshIntervalMs?: number;
  readonly snapshotCost?: number;
  readonly circleci?: PrWatchCircleCiReader;
} = {}): DeltaFixture {
  const root = tempRoot();
  const repo = tempRoot();
  mkdirSync(join(repo, '.crew'));
  let nowMs = Date.parse('2026-09-02T12:00:00.000Z');
  const calls: Array<{ kind: string; numbers: number[] }> = [];
  const prs = new Map<number, StackPr>([
    [1, stackPr(1, 'main')],
    [2, stackPr(2, 'branch-1')],
  ]);
  const store = new PrWatchStore(root);
  const hooks: { beforeSnapshot?: (numbers: readonly number[]) => void } = {};
  const controller = new PrWatchController(
    store,
    new PrWatchStartIndex(root),
    stackRunner({
      now: () => new Date(nowMs),
      prs: () => [...prs.values()],
      calls,
      snapshotCost: options.snapshotCost ?? 1,
      beforeSnapshot: (numbers) => hooks.beforeSnapshot?.(numbers),
    }),
    {
      now: () => new Date(nowMs),
      ...(options.fullRefreshIntervalMs !== undefined
        ? { fullRefreshIntervalMs: options.fullRefreshIntervalMs }
        : {}),
      ...(options.circleci ? { circleci: options.circleci } : {}),
    },
  );
  return {
    repo,
    store,
    controller,
    calls,
    prs,
    set beforeSnapshot(hook: ((numbers: readonly number[]) => void) | undefined) {
      hooks.beforeSnapshot = hook;
    },
    advance: (ms) => { nowMs += ms; },
  };
}

async function startStack(fixture: DeltaFixture) {
  const started = await fixture.controller.start({
    repoRoot: fixture.repo,
    repository: 'example/repo',
    anchorPrNumber: 1,
    idempotencyKey: 'delta-stack',
    approval: { mode: 'github' },
  });
  expect(started.state.status).toBe('active');
  expect(Object.keys(started.state.expectedHeads)).toEqual(['1', '2']);
  fixture.calls.length = 0;
  return started;
}

function stackPr(number: number, baseRefName: string, overrides: Partial<StackPr> = {}): StackPr {
  return {
    number,
    baseRefName,
    headSha: `sha-${number}`,
    updatedAt: '2026-09-02T11:00:00.000Z',
    reviewDecision: 'REVIEW_REQUIRED',
    ...overrides,
  };
}

function stackRunner(args: {
  readonly now: () => Date;
  readonly prs: () => readonly StackPr[];
  readonly calls: Array<{ kind: string; numbers: number[] }>;
  readonly snapshotCost: number;
  readonly beforeSnapshot?: (numbers: readonly number[]) => void;
}): ProviderCommandRunner {
  const rateLimit = (cost: number) => ({
    cost,
    remaining: 5000,
    resetAt: new Date(args.now().getTime() + 3_600_000).toISOString(),
  });
  const requested = (query: string) => (
    [...query.matchAll(/pullRequest\(number: (\d+)\)/g)].map((match) => Number(match[1]))
  );
  const find = (number: number): StackPr => {
    const pr = args.prs().find((candidate) => candidate.number === number);
    if (!pr) throw new Error(`unknown fixture PR ${number}`);
    return pr;
  };
  return {
    run: async (spec) => {
      if (spec.args[0] === '--version') {
        return { stdout: 'gh version 2.80.1 (2026-01-01)\n', stderr: '', exitCode: 0 };
      }
      if (spec.args[0] === 'auth') {
        return { stdout: '', stderr: "Logged in to github.com\nToken scopes: 'repo'\n", exitCode: 0 };
      }
      const query = spec.args.find((arg) => arg.startsWith('query='))?.slice('query='.length) ?? '';
      if (query.includes('CrewPrWatchDiscovery')) {
        return jsonResult({ data: { repository: { pullRequests: {
          pageInfo: { hasNextPage: false },
          nodes: args.prs().map(stackDiscoveryPr),
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
      if (query.includes('CrewPrWatchProbe')) {
        const numbers = requested(query);
        args.calls.push({ kind: 'probe', numbers });
        return jsonResult({ data: {
          viewer: { login: 'watch-bot' },
          rateLimit: rateLimit(1),
          repository: Object.fromEntries(numbers.map((number, index) => [`pr${index}`, stackProbePr(find(number))])),
        } });
      }
      if (query.includes('CrewPrWatchSnapshot')) {
        const numbers = requested(query);
        args.calls.push({ kind: 'snapshot', numbers });
        args.beforeSnapshot?.(numbers);
        return jsonResult({ data: {
          viewer: { login: 'watch-bot' },
          rateLimit: rateLimit(args.snapshotCost),
          repository: Object.fromEntries(numbers.map((number, index) => [`pr${index}`, stackSnapshotPr(find(number))])),
        } });
      }
      throw new Error(`unexpected query: ${query.slice(0, 80)}`);
    },
  };
}

function stackDiscoveryPr(pr: StackPr) {
  return {
    number: pr.number,
    url: `https://github.com/example/repo/pull/${pr.number}`,
    state: 'OPEN',
    headRefName: `branch-${pr.number}`,
    baseRefName: pr.baseRefName,
    headRefOid: pr.headSha,
    headRepository: { nameWithOwner: 'example/repo' },
    baseRepository: { nameWithOwner: 'example/repo' },
    author: { login: 'author' },
    reviewDecision: pr.reviewDecision,
    commits: { nodes: [{ commit: { committedDate: '2026-09-02T10:00:00.000Z' } }] },
  };
}

function stackProbePr(pr: StackPr) {
  return {
    number: pr.number,
    state: 'OPEN',
    updatedAt: pr.updatedAt,
    headRefOid: pr.headSha,
    baseRefName: pr.baseRefName,
    reviewDecision: pr.reviewDecision,
    isDraft: false,
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  };
}

function stackSnapshotPr(pr: StackPr) {
  return {
    ...stackDiscoveryPr(pr),
    updatedAt: pr.updatedAt,
    isDraft: false,
    reviewThreads: {
      pageInfo: { hasNextPage: false },
      nodes: pr.unresolvedThread
        ? [{
            id: `thread-${pr.number}`,
            isResolved: false,
            isOutdated: false,
            comments: { nodes: [{ databaseId: 500 + pr.number, updatedAt: pr.updatedAt }] },
          }]
        : [],
    },
    reviews: { pageInfo: { hasNextPage: false }, nodes: [] },
    comments: { pageInfo: { hasNextPage: false }, nodes: [] },
    commits: { nodes: [{ commit: {
      oid: pr.headSha,
      committedDate: '2026-09-02T10:00:00.000Z',
      statusCheckRollup: { state: 'SUCCESS', contexts: {
        pageInfo: { hasNextPage: false },
        nodes: [{
          __typename: 'CheckRun',
          id: `check-${pr.number}`,
          databaseId: 100 + pr.number,
          name: 'unit',
          status: 'COMPLETED',
          conclusion: 'SUCCESS',
        }],
      } },
    } }] },
  };
}

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
      if (query.includes('CrewPrWatchProbe')) {
        return jsonResult({ data: {
          viewer: { login: 'watch-bot' },
          rateLimit: {
            cost: 1,
            remaining: 5000,
            resetAt: new Date(now().getTime() + 3_600_000).toISOString(),
          },
          repository: { pr0: probePr() },
        } });
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

function probePr() {
  return {
    number: 1,
    state: 'OPEN',
    updatedAt: '2026-08-27T11:30:00.000Z',
    headRefOid: 'abc123',
    baseRefName: 'main',
    reviewDecision: 'APPROVED',
    isDraft: false,
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
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
    updatedAt: '2026-08-27T11:30:00.000Z',
    isDraft: false,
    reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
    reviews: { pageInfo: { hasNextPage: false }, nodes: [] },
    comments: { pageInfo: { hasNextPage: false }, nodes: [] },
    commits: { nodes: [{ commit: {
      oid: 'abc123',
      committedDate: '2026-08-27T11:00:00.000Z',
      statusCheckRollup: { state: 'SUCCESS', contexts: {
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
