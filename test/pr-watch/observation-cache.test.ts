import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  GitHubProbeObservation,
  GitHubPullRequestObservation,
  GitHubSnapshotObservation,
} from '../../src/pr-watch/github-observation.js';
import { makePrWatchId } from '../../src/pr-watch/id.js';
import {
  PR_WATCH_FULL_REFRESH_INTERVAL_MS,
  PR_WATCH_OBSERVATION_CACHE_FILE,
  PR_WATCH_OBSERVATION_POLL_FILE,
  cacheAfterFullRefresh,
  mergeDeltaObservation,
  planPrWatchObservation,
  projectedSteadyStatePollCost,
  readPrWatchObservationCache,
  selectDirtyPrNumbers,
  writePrWatchObservationCache,
} from '../../src/pr-watch/observation-cache.js';

const OBSERVED_AT = '2026-09-02T12:00:00.000Z';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('PR-watch delta-polling observation cache', () => {
  it('plans a full refresh without a cache, for another repository, and after the interval', () => {
    const watchId = makePrWatchId();
    const { cache } = cacheAfterFullRefresh({
      prior: undefined,
      watchId,
      snapshot: snapshot([pr(1), pr(2)]),
      reason: 'no_cache',
      cadenceSeconds: 120,
      keepCommentAuthors: [],
    });
    const now = new Date(Date.parse(OBSERVED_AT) + 60_000);
    expect(planPrWatchObservation({ cache: undefined, repository: 'example/repo', now }))
      .toEqual({ mode: 'full', reason: 'no_cache' });
    expect(planPrWatchObservation({ cache, repository: 'other/repo', now }))
      .toEqual({ mode: 'full', reason: 'repository_changed' });
    expect(planPrWatchObservation({ cache, repository: 'example/repo', now }))
      .toMatchObject({ mode: 'delta' });
    expect(planPrWatchObservation({
      cache,
      repository: 'example/repo',
      now: new Date(Date.parse(OBSERVED_AT) + PR_WATCH_FULL_REFRESH_INTERVAL_MS),
    })).toEqual({ mode: 'full', reason: 'interval_elapsed' });
  });

  it('marks a PR dirty for any changed or missing change signal', () => {
    const { cache } = cacheAfterFullRefresh({
      prior: undefined,
      watchId: makePrWatchId(),
      snapshot: snapshot([pr(1), pr(2)]),
      reason: 'no_cache',
      cadenceSeconds: 120,
      keepCommentAuthors: [],
    });
    const unchanged = probe({ 1: pr(1), 2: pr(2) });
    expect(selectDirtyPrNumbers({ probe: unchanged, cache, prNumbers: [1, 2] })).toEqual([]);
    const edited = probe({ 1: pr(1), 2: pr(2, { updatedAt: '2026-09-02T12:05:00.000Z' }) });
    expect(selectDirtyPrNumbers({ probe: edited, cache, prNumbers: [1, 2] })).toEqual([2]);
    const checksFinished = probe({ 1: pr(1, { rollupState: 'FAILURE' }), 2: pr(2) });
    expect(selectDirtyPrNumbers({ probe: checksFinished, cache, prNumbers: [1, 2] })).toEqual([1]);
    const grown = probe({ 1: pr(1), 2: pr(2), 3: pr(3) });
    expect(selectDirtyPrNumbers({ probe: grown, cache, prNumbers: [1, 2, 3] })).toEqual([3]);
    expect(() => selectDirtyPrNumbers({ probe: unchanged, cache, prNumbers: [1, 2, 3] }))
      .toThrow('pr_watch.probe_missing_pr: 3');
  });

  it('projects steady-state spend from the probe, the amortized refresh, and recent detail cost', () => {
    // 50-PR stack: probe 1, full refresh 53 amortized over 7.5 polls, no dirty PRs.
    expect(projectedSteadyStatePollCost({
      probeCost: 1,
      fullRefreshCost: 53,
      recentDetailCosts: [],
      cadenceSeconds: 120,
      fullRefreshIntervalMs: 15 * 60_000,
    })).toBe(9);
    expect(projectedSteadyStatePollCost({
      probeCost: 1,
      fullRefreshCost: 53,
      recentDetailCosts: [0, 0, 3, 0, 53],
      cadenceSeconds: 120,
      fullRefreshIntervalMs: 15 * 60_000,
    })).toBe(20);
    // A single expensive sample in a young window divides by the 5-poll floor.
    expect(projectedSteadyStatePollCost({
      probeCost: 1,
      fullRefreshCost: 53,
      recentDetailCosts: [53],
      cadenceSeconds: 120,
      fullRefreshIntervalMs: 15 * 60_000,
    })).toBe(19);
    expect(projectedSteadyStatePollCost({
      probeCost: 1,
      fullRefreshCost: 53,
      recentDetailCosts: [53, 53, 53, 53, 53, 53, 53, 53, 53, 53],
      cadenceSeconds: 120,
      fullRefreshIntervalMs: 15 * 60_000,
    })).toBe(62);
    // A refresh interval shorter than the cadence never amortizes above one full cost.
    expect(projectedSteadyStatePollCost({
      probeCost: 1,
      fullRefreshCost: 53,
      recentDetailCosts: [],
      cadenceSeconds: 120,
      fullRefreshIntervalMs: 1_000,
    })).toBe(54);
  });

  it('merges cached details with a partial fetch into one full-shaped snapshot', () => {
    const watchId = makePrWatchId();
    const { cache } = cacheAfterFullRefresh({
      prior: undefined,
      watchId,
      snapshot: snapshot([pr(1), pr(2)], { queryCost: 3 }),
      reason: 'no_cache',
      cadenceSeconds: 120,
      keepCommentAuthors: [],
    });
    const refreshedTwo = pr(2, { updatedAt: '2026-09-02T12:05:00.000Z', reviewDecision: 'APPROVED' });
    const dirtyProbe = probe({ 1: pr(1), 2: refreshedTwo }, { queryCost: 1 });
    const merged = mergeDeltaObservation({
      cache,
      probe: dirtyProbe,
      details: snapshot([refreshedTwo], { queryCost: 2, observedAt: '2026-09-02T12:06:00.000Z' }),
      dirtyPrNumbers: [2],
      prNumbers: [1, 2],
      observedAt: '2026-09-02T12:06:00.000Z',
      cadenceSeconds: 120,
      keepCommentAuthors: [],
    });
    expect(merged.snapshot.prs.map((entry) => entry.number)).toEqual([1, 2]);
    expect(merged.snapshot.prs[0]).toEqual(pr(1));
    expect(merged.snapshot.prs[1]).toEqual(refreshedTwo);
    expect(merged.snapshot).toMatchObject({ queryCost: 3, apiCalls: 2, observedAt: '2026-09-02T12:06:00.000Z' });
    expect(merged.cache.lastPoll).toMatchObject({ mode: 'partial', dirtyPrNumbers: [2], probeCost: 1, detailCost: 2 });
    expect(merged.cache.recentDetailCosts).toEqual([2]);
    expect(merged.cache.lastFullRefreshAt).toBe(OBSERVED_AT);

    const quiet = mergeDeltaObservation({
      cache: merged.cache,
      probe: dirtyProbe,
      details: undefined,
      dirtyPrNumbers: [],
      prNumbers: [1, 2],
      observedAt: '2026-09-02T12:08:00.000Z',
      cadenceSeconds: 120,
      keepCommentAuthors: [],
    });
    expect(quiet.snapshot).toMatchObject({ queryCost: 1, apiCalls: 1 });
    expect(quiet.snapshot.prs[1]).toEqual(refreshedTwo);
    expect(quiet.cache.lastPoll).toMatchObject({ mode: 'probe', dirtyPrNumbers: [] });
    expect(quiet.cache.recentDetailCosts).toEqual([2, 0]);

    expect(() => mergeDeltaObservation({
      cache,
      probe: dirtyProbe,
      details: undefined,
      dirtyPrNumbers: [2],
      prNumbers: [1, 2],
      observedAt: OBSERVED_AT,
      cadenceSeconds: 120,
      keepCommentAuthors: [],
    })).toThrow('pr_watch.detail_missing_pr: 2');
  });

  it('round-trips through disk and fails soft on corrupt or foreign caches', () => {
    const root = mkdtempSync(join(tmpdir(), 'crew-pr-watch-observation-cache-'));
    roots.push(root);
    const watchId = makePrWatchId();
    const { cache } = cacheAfterFullRefresh({
      prior: undefined,
      watchId,
      snapshot: snapshot([pr(1)]),
      reason: 'no_cache',
      cadenceSeconds: 120,
      keepCommentAuthors: [],
    });
    expect(readPrWatchObservationCache(root, watchId)).toBeUndefined();
    expect(writePrWatchObservationCache(root, cache, { detailsChanged: true })).toBe(true);
    expect(readPrWatchObservationCache(root, watchId)).toEqual(cache);
    expect(readPrWatchObservationCache(root, makePrWatchId())).toBeUndefined();

    const detailsPath = join(root, PR_WATCH_OBSERVATION_CACHE_FILE);
    const pollPath = join(root, PR_WATCH_OBSERVATION_POLL_FILE);
    const detailsBytes = readFileSync(detailsPath, 'utf-8');
    writeFileSync(pollPath, '{"schemaVersion":1');
    expect(readPrWatchObservationCache(root, watchId)).toEqual({
      ...cache,
      recentDetailCosts: [],
      lastPoll: undefined,
    });
    writeFileSync(detailsPath, detailsBytes.slice(0, 40));
    expect(readPrWatchObservationCache(root, watchId)).toBeUndefined();
    writeFileSync(detailsPath, JSON.stringify({
      ...JSON.parse(detailsBytes) as object,
      prs: { '9': cache.prs['1'] },
    }));
    expect(readPrWatchObservationCache(root, watchId)).toBeUndefined();
    expect(writePrWatchObservationCache(join(root, 'missing-dir'), cache, { detailsChanged: true })).toBe(false);
  });

  it('folds a terminal-candidate re-read into the same poll instead of resetting it', () => {
    const watchId = makePrWatchId();
    const seeded = cacheAfterFullRefresh({
      prior: undefined,
      watchId,
      snapshot: snapshot([pr(1)], { queryCost: 53 }),
      reason: 'no_cache',
      cadenceSeconds: 120,
      keepCommentAuthors: [],
    });
    const quiet = mergeDeltaObservation({
      cache: seeded.cache,
      probe: probe({ 1: pr(1) }, { queryCost: 1 }),
      details: undefined,
      dirtyPrNumbers: [],
      prNumbers: [1],
      observedAt: '2026-09-02T12:02:00.000Z',
      cadenceSeconds: 120,
      keepCommentAuthors: [],
    });
    expect(quiet.cache.recentDetailCosts).toEqual([0]);
    const reread = cacheAfterFullRefresh({
      prior: quiet.cache,
      watchId,
      snapshot: snapshot([pr(1)], { queryCost: 53, observedAt: '2026-09-02T12:02:05.000Z' }),
      reason: 'terminal_candidate',
      cadenceSeconds: 120,
      keepCommentAuthors: [],
      continuation: { queryCost: quiet.snapshot.queryCost, apiCalls: quiet.snapshot.apiCalls },
    });
    expect(reread.cache.recentDetailCosts).toEqual([53]);
    expect(reread.cache.lastPoll).toMatchObject({
      mode: 'full',
      fullRefreshReason: 'terminal_candidate',
      apiCalls: 2,
      probeCost: 1,
      detailCost: 53,
    });
    expect(reread.projectedPollCost).toBe(19);
  });

  it('keeps only verdict-source comment bodies in the cache', () => {
    const noisy = pr(1);
    const withComments: GitHubPullRequestObservation = {
      ...noisy,
      comments: [
        { id: 'c1', author: 'Review-Bot', updatedAt: OBSERVED_AT, body: 'Verdict: approve' },
        { id: 'c2', author: 'human', updatedAt: OBSERVED_AT, body: 'x'.repeat(10_000) },
      ],
    };
    const { cache } = cacheAfterFullRefresh({
      prior: undefined,
      watchId: makePrWatchId(),
      snapshot: snapshot([withComments]),
      reason: 'no_cache',
      cadenceSeconds: 120,
      keepCommentAuthors: ['review-bot'],
    });
    expect(cache.prs['1']?.comments.map((comment) => comment.id)).toEqual(['c1']);
    const merged = mergeDeltaObservation({
      cache,
      probe: probe({ 1: withComments }),
      details: snapshot([withComments]),
      dirtyPrNumbers: [1],
      prNumbers: [1],
      observedAt: OBSERVED_AT,
      cadenceSeconds: 120,
      keepCommentAuthors: ['review-bot'],
    });
    // The evaluator still sees the full fresh detail; only the cache is compacted.
    expect(merged.snapshot.prs[0].comments).toHaveLength(2);
    expect(merged.cache.prs['1']?.comments.map((comment) => comment.id)).toEqual(['c1']);
  });

  it('rewrites the detail file only when a detail fetch happened', () => {
    const root = mkdtempSync(join(tmpdir(), 'crew-pr-watch-observation-cache-'));
    roots.push(root);
    const watchId = makePrWatchId();
    const { cache } = cacheAfterFullRefresh({
      prior: undefined,
      watchId,
      snapshot: snapshot([pr(1), pr(2)]),
      reason: 'no_cache',
      cadenceSeconds: 120,
      keepCommentAuthors: [],
    });
    expect(writePrWatchObservationCache(root, cache, { detailsChanged: true })).toBe(true);
    const detailsPath = join(root, PR_WATCH_OBSERVATION_CACHE_FILE);
    const before = readFileSync(detailsPath, 'utf-8');

    const quiet = mergeDeltaObservation({
      cache,
      probe: probe({ 1: pr(1), 2: pr(2) }),
      details: undefined,
      dirtyPrNumbers: [],
      prNumbers: [1, 2],
      observedAt: '2026-09-02T12:02:00.000Z',
      cadenceSeconds: 120,
      keepCommentAuthors: [],
    });
    expect(quiet.detailsChanged).toBe(false);
    writeFileSync(detailsPath, `${before}\n`);
    expect(writePrWatchObservationCache(root, quiet.cache, { detailsChanged: quiet.detailsChanged })).toBe(true);
    expect(readFileSync(detailsPath, 'utf-8')).toBe(`${before}\n`);
    expect(readPrWatchObservationCache(root, watchId)?.lastPoll).toMatchObject({ mode: 'probe' });
  });
});

function pr(
  number: number,
  signal: Partial<NonNullable<GitHubPullRequestObservation['changeSignal']>> = {},
): GitHubPullRequestObservation {
  const changeSignal = {
    state: 'OPEN' as const,
    updatedAt: '2026-09-02T11:00:00.000Z',
    headSha: `sha-${number}`,
    baseRefName: number === 1 ? 'main' : `branch-${number - 1}`,
    reviewDecision: 'REVIEW_REQUIRED' as const,
    isDraft: false,
    rollupState: 'SUCCESS' as const,
    ...signal,
  };
  return {
    number,
    url: `https://github.com/example/repo/pull/${number}`,
    state: changeSignal.state,
    headRefName: `branch-${number}`,
    baseRefName: changeSignal.baseRefName,
    headRepository: 'example/repo',
    baseRepository: 'example/repo',
    headSha: changeSignal.headSha,
    headCommittedAt: '2026-09-02T10:00:00.000Z',
    author: 'author',
    reviewDecision: changeSignal.reviewDecision,
    checks: [{ context: 'unit', sourceId: `check-${number}`, attempt: 1, status: 'COMPLETED', conclusion: 'SUCCESS' }],
    reviews: [],
    threads: [],
    comments: [],
    paginationComplete: true,
    detailsComplete: true,
    changeSignal,
  };
}

function snapshot(
  prs: readonly GitHubPullRequestObservation[],
  overrides: Partial<GitHubSnapshotObservation> = {},
): GitHubSnapshotObservation {
  return {
    repository: 'example/repo',
    viewer: 'watch-bot',
    observedAt: OBSERVED_AT,
    prs,
    queryCost: 1,
    rateRemaining: 5000,
    rateResetAt: '2026-09-02T13:00:00.000Z',
    apiCalls: 1,
    ...overrides,
  };
}

function probe(
  prs: Readonly<Record<number, GitHubPullRequestObservation>>,
  overrides: Partial<GitHubProbeObservation> = {},
): GitHubProbeObservation {
  return {
    repository: 'example/repo',
    viewer: 'watch-bot',
    observedAt: OBSERVED_AT,
    signals: Object.fromEntries(Object.entries(prs).map(([key, value]) => [key, value.changeSignal!])),
    queryCost: 1,
    rateRemaining: 4999,
    rateResetAt: '2026-09-02T13:00:00.000Z',
    ...overrides,
  };
}
