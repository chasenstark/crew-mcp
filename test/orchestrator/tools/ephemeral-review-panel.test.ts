/**
 * Phase 2 coverage for `ephemeral_review` panel membership: the
 * snapshot-from-source worktree primitive (implementer HEAD + dirty state,
 * source-mutation guard), and run_panel routing of ephemeral-worktree
 * adapters (agy) to disposable per-reviewer snapshots. Runs entirely
 * against isolated temp repos + CREW_HOMEs.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentAdapter, Task } from '../../../src/adapters/types.js';
import {
  dispatchRunAgentInternal,
  type DispatchRunAgentInternalArgs,
  type DispatchRunAgentInternalResult,
} from '../../../src/orchestrator/dispatch-run-agent-internal.js';
import { runPanelHandler } from '../../../src/orchestrator/tools/run-panel.js';
import type { FullConfig } from '../../../src/workflow/types.js';
import { getDefaultConfig } from '../../../src/workflow/config-codec.js';
import {
  createRunState,
  makeHarness,
  makeMockAdapter,
  waitFor,
  type PanelHarness,
} from './panel-test-harness.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function harnessWith(adapters: AgentAdapter[]): PanelHarness {
  const h = makeHarness(adapters);
  cleanups.push(h.cleanup);
  return h;
}

/** An agy-shaped adapter: rejects read-only, reviews via ephemeral worktree. */
function makeEphemeralAdapter(
  overrides?: Partial<AgentAdapter> & { name?: string },
): AgentAdapter {
  return makeMockAdapter({
    name: 'agy',
    enforcesReadOnly: false,
    rejectsReadOnly: true,
    requiresCrewWorktree: true,
    reviewDispatchMode: 'ephemeral-worktree',
    ...overrides,
  });
}

/**
 * Build a source worktree that carries BOTH kinds of run work: a commit on
 * its run branch (committed.txt + .gitignore) and uncommitted state (a
 * dirty file, a gitignored file, and a tracked deletion of README.md).
 */
async function makeSourceWorktree(h: PanelHarness, runId = 'implementer-run'): Promise<string> {
  const sourcePath = await h.worktreeManager.createRunWorktree(runId);
  writeFileSync(join(sourcePath, 'committed.txt'), 'committed run work\n', 'utf-8');
  writeFileSync(join(sourcePath, '.gitignore'), 'ignored.txt\n', 'utf-8');
  execSync('git add committed.txt .gitignore && git commit -q -m "run work"', { cwd: sourcePath });
  writeFileSync(join(sourcePath, 'dirty.txt'), 'dirty run work\n', 'utf-8');
  writeFileSync(join(sourcePath, 'ignored.txt'), 'must not travel\n', 'utf-8');
  rmSync(join(sourcePath, 'README.md'));
  return sourcePath;
}

describe('createRunWorktreeFromSource — snapshot acquisition', () => {
  it('snapshots the source HEAD (committed run work) plus its dirty state, excluding gitignored files', async () => {
    const h = harnessWith([]);
    const sourcePath = await makeSourceWorktree(h);

    const reviewPath = await h.worktreeManager.createRunWorktreeFromSource('review-run', {
      sourcePath,
    });

    expect(reviewPath).not.toBe(sourcePath);
    // Committed half — would be silently dropped by a dirty-only copy.
    expect(readFileSync(join(reviewPath, 'committed.txt'), 'utf-8')).toBe('committed run work\n');
    // Dirty half — copied on top of the source HEAD.
    expect(readFileSync(join(reviewPath, 'dirty.txt'), 'utf-8')).toBe('dirty run work\n');
    // Tracked deletion applied; gitignored file excluded.
    expect(existsSync(join(reviewPath, 'README.md'))).toBe(false);
    expect(existsSync(join(reviewPath, 'ignored.txt'))).toBe(false);
    // The commit lives on the source's run branch, NOT in the host repo —
    // proving the snapshot was cut from the source HEAD.
    expect(existsSync(join(h.root, 'committed.txt'))).toBe(false);
    expect(h.worktreeManager.hasOwnedRunWorktreeRecord('review-run')).toBe(true);
  });

  it('discards the snapshot and fails when the source dirty state mutates during the copy window', async () => {
    const h = harnessWith([]);
    const sourcePath = await makeSourceWorktree(h);

    await expect(h.worktreeManager.createRunWorktreeFromSource('review-mut', {
      sourcePath,
      // Runs inside the copy window (after the sync, before the re-sign):
      // the standing simulation of a mid-copy source mutation.
      assertSourceStableAfterSync: () => {
        writeFileSync(join(sourcePath, 'late-edit.txt'), 'raced in\n', 'utf-8');
      },
    })).rejects.toThrow(/ephemeral_snapshot\.source_mutated/);

    expect(h.worktreeManager.hasOwnedRunWorktreeRecord('review-mut')).toBe(false);
    expect(existsSync(join(h.crewHome, 'runs', 'review-mut', 'worktree'))).toBe(false);
  });

  it('catches an in-place mutation of an ALREADY-dirty file (content hash, not just the path set)', async () => {
    const h = harnessWith([]);
    const sourcePath = await makeSourceWorktree(h);

    await expect(h.worktreeManager.createRunWorktreeFromSource('review-content', {
      sourcePath,
      // Same dirty path set before and after — only the CONTENT of an
      // already-dirty file changes. A cheaper path-set signature would
      // miss this; the per-path content hash must not.
      assertSourceStableAfterSync: () => {
        writeFileSync(join(sourcePath, 'dirty.txt'), 'rewritten mid-copy\n', 'utf-8');
      },
    })).rejects.toThrow(/ephemeral_snapshot\.source_mutated/);

    expect(h.worktreeManager.hasOwnedRunWorktreeRecord('review-content')).toBe(false);
    expect(existsSync(join(h.crewHome, 'runs', 'review-content', 'worktree'))).toBe(false);
  });

  it('applies a staged-modified-then-deleted file as a deletion, not a stale HEAD copy', async () => {
    const h = harnessWith([]);
    const sourcePath = await makeSourceWorktree(h);
    // committed.txt is tracked at the source HEAD; stage a modification,
    // then delete it from the working tree (`git add f && rm f`). The
    // snapshot must reflect the deletion — the copy no-ops on ENOENT, and
    // that must not suppress the removal.
    writeFileSync(join(sourcePath, 'committed.txt'), 'staged v2\n', 'utf-8');
    execSync('git add committed.txt', { cwd: sourcePath });
    rmSync(join(sourcePath, 'committed.txt'));

    const reviewPath = await h.worktreeManager.createRunWorktreeFromSource('review-staged-del', {
      sourcePath,
    });

    expect(existsSync(join(reviewPath, 'committed.txt'))).toBe(false);
  });

  it('fails the snapshot when the source holds an unsafe symlink (strict sync, not warn-and-continue)', async () => {
    const h = harnessWith([]);
    const sourcePath = await makeSourceWorktree(h);
    // Untracked symlink escaping the source root: the sync skips it for
    // safety, and in strict snapshot mode that skip must be FATAL — a
    // silently partial snapshot would pass the source-signature guard.
    symlinkSync('/tmp', join(sourcePath, 'escape-link'));

    await expect(h.worktreeManager.createRunWorktreeFromSource('review-symlink', {
      sourcePath,
    })).rejects.toThrow(/ephemeral_snapshot\.sync_incomplete/);

    expect(h.worktreeManager.hasOwnedRunWorktreeRecord('review-symlink')).toBe(false);
    expect(existsSync(join(h.crewHome, 'runs', 'review-symlink', 'worktree'))).toBe(false);
  });

  it('discards the snapshot and fails when the source HEAD moves during the copy window', async () => {
    const h = harnessWith([]);
    const sourcePath = await makeSourceWorktree(h);

    await expect(h.worktreeManager.createRunWorktreeFromSource('review-head', {
      sourcePath,
      assertSourceStableAfterSync: () => {
        execSync('git add -A && git commit -q -m "landed mid-copy"', { cwd: sourcePath });
      },
    })).rejects.toThrow(/ephemeral_snapshot\.source_mutated/);

    expect(h.worktreeManager.hasOwnedRunWorktreeRecord('review-head')).toBe(false);
    expect(existsSync(join(h.crewHome, 'runs', 'review-head', 'worktree'))).toBe(false);
  });

  it('propagates an assertSourceStableAfterSync failure and discards the worktree', async () => {
    const h = harnessWith([]);
    const sourcePath = await makeSourceWorktree(h);

    await expect(h.worktreeManager.createRunWorktreeFromSource('review-drift', {
      sourcePath,
      assertSourceStableAfterSync: () => {
        throw new Error('run_panel.implementer_mutated_during_snapshot: test drift');
      },
    })).rejects.toThrow(/implementer_mutated_during_snapshot/);

    expect(h.worktreeManager.hasOwnedRunWorktreeRecord('review-drift')).toBe(false);
    expect(existsSync(join(h.crewHome, 'runs', 'review-drift', 'worktree'))).toBe(false);
  });

  it('syncUncommittedFromPathToWorktree mirrors deltas between two arbitrary worktrees', async () => {
    const h = harnessWith([]);
    const a = await h.worktreeManager.createRunWorktree('sync-a');
    const b = await h.worktreeManager.createRunWorktree('sync-b');
    writeFileSync(join(a, 'new.txt'), 'from a\n', 'utf-8');
    rmSync(join(a, 'README.md'));

    const counts = await h.worktreeManager.syncUncommittedFromPathToWorktree(a, b);

    expect(counts.copied).toBeGreaterThanOrEqual(1);
    expect(readFileSync(join(b, 'new.txt'), 'utf-8')).toBe('from a\n');
    expect(existsSync(join(b, 'README.md'))).toBe(false);
  });
});

interface CapturedDispatch {
  readonly args: DispatchRunAgentInternalArgs;
}

function capturingDispatchImpl(captured: CapturedDispatch[]): typeof dispatchRunAgentInternal {
  return async (args) => {
    captured.push({ args });
    const runMode = args.input.run_mode
      ?? (args.input.read_only === true ? 'read_only' : 'write');
    const result: DispatchRunAgentInternalResult = {
      runId: `${args.input.agent_id}-run-${captured.length}`,
      worktreePath: `/tmp/${args.input.agent_id}-${captured.length}`,
      runMode,
      readOnly: runMode === 'read_only',
      tailUrl: `crew-tail:///${args.input.agent_id}-${captured.length}`,
      tailCommandPath: `/tmp/${args.input.agent_id}-${captured.length}/tail.command`,
      toolCallId: `tool-${args.input.agent_id}-${captured.length}`,
      warnings: [],
    };
    return result;
  };
}

describe('run_panel — ephemeral reviewer routing', () => {
  it('routes an ephemeral-worktree reviewer to run_mode ephemeral_review with an implementer snapshot; peers stay in-place read-only', async () => {
    const h = harnessWith([makeEphemeralAdapter(), makeMockAdapter({ name: 'peer' })]);
    const implementer = await createRunState(h, { runId: 'impl-1', status: 'success' });
    const captured: CapturedDispatch[] = [];

    const out = await runPanelHandler({
      implementer_run_id: implementer.runId,
      reviewers: [
        { agent_id: 'agy', prompt: 'review it' },
        { agent_id: 'peer', prompt: 'review it' },
      ],
    }, { ...h.ctx, dispatchRunAgentInternalImpl: capturingDispatchImpl(captured) });

    expect(out.failed_reviewers).toEqual([]);
    expect(out.reviewers).toHaveLength(2);

    const agyDispatch = captured.find((c) => c.args.input.agent_id === 'agy')!;
    expect(agyDispatch.args.input.run_mode).toBe('ephemeral_review');
    expect(agyDispatch.args.input.read_only).toBeUndefined();
    expect(agyDispatch.args.input.working_directory).toBeUndefined();
    expect(agyDispatch.args.ephemeralReviewSnapshot?.sourcePath).toBe(implementer.worktreePath);

    const peerDispatch = captured.find((c) => c.args.input.agent_id === 'peer')!;
    expect(peerDispatch.args.input.run_mode).toBeUndefined();
    expect(peerDispatch.args.input.read_only).toBe(true);
    expect(peerDispatch.args.input.working_directory).toBe(implementer.worktreePath);
    expect(peerDispatch.args.ephemeralReviewSnapshot).toBeUndefined();
  });

  it('rejects an explicit read_only on an ephemeral reviewer without failing the rest of the panel', async () => {
    const h = harnessWith([makeEphemeralAdapter(), makeMockAdapter({ name: 'peer' })]);
    const implementer = await createRunState(h, { runId: 'impl-2', status: 'success' });
    const captured: CapturedDispatch[] = [];

    for (const readOnly of [true, false]) {
      captured.length = 0;
      const out = await runPanelHandler({
        implementer_run_id: implementer.runId,
        reviewers: [
          { agent_id: 'agy', prompt: 'review it', read_only: readOnly },
          { agent_id: 'peer', prompt: 'review it' },
        ],
      }, { ...h.ctx, dispatchRunAgentInternalImpl: capturingDispatchImpl(captured) });

      expect(out.partial).toBe(true);
      expect(out.failed_reviewers).toHaveLength(1);
      expect(out.failed_reviewers[0].agent_id).toBe('agy');
      expect(out.failed_reviewers[0].error).toContain('run_panel.ephemeral_reviewer_read_only');
      expect(out.failed_reviewers[0].error).toContain('Omit read_only');
      // The rejected reviewer never reached dispatch; the peer still ran.
      expect(captured.map((c) => c.args.input.agent_id)).toEqual(['peer']);
    }
  });

  it('rejects an explicit working_directory on an ephemeral reviewer', async () => {
    const h = harnessWith([makeEphemeralAdapter()]);
    const implementer = await createRunState(h, { runId: 'impl-3', status: 'success' });

    const out = await runPanelHandler({
      implementer_run_id: implementer.runId,
      reviewers: [
        { agent_id: 'agy', prompt: 'review it', working_directory: implementer.worktreePath },
      ],
    }, { ...h.ctx, dispatchRunAgentInternalImpl: capturingDispatchImpl([]) });

    expect(out.failed_reviewers).toHaveLength(1);
    expect(out.failed_reviewers[0].error).toContain('run_panel.ephemeral_reviewer_working_directory');
    expect(out.failed_reviewers[0].error).toContain('Omit working_directory');
  });

  it('unbound panels dispatch ephemeral reviewers without a snapshot source (host-repo snapshot)', async () => {
    const h = harnessWith([makeEphemeralAdapter()]);
    const captured: CapturedDispatch[] = [];

    const out = await runPanelHandler({
      reviewers: [{ agent_id: 'agy', prompt: 'review the repo' }],
    }, { ...h.ctx, dispatchRunAgentInternalImpl: capturingDispatchImpl(captured) });

    expect(out.failed_reviewers).toEqual([]);
    expect(captured).toHaveLength(1);
    expect(captured[0].args.input.run_mode).toBe('ephemeral_review');
    expect(captured[0].args.ephemeralReviewSnapshot).toBeUndefined();
  });

  it('preference-filled reviewers omit read_only for ephemeral-worktree adapters only', async () => {
    const h = harnessWith([makeEphemeralAdapter(), makeMockAdapter({ name: 'peer' })]);
    const captured: CapturedDispatch[] = [];
    const base = getDefaultConfig();
    const config = {
      ...base,
      workflow: {
        ...base.workflow,
        agentDefaults: { panel: { reviewers: ['agy', 'peer'] } },
      },
    } as FullConfig;

    const out = await runPanelHandler({}, {
      ...h.ctx,
      dispatchRunAgentInternalImpl: capturingDispatchImpl(captured),
      loadConfig: () => config,
    });

    expect(out.failed_reviewers).toEqual([]);
    const agyDispatch = captured.find((c) => c.args.input.agent_id === 'agy')!;
    expect(agyDispatch.args.input.run_mode).toBe('ephemeral_review');
    expect(agyDispatch.args.input.read_only).toBeUndefined();
    const peerDispatch = captured.find((c) => c.args.input.agent_id === 'peer')!;
    expect(peerDispatch.args.input.read_only).toBe(true);
  });

  it('routes via registry resolution, so an alias of an ephemeral adapter routes ephemeral too', async () => {
    const h = harnessWith([makeEphemeralAdapter()]);
    const implementer = await createRunState(h, { runId: 'impl-4', status: 'success' });
    const captured: CapturedDispatch[] = [];
    // Alias regression: the routing decision must go through registry.get
    // (which canonicalizes aliases), never through agent-id string matching.
    const aliasRegistry = {
      ...h.ctx.registry,
      get: (name: string) => h.ctx.registry.get(name === 'antigravity' ? 'agy' : name),
    } as typeof h.ctx.registry;

    const out = await runPanelHandler({
      implementer_run_id: implementer.runId,
      reviewers: [{ agent_id: 'antigravity', prompt: 'review it' }],
    }, {
      ...h.ctx,
      registry: aliasRegistry,
      dispatchRunAgentInternalImpl: capturingDispatchImpl(captured),
    });

    expect(out.failed_reviewers).toEqual([]);
    expect(captured[0].args.input.run_mode).toBe('ephemeral_review');
    expect(captured[0].args.ephemeralReviewSnapshot?.sourcePath).toBe(implementer.worktreePath);
  });

  it('fails a reviewDispatchMode:unsupported reviewer without touching the rest of the panel', async () => {
    const h = harnessWith([
      makeMockAdapter({ name: 'nope', reviewDispatchMode: 'unsupported' }),
      makeMockAdapter({ name: 'peer' }),
    ]);
    const captured: CapturedDispatch[] = [];

    const out = await runPanelHandler({
      reviewers: [
        { agent_id: 'nope', prompt: 'review it' },
        { agent_id: 'peer', prompt: 'review it' },
      ],
    }, { ...h.ctx, dispatchRunAgentInternalImpl: capturingDispatchImpl(captured) });

    expect(out.partial).toBe(true);
    expect(out.failed_reviewers).toHaveLength(1);
    expect(out.failed_reviewers[0].agent_id).toBe('nope');
    expect(out.failed_reviewers[0].error).toContain('run_panel.reviewer_dispatch_unsupported');
    expect(captured.map((c) => c.args.input.agent_id)).toEqual(['peer']);
  });

  it('the implementer snapshot guard trips on each drift leg: status, prompts, completedAt', async () => {
    const h = harnessWith([makeEphemeralAdapter()]);
    const implementer = await createRunState(h, { runId: 'impl-5', status: 'success' });
    const captured: CapturedDispatch[] = [];

    await runPanelHandler({
      implementer_run_id: implementer.runId,
      reviewers: [{ agent_id: 'agy', prompt: 'review it' }],
    }, { ...h.ctx, dispatchRunAgentInternalImpl: capturingDispatchImpl(captured) });

    const assertStable = captured[0].args.ephemeralReviewSnapshot?.assertSourceStableAfterSync;
    expect(assertStable).toBeDefined();
    // Stable implementer → no throw.
    expect(() => assertStable!()).not.toThrow();

    const baseline = h.runStateStore.read(implementer.runId)!;

    // Status leg (e.g. a continue_run flipping the run back to running).
    await h.runStateStore.update(implementer.runId, (state) => ({
      ...state,
      status: 'partial' as const,
    }));
    expect(() => assertStable!()).toThrow(/run_panel\.implementer_mutated_during_snapshot/);
    await h.runStateStore.update(implementer.runId, (state) => ({
      ...state,
      status: baseline.status,
    }));
    expect(() => assertStable!()).not.toThrow();

    // Prompts leg (a continue_run appends a prompt record).
    await h.runStateStore.update(implementer.runId, (state) => ({
      ...state,
      prompts: [...state.prompts, { ...state.prompts[0] }],
    }));
    expect(() => assertStable!()).toThrow(/run_panel\.implementer_mutated_during_snapshot/);
    await h.runStateStore.update(implementer.runId, (state) => ({
      ...state,
      prompts: baseline.prompts.slice(),
    }));
    expect(() => assertStable!()).not.toThrow();

    // completedAt leg.
    await h.runStateStore.update(implementer.runId, (state) => ({
      ...state,
      completedAt: '2099-01-01T00:00:00.000Z',
    }));
    expect(() => assertStable!()).toThrow(/run_panel\.implementer_mutated_during_snapshot/);
  });
});

describe('plan-time snapshot-source rejection', () => {
  it('rejects an ephemeralReviewSnapshot supplied for non-ephemeral run modes', async () => {
    const h = harnessWith([makeMockAdapter({ name: 'peer' })]);
    const snapshot = { sourcePath: h.root };

    // write (default) mode: a stray source must never redirect the checkout.
    await expect(dispatchRunAgentInternal({
      input: { agent_id: 'peer', prompt: 'implement it' },
      ctx: h.ctx,
      ephemeralReviewSnapshot: snapshot,
    })).rejects.toThrow(/only valid with run_mode:'ephemeral_review'/);

    // read_only mode: same rejection.
    await expect(dispatchRunAgentInternal({
      input: { agent_id: 'peer', prompt: 'review it', read_only: true },
      ctx: h.ctx,
      ephemeralReviewSnapshot: snapshot,
    })).rejects.toThrow(/only valid with run_mode:'ephemeral_review'/);
  });
});

describe('run_panel e2e — bound ephemeral reviewer acquisition', () => {
  it('gives the ephemeral reviewer a disposable snapshot carrying the implementer commit AND dirty state', async () => {
    const seenReview: Task[] = [];
    const builder = makeMockAdapter({
      name: 'builder',
      execute: async (task) => {
        const cwd = task.context.workingDirectory;
        writeFileSync(join(cwd, 'committed.txt'), 'committed by builder\n', 'utf-8');
        execSync('git add committed.txt && git commit -q -m "builder work"', { cwd });
        writeFileSync(join(cwd, 'dirty.txt'), 'dirty by builder\n', 'utf-8');
        return {
          output: 'built the thing',
          filesModified: ['committed.txt', 'dirty.txt'],
          status: 'success',
          metadata: {},
        };
      },
    });
    const agy = makeEphemeralAdapter({
      execute: async (task) => {
        seenReview.push(task);
        return { output: 'findings: looks fine', filesModified: [], status: 'success', metadata: {} };
      },
    });
    const h = harnessWith([builder, agy]);

    const impl = await dispatchRunAgentInternal({
      input: { agent_id: 'builder', prompt: 'build it' },
      ctx: h.ctx,
    });
    await waitFor(() => h.runStateStore.read(impl.runId)?.status !== 'running');
    expect(h.runStateStore.read(impl.runId)?.status).toBe('success');

    const out = await runPanelHandler({
      implementer_run_id: impl.runId,
      reviewers: [{ agent_id: 'agy', prompt: 'review the change' }],
    }, h.ctx);
    expect(out.failed_reviewers).toEqual([]);
    const reviewerRunId = out.reviewers[0].run_id;
    await waitFor(() => h.runStateStore.read(reviewerRunId)?.status !== 'running');

    const reviewerState = h.runStateStore.read(reviewerRunId);
    expect(reviewerState?.status).toBe('success');
    expect(reviewerState?.runMode).toBe('ephemeral_review');
    expect(reviewerState?.readOnly).toBe(true);
    expect(reviewerState?.filesChanged).toEqual([]);

    // The reviewer ran in its OWN worktree — not the implementer's, not the
    // host repo — seeing exactly what an in-place reviewer would: the
    // implementer's committed run work AND its uncommitted state.
    const reviewerWorktree = out.reviewers[0].worktree_path;
    expect(reviewerWorktree).not.toBe(impl.worktreePath);
    expect(reviewerWorktree).not.toBe(h.root);
    expect(seenReview[0].context.workingDirectory).toBe(reviewerWorktree);
    expect(seenReview[0].constraints?.sandbox).toBe('workspace-write');
    expect(seenReview[0].constraints?.reviewIntent).toBe(true);
    expect(readFileSync(join(reviewerWorktree, 'committed.txt'), 'utf-8'))
      .toBe('committed by builder\n');
    expect(readFileSync(join(reviewerWorktree, 'dirty.txt'), 'utf-8'))
      .toBe('dirty by builder\n');
    // Nothing leaked into the host checkout.
    expect(existsSync(join(h.root, 'committed.txt'))).toBe(false);
    expect(existsSync(join(h.root, 'dirty.txt'))).toBe(false);
  });
});
