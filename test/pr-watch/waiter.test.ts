import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { sha256Canonical } from '../../src/pr-watch/canonical.js';
import { PrWatchController } from '../../src/pr-watch/controller.js';
import { makePrWatchId, makePrWatchTransactionId } from '../../src/pr-watch/id.js';
import type { ProviderCommandRunner } from '../../src/pr-watch/provider-runner.js';
import {
  createInitialPrWatchState,
  markPrWatchTerminal,
  transitionToBlocked,
} from '../../src/pr-watch/reducer.js';
import { PrWatchStore } from '../../src/pr-watch/store.js';
import { PrWatchStartIndex } from '../../src/pr-watch/start-index.js';
import { deliverClaimedCodexPrWatchWake, waitForPrWatch } from '../../src/pr-watch/waiter.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('PR-watch waiter wake delivery', () => {
  it('does not mark a remedy delivered when the wake transport skips turn start', async () => {
    const { store, watchId, initial } = await createFixture();
    const controller = {
      pollOnce: async () => {
        const blocked = await store.mutate(watchId, (state) => transitionToBlocked(state, {
          blocker: blocker(),
        }));
        return { state: blocked.state, queried: true };
      },
    } as PrWatchController;

    await waitForPrWatch({
      store,
      controller,
      watchId,
      generation: initial.generation,
      watcherActionId: initial.waiter.watcherActionId,
      pollIntervalMs: 1,
      leaseMs: 60_000,
      wake: async () => ({ started: false }),
    });

    const state = store.read(watchId).state;
    if (state.status !== 'blocked') throw new Error('expected blocked state');
    const surface = state.blockerSurfaces.find(
      (candidate) => candidate.surfaceId === state.currentBlockerSurfaceId,
    );
    expect(surface?.state).toBe('claimed');
    expect(surface?.deliveredAt).toBeUndefined();
  });

  it('does not mark a remedy delivered when no wake transport is configured', async () => {
    const { store, watchId, initial } = await createFixture();
    const controller = {
      pollOnce: async () => {
        const blocked = await store.mutate(watchId, (state) => transitionToBlocked(state, {
          blocker: blocker(),
        }));
        return { state: blocked.state, queried: true };
      },
    } as PrWatchController;

    await waitForPrWatch({
      store,
      controller,
      watchId,
      generation: initial.generation,
      watcherActionId: initial.waiter.watcherActionId,
      pollIntervalMs: 1,
      leaseMs: 60_000,
    });

    const state = store.read(watchId).state;
    if (state.status !== 'blocked') throw new Error('expected blocked state');
    const surface = state.blockerSurfaces.find(
      (candidate) => candidate.surfaceId === state.currentBlockerSurfaceId,
    );
    expect(surface?.state).toBe('claimed');
    expect(surface?.deliveredAt).toBeUndefined();
  });

  it('observes incomplete exact-head approval, dwells on complete evidence, and queues one Codex wake', async () => {
    const crewHome = tempRoot('crew-pr-watch-lifecycle-home-');
    const repoRoot = tempRoot('crew-pr-watch-lifecycle-repo-');
    const store = new PrWatchStore(crewHome);
    let nowMs = Date.parse('2026-08-28T18:26:51.000Z');
    let snapshotCount = 0;
    const controller = new PrWatchController(
      store,
      new PrWatchStartIndex(crewHome),
      approvalRunner(() => new Date(nowMs), () => {
        snapshotCount += 1;
        return snapshotCount >= 3;
      }),
      { now: () => new Date(nowMs) },
    );
    const started = await controller.start({
      repoRoot,
      repository: 'example/repo',
      anchorPrNumber: 42,
      idempotencyKey: 'waiter-full-lifecycle',
      approval: {
        mode: 'github',
        goals: [{ pr: 42, mode: 'reviewer_head', reviewer: '143-dev' }],
      },
      scope: 'single',
    });
    if (started.state.status !== 'active') throw new Error('expected active watch');
    let sleepCount = 0;
    let queuedWakeCount = 0;

    const result = await waitForPrWatch({
      store,
      controller,
      watchId: started.watchId,
      generation: started.state.generation,
      watcherActionId: started.state.waiter.watcherActionId,
      pollIntervalMs: 120_000,
      leaseMs: 180_000,
      now: () => new Date(nowMs),
      sleep: async (ms) => {
        expect(ms).toBe(120_000);
        sleepCount += 1;
        const state = store.read(started.watchId).state;
        if (sleepCount === 1) {
          expect(state.lastObservation).toMatchObject({
            complete: false,
            incompleteReasons: ['pr_42:approval_incomplete'],
          });
          expect(state.terminalStability).toBeUndefined();
        } else {
          expect(state.lastObservation).toMatchObject({ complete: true, incompleteReasons: [] });
          expect(state.terminalStability).toBeDefined();
        }
        nowMs += ms;
      },
      transport: 'codex_queue',
      wake: async ({ state }) => {
        const claimed = await deliverClaimedCodexPrWatchWake({
          store,
          state,
          threadId: '00000000-0000-4000-8000-000000000001',
          startTurn: async () => {
            queuedWakeCount += 1;
            return { queued: true };
          },
        });
        return { started: claimed.started };
      },
    });

    expect(result.state).toMatchObject({ status: 'terminal', outcome: 'green' });
    expect(result.outcome).toBe('terminal');
    expect(snapshotCount).toBe(4);
    expect(sleepCount).toBe(2);
    expect(queuedWakeCount).toBe(1);
    const trace = readProcessTrace(crewHome);
    expect(trace.map((record) => record.event)).toEqual(['start', 'wake', 'exit']);
    expect(trace[1]).toMatchObject({ status: 'terminal', transport: 'codex_queue' });
    expect(trace[2]).toMatchObject({ status: 'terminal' });
  });

  it('renews the waiter lease independently while provider polling is held', async () => {
    const { store, watchId, initial } = await createFixture();
    const pollStarted = deferred<void>();
    const releasePoll = deferred<void>();
    const controller = {
      pollOnce: async () => {
        pollStarted.resolve();
        await releasePoll.promise;
        const terminal = await store.mutate(watchId, (state) => markPrWatchTerminal(state, {
          outcome: 'green',
          fingerprint: 'heartbeat-test-terminal',
        }));
        return { state: terminal.state, queried: true };
      },
    } as PrWatchController;
    const waiting = waitForPrWatch({
      store,
      controller,
      watchId,
      generation: initial.generation,
      watcherActionId: initial.waiter.watcherActionId,
      pollIntervalMs: 1,
      leaseMs: 60_000,
      heartbeatIntervalMs: 10,
      wake: async () => ({ started: true }),
    });
    await pollStarted.promise;
    const claimedHeartbeat = store.read(watchId).state;
    const firstHeartbeatAt = claimedHeartbeat.status === 'active'
      ? claimedHeartbeat.waiter.leaseHeartbeatAt
      : undefined;

    await expect.poll(() => {
      const state = store.read(watchId).state;
      return state.status === 'active' ? state.waiter.leaseHeartbeatAt : undefined;
    }, { timeout: 1_000 }).not.toBe(firstHeartbeatAt);
    releasePoll.resolve();

    await expect(waiting).resolves.toMatchObject({ outcome: 'terminal' });
  });

  it('stops waiting when cancellation arrives during a provider poll that ignores abort', async () => {
    const { store, watchId, initial } = await createFixture();
    const pollStarted = deferred<void>();
    const controller = {
      pollOnce: async () => {
        pollStarted.resolve();
        return await new Promise<never>(() => {});
      },
    } as PrWatchController;
    const abort = new AbortController();
    const waiting = waitForPrWatch({
      store,
      controller,
      watchId,
      generation: initial.generation,
      watcherActionId: initial.waiter.watcherActionId,
      pollIntervalMs: 1,
      leaseMs: 60_000,
      heartbeatIntervalMs: 10,
      signal: abort.signal,
    });
    await pollStarted.promise;
    abort.abort();

    await expect(waiting).rejects.toThrow('pr_watch.waiter_cancelled');
  });
});

async function createFixture() {
  const crewHome = mkdtempSync(join(tmpdir(), 'crew-pr-watch-waiter-'));
  roots.push(crewHome);
  const store = new PrWatchStore(crewHome);
  const watchId = makePrWatchId();
  const initial = createInitialPrWatchState({
    watchId,
    initialization: {
      repository: 'example/repo',
      anchorPrNumber: 42,
      repoRoot: '/tmp/example',
      effectiveConfig: {
        maxPrs: 50,
        maxActionableWakes: 20,
        maxActionRounds: 5,
        maxWatchAgeDays: -1,
        policyHash: sha256Canonical({ mode: 'github_rules' }),
      },
      expectedHeads: { '42': 'abc123' },
    },
  });
  await store.create(initial, makePrWatchTransactionId());
  return { crewHome, store, watchId, initial };
}

function blocker() {
  return {
    causeId: 'provider-auth',
    version: 1,
    kind: 'provider_auth' as const,
    class: 'revalidate' as const,
    message: 'authenticate gh',
    evidence: {},
    allowedConsumingReasons: ['blocked_resolved'] as const,
  };
}

function approvalRunner(now: () => Date, nextApprovalState: () => boolean): ProviderCommandRunner {
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
        const approved = nextApprovalState();
        return jsonResult({ data: {
          viewer: { login: 'watch-bot' },
          rateLimit: {
            cost: 1,
            remaining: 5000,
            resetAt: new Date(now().getTime() + 3_600_000).toISOString(),
          },
          repository: { pr0: snapshotPr(approved, now()) },
        } });
      }
      throw new Error(`unexpected query: ${query.slice(0, 80)}`);
    },
  };
}

function discoveryPr() {
  return {
    number: 42,
    url: 'https://github.com/example/repo/pull/42',
    state: 'OPEN',
    headRefName: 'feature',
    baseRefName: 'main',
    headRefOid: 'abc123',
    headRepository: { nameWithOwner: 'example/repo' },
    baseRepository: { nameWithOwner: 'example/repo' },
    author: { login: 'author' },
    reviewDecision: 'REVIEW_REQUIRED',
    commits: { nodes: [{ commit: { committedDate: '2026-08-28T17:00:00.000Z' } }] },
  };
}

function snapshotPr(approved: boolean, observedAt: Date) {
  return {
    ...discoveryPr(),
    reviewDecision: approved ? 'APPROVED' : 'REVIEW_REQUIRED',
    reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
    reviews: {
      pageInfo: { hasNextPage: false },
      nodes: approved ? [{
        id: 'review-143-dev',
        author: { login: '143-dev' },
        state: 'APPROVED',
        submittedAt: observedAt.toISOString(),
        commit: { oid: 'abc123' },
      }] : [],
    },
    comments: { pageInfo: { hasNextPage: false }, nodes: [] },
    commits: { nodes: [{ commit: {
      oid: 'abc123',
      committedDate: '2026-08-28T17:00:00.000Z',
      statusCheckRollup: { contexts: {
        pageInfo: { hasNextPage: false },
        nodes: [{
          __typename: 'CheckRun',
          id: 'check-unit-1',
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

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value?: T) => void;
} {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value?: T) => resolvePromise(value as T) };
}

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function readProcessTrace(crewHome: string): Array<Record<string, unknown>> {
  const path = join(crewHome, 'pr-watches', '.meta', 'process-trace.jsonl');
  return readFileSync(path, 'utf-8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
