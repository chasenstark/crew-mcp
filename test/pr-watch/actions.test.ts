import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  PrWatchActionController,
  prWatchTopologyHash,
} from '../../src/pr-watch/action-controller.js';
import { PrWatchWorktreeManager } from '../../src/pr-watch/action-worktree.js';
import { defaultProfile, resolvePrWatchPolicy } from '../../src/pr-watch/config.js';
import { PrWatchEffectController } from '../../src/pr-watch/effect-controller.js';
import { gcPrWatches } from '../../src/pr-watch/gc.js';
import { makePrWatchId } from '../../src/pr-watch/id.js';
import type { ProviderCommandRunner } from '../../src/pr-watch/provider-runner.js';
import {
  createInitialPrWatchState,
  cancelPrWatch,
  preparePrWatchWorktreeLease,
  recordObservedEvents,
  transitionToActionable,
} from '../../src/pr-watch/reducer.js';
import { PrWatchStore } from '../../src/pr-watch/store.js';
import type { PrWatchEffectKind, PrWatchEventKind, PrWatchStateV1 } from '../../src/pr-watch/types.js';

const T0 = new Date('2026-08-27T12:00:00.000Z');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('PR-watch authorized actions', () => {
  it('defaults to deny, grants a bounded attached lease, performs one marked effect, and settles once', async () => {
    const fixture = await makeActionableFixture();
    const effect = new PrWatchEffectController(fixture.store, fixture.runner, () => T0);
    await expect(effect.execute(effectInput(fixture))).rejects.toThrow(
      'pr_watch.action_authorization_required',
    );
    expect(effect.journal.read(fixture.watchId)).toEqual([]);

    const authorized = await authorize(fixture);
    expect(authorized.grant.effectKinds).toEqual(['post_pr_comment']);
    expect(authorized.state.worktreeLease).toMatchObject({
      branch: 'feature',
      expectedHeadSha: fixture.headSha,
    });
    expect(authorized.state.preparedWorktreeLease).toBeUndefined();
    expect(git(authorized.state.worktreeLease!.worktreePath, ['symbolic-ref', '--short', 'HEAD']))
      .toBe('feature');

    const applied = await effect.execute(effectInput(fixture));
    expect(applied.remoteMutationApplied).toBe(true);
    expect(applied.recovered).toBe(false);
    expect(applied.state.status).toBe('active');
    expect(applied.state.generation).toBe(2);
    expect(applied.state.actionRoundBudget.spent).toBe(1);
    expect(fixture.commentBodies).toHaveLength(1);
    expect(fixture.commentBodies[0]).toContain(`crew-pr-watch-effect:${applied.effectId}`);

    const effectJournalPath = join(fixture.store.watchDir(fixture.watchId), 'effects.jsonl');
    const recordsBeforeCrash = readFileSync(effectJournalPath, 'utf-8').trimEnd().split('\n');
    expect(recordsBeforeCrash).toHaveLength(5);
    writeFileSync(effectJournalPath, `${recordsBeforeCrash.slice(0, -1).join('\n')}\n`);

    const recoveredAfterSettleCrash = await effect.execute(effectInput(fixture));
    expect(recoveredAfterSettleCrash).toMatchObject({
      effectId: applied.effectId,
      remoteMutationApplied: false,
      recovered: true,
    });
    expect(effect.journal.read(fixture.watchId).map((record) => record.phase)).toEqual([
      'prepared',
      'observed_absent',
      'applied',
      'verified',
      'settled',
    ]);
    expect(fixture.commentBodies).toHaveLength(1);

    const retry = await effect.execute(effectInput(fixture));
    expect(retry).toMatchObject({
      effectId: applied.effectId,
      remoteMutationApplied: false,
      recovered: true,
    });
    expect(fixture.commentBodies).toHaveLength(1);
    await expect(effect.execute({ ...effectInput(fixture), body: 'different intent' }))
      .rejects.toThrow('pr_watch.effect_id_conflict');
  });

  it('recovers a prepared worktree after the pre-finalization crash boundary', async () => {
    const fixture = await makeActionableFixture();
    const manager = new PrWatchWorktreeManager(fixture.crewHome, fixture.repoRoot);
    await manager.withHostMutationExclusion(async (signal) => fixture.store.withWatchLock(
      fixture.watchId,
      async () => {
        let state = fixture.store.read(fixture.watchId).state;
        const prepared = await manager.prepareLeaseInsideHostLock({
          state,
          branch: 'feature',
          headSha: fixture.headSha,
          signal,
          now: T0,
        });
        state = fixture.store.mutateLocked(fixture.watchId, (current) =>
          preparePrWatchWorktreeLease(current, prepared, T0)).state;
        await manager.ensureLeaseInsideHostLock({
          state,
          branch: 'feature',
          headSha: fixture.headSha,
          signal,
          now: T0,
        });
      },
    ));
    const crashed = fixture.store.read(fixture.watchId).state;
    expect(crashed.preparedWorktreeLease).toBeDefined();
    expect(crashed.worktreeLease).toBeUndefined();

    const recovered = await authorize(fixture);
    expect(recovered.state.preparedWorktreeLease).toBeUndefined();
    expect(recovered.state.worktreeLease?.leaseId).toBe(
      crashed.preparedWorktreeLease?.leaseId,
    );
  });

  it('blocks with a typed manual remedy when a prepared worktree is ambiguous', async () => {
    const fixture = await makeActionableFixture();
    const manager = new PrWatchWorktreeManager(fixture.crewHome, fixture.repoRoot);
    await manager.withHostMutationExclusion(async (signal) => fixture.store.withWatchLock(
      fixture.watchId,
      async () => {
        let state = fixture.store.read(fixture.watchId).state;
        const prepared = await manager.prepareLeaseInsideHostLock({
          state,
          branch: 'feature',
          headSha: fixture.headSha,
          signal,
          now: T0,
        });
        state = fixture.store.mutateLocked(fixture.watchId, (current) =>
          preparePrWatchWorktreeLease(current, prepared, T0)).state;
        const lease = await manager.ensureLeaseInsideHostLock({
          state,
          branch: 'feature',
          headSha: fixture.headSha,
          signal,
          now: T0,
        });
        writeFileSync(join(lease.worktreePath, 'partial-checkout.txt'), 'ambiguous\n');
      },
    ));

    await expect(authorize(fixture)).rejects.toThrow('pr_watch.action_authorization_blocked');
    const state = fixture.store.read(fixture.watchId).state;
    expect(state.status).toBe('blocked');
    if (state.status !== 'blocked') throw new Error('expected lease blocker');
    expect(state.blocker).toMatchObject({
      kind: 'lease_lost',
      class: 'restart_required',
      allowedConsumingReasons: [],
      evidence: { worktreePath: state.preparedWorktreeLease?.worktreePath },
    });
  });

  it('makes a timed-out prepared worktree retryable instead of requiring restart', async () => {
    const fixture = await makeActionableFixture();
    class TimedOutWorktreeManager extends PrWatchWorktreeManager {
      override async ensureLeaseInsideHostLock(): Promise<never> {
        throw new Error('pr_watch.git_timeout: simulated slow checkout');
      }
    }
    const state = fixture.store.read(fixture.watchId).state;
    const controller = new PrWatchActionController(
      fixture.store,
      fixture.runner,
      () => T0,
      (crewHome, repoRoot) => new TimedOutWorktreeManager(crewHome, repoRoot),
    );

    await expect(controller.authorize({
      watchId: fixture.watchId,
      expectedGeneration: state.generation,
      expectedPolicyHash: state.effectiveConfig.policyHash,
      expectedTopologyHash: prWatchTopologyHash(state),
      effectKinds: ['post_pr_comment'],
      maxActionRounds: 2,
      maxActionableWakes: 5,
      confirmed: true,
    })).rejects.toThrow('pr_watch.action_authorization_blocked');

    const blocked = fixture.store.read(fixture.watchId).state;
    expect(blocked.status).toBe('blocked');
    if (blocked.status !== 'blocked') throw new Error('expected retryable lease blocker');
    expect(blocked.blocker).toMatchObject({
      kind: 'lease_lost',
      class: 'revalidate',
      allowedConsumingReasons: ['blocked_resolved'],
    });
  });

  it('retains an action worktree on cancellation and unregisters it during eligible GC', async () => {
    const fixture = await makeActionableFixture();
    const authorized = await authorize(fixture);
    const worktreePath = authorized.state.worktreeLease!.worktreePath;
    expect(existsSync(worktreePath)).toBe(true);
    expect(git(fixture.repoRoot, ['worktree', 'list', '--porcelain'])).toContain(worktreePath);

    await fixture.store.mutate(fixture.watchId, (current) => ({
      state: cancelPrWatch(current, T0).state,
      transactionId: 'cancel-before-gc',
    }));
    expect(existsSync(worktreePath)).toBe(true);

    const gc = await gcPrWatches({
      crewHome: fixture.crewHome,
      repoRoot: fixture.repoRoot,
      ttlMs: 0,
      now: T0.getTime() + 1,
    });

    expect(gc).toMatchObject({ watchesReclaimed: 1 });
    expect(existsSync(worktreePath)).toBe(false);
    expect(git(fixture.repoRoot, ['worktree', 'list', '--porcelain']))
      .not.toContain(worktreePath);
    git(fixture.repoRoot, ['checkout', '-q', 'feature']);
    expect(git(fixture.repoRoot, ['symbolic-ref', '--short', 'HEAD'])).toBe('feature');
  });

  it('pushes one exact fast-forward SHA and rolls the verified head into settlement', async () => {
    const fixture = await makeActionableFixture();
    const authorized = await authorize(fixture, ['push_single_branch']);
    const worktree = authorized.state.worktreeLease!.worktreePath;
    writeFileSync(join(worktree, 'push.txt'), 'fast forward\n');
    git(worktree, ['add', 'push.txt']);
    git(worktree, ['commit', '-q', '-m', 'fast-forward effect']);
    const intendedSha = git(worktree, ['rev-parse', 'HEAD']);

    const result = await new PrWatchEffectController(
      fixture.store,
      fixture.runner,
      () => T0,
    ).execute({
      ...effectInput(fixture),
      kind: 'push_single_branch',
      target: { intended_sha: intendedSha },
    });
    expect(result.remoteMutationApplied).toBe(true);
    expect(git(fixture.bareRepo, ['rev-parse', 'refs/heads/feature'])).toBe(intendedSha);
    expect(result.state.expectedHeads).toEqual({ '1': intendedSha });
    expect(result.state.worktreeLease?.expectedHeadSha).toBe(intendedSha);
    expect(new PrWatchEffectController(fixture.store, fixture.runner).journal
      .read(fixture.watchId)
      .map((record) => record.phase)).toEqual([
      'prepared',
      'observed_absent',
      'applied',
      'verified',
      'settled',
    ]);
  });

  it('releases the host writer while a single-branch push is delayed', async () => {
    const fixture = await makeActionableFixture();
    const authorized = await authorize(fixture, ['push_single_branch']);
    const worktree = authorized.state.worktreeLease!.worktreePath;
    writeFileSync(join(worktree, 'delayed-push.txt'), 'fast forward\n');
    git(worktree, ['add', 'delayed-push.txt']);
    git(worktree, ['commit', '-q', '-m', 'delayed push effect']);
    const intendedSha = git(worktree, ['rev-parse', 'HEAD']);
    const enteredPath = join(fixture.crewHome, '..', 'push-entered');
    const releasePath = join(fixture.crewHome, '..', 'push-release');
    const hookDir = join(git(worktree, ['rev-parse', '--git-common-dir']), 'hooks');
    mkdirSync(hookDir, { recursive: true });
    const hookPath = join(hookDir, 'pre-push');
    writeFileSync(hookPath, [
      '#!/bin/sh',
      `touch ${JSON.stringify(enteredPath)}`,
      `while [ ! -f ${JSON.stringify(releasePath)} ]; do sleep 0.01; done`,
      '',
    ].join('\n'));
    chmodSync(hookPath, 0o755);

    const effectPromise = new PrWatchEffectController(
      fixture.store,
      fixture.runner,
      () => T0,
    ).execute({
      ...effectInput(fixture),
      kind: 'push_single_branch',
      target: { intended_sha: intendedSha },
    });
    await waitForPath(enteredPath);
    const reader = new PrWatchWorktreeManager(fixture.crewHome, fixture.repoRoot)
      .hostWorktrees.withHostSnapshotReadExclusion(async () => true);
    const readerCompletedBeforeRelease = await Promise.race([
      reader.then(() => true),
      new Promise<false>((resolvePromise) => setTimeout(() => resolvePromise(false), 500)),
    ]);
    writeFileSync(releasePath, 'release\n');

    await reader;
    await effectPromise;
    expect(readerCompletedBeforeRelease).toBe(true);
  });

  it('refuses authorization while another worktree owns the watched branch', async () => {
    const fixture = await makeActionableFixture({ checkoutFeature: true });
    await expect(authorize(fixture)).rejects.toThrow('pr_watch.watched_branch_checked_out');
    const state = fixture.store.read(fixture.watchId).state;
    expect(state.actionGrant).toBeUndefined();
    expect(state.worktreeLease).toBeUndefined();
    expect(state.preparedWorktreeLease).toBeDefined();
  });

  it('durably revokes a grant before apply when the remote head moves', async () => {
    const fixture = await makeActionableFixture();
    await authorize(fixture);
    const movedHead = git(fixture.repoRoot, ['rev-parse', 'main']);
    git(fixture.bareRepo, ['update-ref', 'refs/heads/feature', movedHead]);
    const effect = new PrWatchEffectController(fixture.store, fixture.runner, () => T0);
    await expect(effect.execute(effectInput(fixture))).rejects.toThrow(
      'pr_watch.action_grant_external_heads_changed',
    );
    const state = fixture.store.read(fixture.watchId).state;
    expect(state.actionGrant).toMatchObject({
      revokedAt: T0.toISOString(),
      revokedReason: expect.stringContaining('external_heads_changed'),
    });
    expect(effect.journal.read(fixture.watchId)).toEqual([]);
    expect(fixture.commentBodies).toEqual([]);
  });

  it('durably revokes a grant before apply when the discovered topology changes', async () => {
    const fixture = await makeActionableFixture();
    await authorize(fixture);
    fixture.topologyBaseRef.value = 'release';
    const effect = new PrWatchEffectController(fixture.store, fixture.runner, () => T0);

    await expect(effect.execute(effectInput(fixture))).rejects.toThrow(
      'pr_watch.action_grant_topology_changed',
    );

    expect(fixture.store.read(fixture.watchId).state.actionGrant).toMatchObject({
      revokedReason: expect.stringContaining('topology_changed'),
    });
    expect(effect.journal.read(fixture.watchId)).toEqual([]);
    expect(fixture.commentBodies).toEqual([]);
  });

  it('durably revokes a grant before apply when repository policy changes', async () => {
    const fixture = await makeActionableFixture();
    await authorize(fixture);
    mkdirSync(join(fixture.repoRoot, '.crew'));
    writeFileSync(join(fixture.repoRoot, '.crew', 'pr-watch.yaml'), [
      'schema_version: 1',
      'limits:',
      '  max_prs: 49',
      'ci:',
      '  github_checks:',
      '    mode: github_rules',
      '',
    ].join('\n'));
    const effect = new PrWatchEffectController(fixture.store, fixture.runner, () => T0);

    await expect(effect.execute(effectInput(fixture))).rejects.toThrow(
      'pr_watch.action_grant_policy_changed',
    );

    expect(fixture.store.read(fixture.watchId).state.actionGrant).toMatchObject({
      revokedReason: expect.stringContaining('policy_changed'),
    });
    expect(effect.journal.read(fixture.watchId)).toEqual([]);
    expect(fixture.commentBodies).toEqual([]);
  });

  it('rejects a granted comment effect aimed at another PR', async () => {
    const fixture = await makeActionableFixture();
    await authorize(fixture);
    const effect = new PrWatchEffectController(fixture.store, fixture.runner, () => T0);

    await expect(effect.execute({
      ...effectInput(fixture),
      target: { pr: 2 },
    })).rejects.toThrow('pr_watch.effect_target_event_mismatch');

    expect(effect.journal.read(fixture.watchId)).toEqual([]);
    expect(fixture.commentBodies).toEqual([]);
  });

  it('binds review-thread resolution to the event provider identity', async () => {
    const fixture = await makeActionableFixture({
      eventKind: 'review_thread',
      providerSourceId: 'thread-owned-by-event',
    });
    await authorize(fixture, ['resolve_review_thread']);
    const effect = new PrWatchEffectController(fixture.store, fixture.runner, () => T0);

    await expect(effect.execute({
      ...effectInput(fixture),
      kind: 'resolve_review_thread',
      target: { thread_id: 'thread-from-another-repository' },
    })).rejects.toThrow('pr_watch.effect_target_event_mismatch');

    expect(effect.journal.read(fixture.watchId)).toEqual([]);
  });

  it('replies only to the review comment bound to the handed-off thread event', async () => {
    const fixture = await makeActionableFixture({
      eventKind: 'review_thread',
      providerSourceId: 'thread-owned-by-event',
      replyCommentId: 99,
    });
    await authorize(fixture, ['reply_review_comment']);
    const effect = new PrWatchEffectController(fixture.store, fixture.runner, () => T0);

    await expect(effect.execute({
      ...effectInput(fixture),
      kind: 'reply_review_comment',
      target: { pr: 1, comment_id: 100 },
    })).rejects.toThrow('pr_watch.effect_target_event_mismatch');
    const applied = await effect.execute({
      ...effectInput(fixture),
      kind: 'reply_review_comment',
      target: { pr: 1, comment_id: 99 },
      body: 'review reply',
    });
    expect(applied.remoteMutationApplied).toBe(true);
    expect(fixture.commentBodies).toHaveLength(1);
    expect(fixture.commentBodies[0]).toContain('review reply');
  });
});

interface Fixture {
  readonly crewHome: string;
  readonly repoRoot: string;
  readonly store: PrWatchStore;
  readonly watchId: string;
  readonly headSha: string;
  readonly batchId: string;
  readonly bareRepo: string;
  readonly runner: ProviderCommandRunner;
  readonly commentBodies: string[];
  readonly topologyBaseRef: { value: string };
}

async function makeActionableFixture(
  args: {
    readonly checkoutFeature?: boolean;
    readonly eventKind?: PrWatchEventKind;
    readonly providerSourceId?: string;
    readonly replyCommentId?: number;
  } = {},
): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'crew-pr-watch-actions-'));
  roots.push(root);
  const repoRoot = join(root, 'repo');
  const crewHome = join(root, 'crew-home');
  git(root, ['init', '-q', '-b', 'main', repoRoot]);
  git(repoRoot, ['config', 'user.email', 'crew@example.test']);
  git(repoRoot, ['config', 'user.name', 'Crew Test']);
  writeFileSync(join(repoRoot, 'fixture.txt'), 'base\n');
  git(repoRoot, ['add', 'fixture.txt']);
  git(repoRoot, ['commit', '-q', '-m', 'base']);
  git(repoRoot, ['checkout', '-q', '-b', 'feature']);
  writeFileSync(join(repoRoot, 'fixture.txt'), 'base\nfeature\n');
  git(repoRoot, ['commit', '-q', '-am', 'feature']);
  const headSha = git(repoRoot, ['rev-parse', 'HEAD']);
  const bareRepo = join(root, 'example', 'repo');
  mkdirSync(join(root, 'example'), { recursive: true });
  git(root, ['init', '--bare', '-q', bareRepo]);
  git(repoRoot, ['remote', 'add', 'v2', bareRepo]);
  git(repoRoot, ['push', '-q', 'v2', 'main', 'feature']);
  git(repoRoot, ['branch', '--set-upstream-to=v2/feature', 'feature']);
  if (!args.checkoutFeature) git(repoRoot, ['checkout', '-q', 'main']);

  const store = new PrWatchStore(crewHome);
  const watchId = makePrWatchId();
  const profile = defaultProfile();
  const resolvedPolicy = resolvePrWatchPolicy({
    profile,
    rulesBaseline: {
      status: 'resolved',
      requiredChecks: [],
      provenance: { baseBranch: 'main', branchProtection: [], rulesets: [] },
    },
  });
  let state: PrWatchStateV1 = createInitialPrWatchState({
    watchId,
    initialization: {
      repository: 'example/repo',
      anchorPrNumber: 1,
      repoRoot: realpathSync(repoRoot),
      effectiveConfig: {
        maxPrs: 50,
        maxActionableWakes: 5,
        maxActionRounds: 3,
        maxWatchAgeDays: -1,
        policyHash: resolvedPolicy.policyHash,
      },
      expectedHeads: { '1': headSha },
      policyEvidence: {
        resolvedPolicy,
        approval: { mode: 'github' },
        scope: 'single',
        topology: [{
          number: 1,
          headRefName: 'feature',
          baseRefName: 'main',
          headRepository: 'example/repo',
          baseRepository: 'example/repo',
        }],
      },
    },
    now: new Date(T0.getTime() - 10_000),
  });
  state = recordObservedEvents(state, [{
    id: 'event-comment',
    identity: {
      prNumber: 1,
      headSha,
      kind: args.eventKind ?? 'comment',
      providerSourceId: args.providerSourceId ?? 'comment-1',
      attempt: 1,
    },
    firstObservedAt: T0.toISOString(),
    lastObservedAt: T0.toISOString(),
    ...(args.replyCommentId !== undefined ? { replyCommentId: args.replyCommentId } : {}),
    fixAttemptCount: 0,
  }], T0).state;
  state = transitionToActionable(state, {
    eventIds: ['event-comment'],
    inclusiveLedgerSequenceWatermark: 2,
    now: T0,
  }).state;
  if (state.status !== 'actionable') throw new Error('expected actionable fixture');
  await store.create(state, 'create-action-fixture');

  const commentBodies: string[] = [];
  const topologyBaseRef = { value: 'main' };
  const runner: ProviderCommandRunner = {
    run: async (spec) => {
      if (spec.args[0] === '--version') {
        return { stdout: 'gh version 2.80.1 (2026-01-01)\n', stderr: '', exitCode: 0 };
      }
      if (spec.args[0] === 'auth') {
        return { stdout: '', stderr: "Token scopes: 'repo'\n", exitCode: 0 };
      }
      const query = spec.args.find((arg) => arg.startsWith('query='))?.slice('query='.length) ?? '';
      if (query.includes('CrewPrWatchDiscovery')) {
        const remoteHead = git(bareRepo, ['rev-parse', 'refs/heads/feature']);
        return jsonResult({ data: { repository: { pullRequests: {
          pageInfo: { hasNextPage: false },
          nodes: [discoveryPr(remoteHead, topologyBaseRef.value)],
        } } } });
      }
      if (query.includes('CrewPrWatchRules')) {
        return jsonResult({ data: { repository: {
          branchProtectionRules: { pageInfo: { hasNextPage: false }, nodes: [] },
          rulesets: { pageInfo: { hasNextPage: false }, nodes: [] },
        } } });
      }
      if (query.includes('CrewPrWatchSnapshot')) {
        const remoteHead = git(bareRepo, ['rev-parse', 'refs/heads/feature']);
        return jsonResult({ data: {
          viewer: { login: 'watch-bot' },
          rateLimit: { cost: 1, remaining: 5000, resetAt: '2026-08-27T13:00:00.000Z' },
          repository: { pr0: snapshotPr(remoteHead, topologyBaseRef.value) },
        } });
      }
      if (spec.args[0] === 'api' && spec.args.includes('--method') && spec.args.includes('GET')) {
        return jsonResult(commentBodies.map((body) => ({ body })));
      }
      if (spec.args[0] === 'pr' && spec.args[1] === 'comment') {
        const bodyIndex = spec.args.indexOf('--body');
        commentBodies.push(spec.args[bodyIndex + 1]);
        return jsonResult({ id: 1 });
      }
      if (spec.args[0] === 'api' && spec.args.includes('--method') && spec.args.includes('POST')) {
        const body = spec.args.find((arg) => arg.startsWith('body='))?.slice('body='.length) ?? '';
        commentBodies.push(body);
        return jsonResult({ id: 2 });
      }
      throw new Error(`unexpected action command: ${spec.args.join(' ')}`);
    },
  };
  return {
    crewHome,
    repoRoot: realpathSync(repoRoot),
    store,
    watchId,
    headSha,
    batchId: state.batch.actionBatchId,
    bareRepo,
    runner,
    commentBodies,
    topologyBaseRef,
  };
}

async function authorize(
  fixture: Fixture,
  effectKinds: readonly PrWatchEffectKind[] = ['post_pr_comment'],
) {
  const state = fixture.store.read(fixture.watchId).state;
  return new PrWatchActionController(fixture.store, fixture.runner, () => T0).authorize({
    watchId: fixture.watchId,
    expectedGeneration: state.generation,
    expectedPolicyHash: state.effectiveConfig.policyHash,
    expectedTopologyHash: prWatchTopologyHash(state),
    effectKinds,
    maxActionRounds: 2,
    maxActionableWakes: 5,
    confirmed: true,
  });
}

function effectInput(fixture: Fixture) {
  return {
    watchId: fixture.watchId,
    expectedGeneration: 1,
    actionBatchId: fixture.batchId,
    eventId: 'event-comment',
    kind: 'post_pr_comment' as const,
    target: { pr: 1 },
    body: 'Automated follow-up',
  };
}

function snapshotPr(headSha: string, baseRefName = 'main') {
  return {
    ...discoveryPr(headSha, baseRefName),
    reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
    reviews: { pageInfo: { hasNextPage: false }, nodes: [] },
    comments: { pageInfo: { hasNextPage: false }, nodes: [] },
    commits: { nodes: [{ commit: {
      oid: headSha,
      committedDate: '2026-08-27T11:00:00.000Z',
      statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: [] } },
    } }] },
  };
}

function discoveryPr(headSha: string, baseRefName = 'main') {
  return {
    number: 1,
    url: 'https://github.com/example/repo/pull/1',
    state: 'OPEN',
    headRefName: 'feature',
    baseRefName,
    headRefOid: headSha,
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

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf-8' }).trim();
}
