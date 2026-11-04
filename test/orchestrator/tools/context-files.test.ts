import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentAdapter, RepositoryFileContext, Task } from '../../../src/adapters/types.js';
import { panelDir, readPanelState } from '../../../src/orchestrator/panels/store.js';
import { CONTEXT_EGRESS_SKIPPED_WARNING } from '../../../src/orchestrator/context-injection.js';
import { getPanelStatusHandler } from '../../../src/orchestrator/tools/get-panel-status.js';
import { aggregatePanelHandler } from '../../../src/orchestrator/tools/aggregate-panel.js';
import { getDefaultConfig } from '../../../src/workflow/config-codec.js';
import { RunStateStore } from '../../../src/orchestrator/run-state.js';
import {
  continueRunInputSchema,
  continueRunToolHandler,
} from '../../../src/orchestrator/tools/continue-run.js';
import {
  planRunAgent,
  runAgentInputSchema,
  runAgentToolHandler,
} from '../../../src/orchestrator/tools/run-agent.js';
import {
  runPanelHandler,
  runPanelInputSchema,
} from '../../../src/orchestrator/tools/run-panel.js';
import type { ToolHandlerDeps, ToolRequestExtra } from '../../../src/orchestrator/tools/shared.js';
import {
  createRunState,
  makeHarness,
  makeMockAdapter,
  type PanelHarness,
  waitFor,
} from './panel-test-harness.js';

const cleanups: Array<() => Promise<void>> = [];
const extra: ToolRequestExtra = { sendNotification: async () => undefined };

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function harness(adapters: AgentAdapter[]): PanelHarness {
  const h = makeHarness(adapters);
  cleanups.push(h.cleanup);
  return h;
}

function textAdapter(overrides: Partial<AgentAdapter> = {}): AgentAdapter {
  return makeMockAdapter({
    name: 'text-worker',
    repoContextMode: 'supplied-text',
    acceptsRepoContext: true,
    unmetered: true,
    ...overrides,
  });
}

function depsFor(h: PanelHarness): ToolHandlerDeps {
  return {
    registry: h.ctx.registry as ToolHandlerDeps['registry'],
    worktreeManager: h.worktreeManager,
    runStateStore: h.runStateStore,
    dispatcher: h.dispatcher,
    crewHome: h.crewHome,
    projectRoot: h.root,
    getClientKind: () => 'unknown',
    getCrewWaitCommand: () => 'crew-wait',
    progressTokenSeen: { presentLogged: false, absentLogged: false },
    readAgentPrefs: () => ({}),
    loadWorkflowConfig: () => getDefaultConfig(),
  };
}

async function dispatch(h: PanelHarness, contextFiles?: string[]): Promise<string> {
  const result = await runAgentToolHandler({
    agent_id: 'text-worker',
    prompt: 'Review the attached files.',
    read_only: true,
    context_files: contextFiles,
  }, extra, depsFor(h));
  expect(result.isError).toBeUndefined();
  const runId = result.structuredContent?.run_id as string;
  expect(runId).toBeTypeOf('string');
  await waitFor(() => h.runStateStore.read(runId)?.status !== 'running');
  return runId;
}

describe('explicit repository file dispatch', () => {
  it('exposes identical bounded schemas on dispatch, continuation, and reviewers', () => {
    for (const paths of [['README.md'], [], Array(50).fill('README.md')]) {
      expect(runAgentInputSchema.safeParse({ agent_id: 'text', prompt: 'review', context_files: paths }).success).toBe(true);
      expect(continueRunInputSchema.safeParse({ run_id: 'run', context_files: paths }).success).toBe(true);
      expect(runPanelInputSchema.safeParse({ reviewers: [{ agent_id: 'text', prompt: 'review', context_files: paths }] }).success).toBe(true);
    }
    for (const paths of [[''], ['x'.repeat(4097)], Array(51).fill('README.md')]) {
      expect(runAgentInputSchema.safeParse({ agent_id: 'text', prompt: 'review', context_files: paths }).success).toBe(false);
      expect(continueRunInputSchema.safeParse({ run_id: 'run', context_files: paths }).success).toBe(false);
      expect(runPanelInputSchema.safeParse({ reviewers: [{ agent_id: 'text', prompt: 'review', context_files: paths }] }).success).toBe(false);
    }
  });

  it('rejects unsupported loaded adapters before creating runs or a panel', async () => {
    const unsupported = makeMockAdapter({ name: 'workspace' });
    const h = harness([textAdapter(), unsupported]);
    const allocate = vi.spyOn(h.worktreeManager, 'createRunWorktree');
    const execute = vi.spyOn(unsupported, 'execute');
    const plan = await planRunAgent({
      agent_id: 'workspace', prompt: 'review', context_files: ['README.md'],
    }, h.ctx);
    expect(plan).toMatchObject({ kind: 'error', message: expect.stringContaining('context_files.unsupported') });
    await expect(runPanelHandler({
      reviewers: [
        { agent_id: 'text-worker', prompt: 'review', context_files: ['README.md'] },
        { agent_id: 'workspace', prompt: 'review', context_files: ['README.md'] },
      ],
    }, h.ctx)).rejects.toThrow('context_files.unsupported');
    expect(allocate).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(existsSync(join(h.crewHome, 'panels'))).toBe(false);
  });

  it.each(['success', 'error', 'throw'] as const)('persists omission warnings on terminal %s', async (outcome) => {
    let context: RepositoryFileContext | undefined;
    const h = harness([textAdapter({
      execute: async (task) => {
        context = task.context.repoContext;
        if (outcome === 'throw') throw new Error('provider echoed visible repository text');
        return { output: 'result', filesModified: [], status: outcome, metadata: {} };
      },
    })]);
    writeFileSync(join(h.root, 'review.txt'), 'visible repository text');
    const runId = await dispatch(h, ['review.txt', 'missing.txt']);
    expect(context?.files).toEqual([{ path: 'review.txt', content: 'visible repository text' }]);
    expect(context?.omissions).toEqual([expect.objectContaining({ path: 'missing.txt' })]);
    const state = h.runStateStore.read(runId)!;
    expect(state.status).toBe(outcome === 'success' ? 'success' : 'error');
    expect(JSON.stringify(state)).not.toContain('visible repository text');
    expect(state.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('context_file_omitted'),
      expect.stringContaining('repo_context.supplied_text_only'),
    ]));
  });

  it('warns immediately and at terminal when remote file context is denied, and honors opt-in', async () => {
    vi.stubEnv('CREW_OPENAI_ALLOW_REMOTE_CONTEXT', '');
    const seen: Array<RepositoryFileContext | undefined> = [];
    const h = harness([textAdapter({
      unmetered: false,
      execute: async (task) => {
        seen.push(task.context.repoContext);
        return { output: 'ok', filesModified: [], status: 'success', metadata: {} };
      },
    })]);
    const result = await runAgentToolHandler({
      agent_id: 'text-worker', prompt: 'review', read_only: true, context_files: ['README.md'],
    }, extra, depsFor(h));
    expect(result.structuredContent?.warnings).toContain(CONTEXT_EGRESS_SKIPPED_WARNING);
    const runId = result.structuredContent?.run_id as string;
    await waitFor(() => h.runStateStore.read(runId)?.status === 'success');
    expect(seen[0]?.files).toEqual([]);
    expect(seen[0]?.omissions).toEqual([{ path: 'README.md', reason: 'remote_context_disabled' }]);
    expect(h.runStateStore.read(runId)?.warnings?.filter((warning) => warning === CONTEXT_EGRESS_SKIPPED_WARNING)).toHaveLength(1);

    vi.stubEnv('CREW_OPENAI_ALLOW_REMOTE_CONTEXT', '1');
    await dispatch(h, ['README.md']);
    expect(seen[1]?.files).toEqual([{ path: 'README.md', content: 'init\n' }]);
  });

  it('supports files-only continuation and rereads files without inheriting named attachments', async () => {
    const seen: Task[] = [];
    const h = harness([textAdapter({
      execute: async (task) => {
        seen.push(task);
        return { output: 'ok', filesModified: [], status: 'success', metadata: {} };
      },
    })]);
    const runId = await dispatch(h, ['README.md']);
    writeFileSync(join(h.root, 'README.md'), 'updated text\n');
    const withFiles = await continueRunToolHandler(continueRunInputSchema.parse({
      run_id: runId, context_files: ['README.md'],
    }), extra, depsFor(h));
    expect(withFiles.isError).toBeUndefined();
    await waitFor(() => seen.length === 2 && h.runStateStore.read(runId)?.status === 'success');
    expect(seen[1].context.repoContext?.files).toEqual([{ path: 'README.md', content: 'updated text\n' }]);
    expect(h.runStateStore.read(runId)?.prompts.at(-1)?.prompt).toBe('');

    const withoutFiles = await continueRunToolHandler(continueRunInputSchema.parse({
      run_id: runId, prompt: 'Answer only from this new text.',
    }), extra, depsFor(h));
    expect(withoutFiles.isError).toBeUndefined();
    await waitFor(() => seen.length === 3 && h.runStateStore.read(runId)?.status === 'success');
    expect(seen[2].context.repoContext?.files).toEqual([]);
    expect(seen[2].context.repoContext?.diff).toBeDefined();
    const noOp = await continueRunToolHandler(continueRunInputSchema.parse({
      run_id: runId, context_files: [],
    }), extra, depsFor(h));
    expect(noOp.isError).toBe(true);
  });

  it('includes live continuation omissions in panel status and aggregation', async () => {
    const h = harness([textAdapter()]);
    const panel = await runPanelHandler({
      reviewers: [{ agent_id: 'text-worker', prompt: 'review supplied text', read_only: true }],
    }, h.ctx);
    const runId = panel.reviewers[0].run_id;
    await waitFor(() => h.runStateStore.read(runId)?.status === 'success');
    await waitFor(() => readPanelState(panelDir(h.crewHome, panel.panel_id))?.reviewers
      .some((reviewer) => reviewer.dispatched && reviewer.terminalSnapshot !== undefined) === true);
    const continued = await continueRunToolHandler(continueRunInputSchema.parse({
      run_id: runId, prompt: 'review attached follow-up', context_files: ['missing-follow-up.txt'],
    }), extra, depsFor(h));
    expect(continued.isError).toBeUndefined();
    await waitFor(() => h.runStateStore.read(runId)?.prompts.length === 2
      && h.runStateStore.read(runId)?.status === 'success');
    expect(readPanelState(panelDir(h.crewHome, panel.panel_id))?.reviewers[0].dispatchWarnings)
      .not.toEqual(expect.arrayContaining([expect.stringContaining('context_file_omitted')]));
    expect(getPanelStatusHandler({ panel_id: panel.panel_id }, h.ctx).reviewers[0].dispatch_warnings)
      .toEqual(expect.arrayContaining([expect.stringContaining('context_file_omitted')]));
    expect(aggregatePanelHandler({ panel_id: panel.panel_id }, h.ctx).warnings)
      .toEqual(expect.arrayContaining([expect.stringContaining('context_file_omitted')]));
  });

  it('omits aggregate warnings when no reviewer has repository-context warnings', async () => {
    const h = harness([makeMockAdapter({ name: 'workspace' })]);
    const panel = await runPanelHandler({
      reviewers: [{ agent_id: 'workspace', prompt: 'review', read_only: true }],
    }, h.ctx);
    await waitFor(() => h.runStateStore.read(panel.reviewers[0].run_id)?.status === 'success');
    const aggregate = aggregatePanelHandler({ panel_id: panel.panel_id }, h.ctx);
    expect(aggregate).not.toHaveProperty('warnings');
  });

  it('refuses unsupported continuation before appending its prompt', async () => {
    const h = harness([makeMockAdapter({ name: 'workspace' })]);
    await createRunState(h, { runId: 'run', agentId: 'workspace', readOnly: true, worktreePath: h.root });
    const prior = h.runStateStore.read('run');
    const result = await continueRunToolHandler(continueRunInputSchema.parse({
      run_id: 'run', context_files: ['README.md'],
    }), extra, depsFor(h));
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('context_files.unsupported');
    expect(h.runStateStore.read('run')).toEqual(prior);
  });

  it.each(['unbound', 'bound', 'ephemeral'] as const)('attaches files from the %s reviewer checkout', async (placement) => {
    let context: Task['context'] | undefined;
    const h = harness([textAdapter({
      ...(placement === 'ephemeral' ? { reviewDispatchMode: 'ephemeral-worktree' as const } : {}),
      execute: async (task) => {
        context = task.context;
        return { output: 'reviewed', filesModified: [], status: 'success', metadata: {} };
      },
    })]);
    writeFileSync(join(h.root, 'review.txt'), 'host checkout');
    const worktreePath = await h.worktreeManager.createRunWorktree('impl');
    writeFileSync(join(worktreePath, 'review.txt'), 'implementer checkout');
    await createRunState(h, { runId: 'impl', worktreePath });
    const panel = await runPanelHandler({
      ...(placement === 'unbound' ? {} : { implementer_run_id: 'impl' }),
      reviewers: [{
        agent_id: 'text-worker', prompt: 'review', context_files: ['review.txt', 'missing.txt'],
        ...(placement === 'unbound' ? { read_only: true } : {}),
      }],
    }, h.ctx);
    expect(panel.partial).toBe(false);
    const runId = panel.reviewers[0].run_id;
    await waitFor(() => h.runStateStore.read(runId)?.status === 'success');
    expect(context?.repoContext?.files).toEqual([{
      path: 'review.txt', content: placement === 'unbound' ? 'host checkout' : 'implementer checkout',
    }]);
    if (placement === 'ephemeral') {
      expect(context?.workingDirectory).not.toBe(h.root);
      expect(context?.workingDirectory).not.toBe(worktreePath);
      expect(h.runStateStore.read(runId)?.runMode).toBe('ephemeral_review');
    }
    expect(h.runStateStore.read(runId)?.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('context_file_omitted'),
    ]));
    await waitFor(() => readPanelState(panelDir(h.crewHome, panel.panel_id))
      ?.reviewers[0].dispatchWarnings.some((warning) => warning.includes('context_file_omitted')) === true);
    const read = vi.spyOn(h.runStateStore, 'read').mockReturnValue(undefined);
    try {
      const snapshotStatus = getPanelStatusHandler({ panel_id: panel.panel_id }, h.ctx);
      expect(snapshotStatus.reviewers[0].dispatch_warnings).toEqual(expect.arrayContaining([
        expect.stringContaining('context_file_omitted'),
      ]));
      const aggregate = aggregatePanelHandler({ panel_id: panel.panel_id }, h.ctx);
      expect(aggregate.warnings).toEqual(expect.arrayContaining([
        expect.stringContaining('context_file_omitted'),
        expect.stringContaining('repo_context.supplied_text_only'),
      ]));
      expect(aggregate.warnings?.every((warning) => warning.includes('text-worker') && warning.includes(runId))).toBe(true);
      expect(aggregate.peer_messages[0].body).toBe('reviewed');
    } finally {
      read.mockRestore();
    }
  });
});

describe('automatic review context dispatch', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const outputs = (seen: Task[]) => textAdapter({
    execute: async (task) => {
      seen.push(task);
      return { output: 'reviewed', filesModified: [], status: 'success', metadata: {} };
    },
  });
  const patches = (task: Task) => task.context.repoContext?.diff?.files.map((file) => file.patch).join('\n') ?? '';

  async function dispatchAt(h: PanelHarness, workingDirectory: string): Promise<string> {
    const out = await runAgentToolHandler({
      agent_id: 'text-worker', prompt: 'Review the changes.', read_only: true, working_directory: workingDirectory,
    }, extra, depsFor(h));
    expect(out.isError).toBeUndefined();
    const runId = out.structuredContent?.run_id as string;
    await waitFor(() => h.runStateStore.read(runId)?.status === 'success');
    return runId;
  }

  it('includes staged, unstaged and untracked host work against HEAD without explicit files', async () => {
    const seen: Task[] = [];
    const h = harness([outputs(seen)]);
    writeFileSync(join(h.root, 'README.md'), 'staged work\n');
    git(h.root, 'add', 'README.md');
    writeFileSync(join(h.root, 'README.md'), 'unstaged final work\n');
    writeFileSync(join(h.root, 'new.txt'), 'untracked source\n');
    const runId = await dispatch(h);
    expect(seen[0].context.repoContext?.files).toEqual([]);
    expect(patches(seen[0])).toContain('unstaged final work');
    expect(patches(seen[0])).toContain('untracked source');
    expect(seen[0].context.repoContext?.diff?.source).toBe('host-head');
    expect(h.runStateStore.read(runId)?.repositoryReviewSource).toEqual({ kind: 'head' });
  });

  it('keeps a source run branch point through committed work, continuation and a new state-store instance', async () => {
    const seen: Task[] = [];
    const h = harness([outputs(seen)]);
    const base = git(h.root, 'rev-parse', 'HEAD');
    const path = await h.worktreeManager.createRunWorktree('impl-committed');
    writeFileSync(join(path, 'committed.txt'), 'first committed change\n');
    git(path, 'add', 'committed.txt');
    git(path, 'commit', '-qm', 'first change');
    const reviewer = await dispatchAt(h, path);
    expect(patches(seen[0])).toContain('first committed change');
    expect(seen[0].context.repoContext?.diff?.source).toBe('run-branch-point');
    expect(h.runStateStore.read(reviewer)?.repositoryReviewSource).toEqual({ kind: 'run', sourceRunId: 'impl-committed', baseCommit: base });

    writeFileSync(join(path, 'second.txt'), 'second committed change\n');
    git(path, 'add', 'second.txt');
    git(path, 'commit', '-qm', 'second change');
    const freshStore = new RunStateStore({ crewHome: h.crewHome, repoRoot: h.root });
    try {
      const result = await continueRunToolHandler(continueRunInputSchema.parse({ run_id: reviewer, prompt: 'Review all changes again.' }), extra, { ...depsFor(h), runStateStore: freshStore });
      expect(result.isError).toBeUndefined();
      await waitFor(() => seen.length === 2 && freshStore.read(reviewer)?.status === 'success');
      expect(patches(seen[1])).toContain('first committed change');
      expect(patches(seen[1])).toContain('second committed change');
      expect(seen[1].context.repoContext?.diff?.baseCommit).toBe(base);
      expect(freshStore.read(reviewer)?.repositoryReviewSource).toEqual({ kind: 'run', sourceRunId: 'impl-committed', baseCommit: base });
    } finally {
      freshStore.closeEventAppendHandles();
    }
  });

  it('binds panels to committed implementer changes but respects an explicit different checkout', async () => {
    const seen: Task[] = [];
    const h = harness([outputs(seen)]);
    const source = await h.worktreeManager.createRunWorktree('impl-panel');
    writeFileSync(join(source, 'committed.txt'), 'implementer commit\n');
    git(source, 'add', 'committed.txt');
    git(source, 'commit', '-qm', 'implementer');
    await createRunState(h, { runId: 'impl-panel', worktreePath: source });
    writeFileSync(join(h.root, 'host.txt'), 'host-only WIP\n');
    const panel = await runPanelHandler({
      implementer_run_id: 'impl-panel',
      reviewers: [
        { agent_id: 'text-worker', prompt: 'Review implementer' },
        { agent_id: 'text-worker', prompt: 'Review explicit host', working_directory: h.root },
      ],
    }, h.ctx);
    await waitFor(() => panel.reviewers.every((r) => h.runStateStore.read(r.run_id)?.status === 'success'));
    const bound = seen.find((task) => task.context.workingDirectory === source)!;
    const host = seen.find((task) => task.context.workingDirectory === h.root)!;
    expect(patches(bound)).toContain('implementer commit');
    expect(patches(bound)).not.toContain('host-only WIP');
    expect(patches(host)).toContain('host-only WIP');
    expect(patches(host)).not.toContain('implementer commit');
  });

  it('does not inspect source metadata or run host/dirty Git probes while remote context is denied', async () => {
    const seen: Task[] = [];
    const h = harness([{ ...outputs(seen), unmetered: false }]);
    vi.stubEnv('CREW_OPENAI_ALLOW_REMOTE_CONTEXT', '');
    const metadata = vi.spyOn(h.worktreeManager, 'resolveRepositoryReviewSource');
    const hostReady = vi.spyOn(h.worktreeManager, 'assertHostRepoReadyForDispatch');
    await h.worktreeManager.drainBackgroundCleanups();
    const probeMarker = join(h.crewHome, 'unexpected-git-probe');
    const monitor = join(h.crewHome, 'fsmonitor.sh');
    writeFileSync(monitor, `#!/bin/sh\nprintf x > '${probeMarker.replaceAll("'", "'\\''")}'\nprintf 'token\\0'\n`, { mode: 0o755 });
    git(h.root, 'config', 'core.fsmonitor', monitor);
    const result = await runAgentToolHandler({ agent_id: 'text-worker', prompt: 'review', read_only: true }, extra, depsFor(h));
    const runId = result.structuredContent?.run_id as string;
    expect(result.structuredContent?.warnings).toContain(CONTEXT_EGRESS_SKIPPED_WARNING);
    await waitFor(() => h.runStateStore.read(runId)?.status === 'success');
    expect(metadata).not.toHaveBeenCalled();
    expect(hostReady).not.toHaveBeenCalled();
    expect(existsSync(probeMarker)).toBe(false);
    expect(h.runStateStore.read(runId)?.repositoryReviewSource).toBeUndefined();
    expect(seen[0].context.repoContext?.diff?.complete).toBe(false);

    writeFileSync(join(h.root, 'new.txt'), 'newly allowed context');
    vi.stubEnv('CREW_OPENAI_ALLOW_REMOTE_CONTEXT', '1');
    const next = await continueRunToolHandler(continueRunInputSchema.parse({ run_id: runId, prompt: 'Review now.' }), extra, depsFor(h));
    expect(next.isError).toBeUndefined();
    await waitFor(() => seen.length === 2 && h.runStateStore.read(runId)?.status === 'success');
    expect(metadata).toHaveBeenCalledOnce();
    expect(patches(seen[1])).toContain('newly allowed context');
    expect(h.runStateStore.read(runId)?.repositoryReviewSource).toEqual({ kind: 'head' });
    expect(existsSync(probeMarker)).toBe(false);
  });

  it.each(['write', 'ephemeral_review', 'workspace', 'unknown', 'incapable'] as const)('does not automatically collect diffs for %s', async (excluded) => {
    const seen: Task[] = [];
    const adapter = outputs(seen);
    const h = harness([{ ...adapter,
      ...(excluded === 'workspace' || excluded === 'unknown' ? { repoContextMode: excluded } : {}),
      ...(excluded === 'incapable' ? { acceptsRepoContext: false } : {}),
      ...(excluded === 'ephemeral_review' ? { reviewDispatchMode: 'ephemeral-worktree' as const } : {}),
    }]);
    writeFileSync(join(h.root, 'dirty.txt'), 'copied WIP must not auto inject');
    const source = vi.spyOn(h.worktreeManager, 'resolveRepositoryReviewSource');
    const plan = await planRunAgent({
      agent_id: 'text-worker', prompt: 'task',
      run_mode: excluded === 'write' || excluded === 'ephemeral_review' ? excluded : 'read_only',
      ...(excluded === 'incapable' ? {} : { context_files: ['README.md'] }),
    }, h.ctx);
    expect(plan.kind).toBe('dispatched');
    if (plan.kind !== 'dispatched') return;
    await plan.buildTask('task').run({ signal: new AbortController().signal });
    expect(seen[0].context.repoContext?.diff).toBeUndefined();
    expect(source).not.toHaveBeenCalled();
    if (excluded !== 'incapable') expect(seen[0].context.repoContext?.files).toHaveLength(1);
  });

  it('never substitutes HEAD when a known run has missing or mismatched metadata', async () => {
    const seen: Task[] = [];
    const h = harness([outputs(seen)]);
    const path = await h.worktreeManager.createRunWorktree('lost-impl');
    const metadata = join(h.crewHome, 'runs', '.meta', 'lost-impl.json');
    const record = JSON.parse(readFileSync(metadata, 'utf8'));
    rmSync(metadata);
    const missing = await dispatchAt(h, path);
    expect(seen[0].context.repoContext?.diff?.complete).toBe(false);
    expect(h.runStateStore.read(missing)?.warnings).toEqual(expect.arrayContaining([expect.stringContaining('context_')]));
    writeFileSync(metadata, JSON.stringify({ ...record, worktreePath: h.root }));
    await dispatchAt(h, path);
    expect(seen[1].context.repoContext?.diff?.complete).toBe(false);
    expect(seen[1].context.repoContext?.diff?.source).not.toBe('host-head');

    // Unavailable discovery is not persisted as a permanent baseline. A later
    // allowed turn can recover once authoritative ownership metadata returns.
    expect(h.runStateStore.read(missing)?.repositoryReviewSource).toBeUndefined();
    writeFileSync(metadata, JSON.stringify(record));
    const recovered = await continueRunToolHandler(continueRunInputSchema.parse({ run_id: missing, prompt: 'Review after metadata recovery.' }), extra, depsFor(h));
    expect(recovered.isError).toBeUndefined();
    await waitFor(() => seen.length === 3 && h.runStateStore.read(missing)?.status === 'success');
    expect(h.runStateStore.read(missing)?.repositoryReviewSource).toMatchObject({ kind: 'run', sourceRunId: 'lost-impl' });
  });

  it('rejects tampered persisted run source on continuation', async () => {
    const seen: Task[] = [];
    const h = harness([outputs(seen)]);
    const path = await h.worktreeManager.createRunWorktree('tamper-impl');
    const runId = await dispatchAt(h, path);
    await h.runStateStore.update(runId, (state) => ({ ...state, repositoryReviewSource: { kind: 'run', sourceRunId: '../../escape', baseCommit: '--upload-pack=bad' } }));
    const result = await continueRunToolHandler(continueRunInputSchema.parse({ run_id: runId, prompt: 'review again' }), extra, depsFor(h));
    expect(result.isError).toBeUndefined();
    await waitFor(() => seen.length === 2 && h.runStateStore.read(runId)?.status === 'success');
    expect(seen[1].context.repoContext?.diff?.complete).toBe(false);
    expect(JSON.stringify(seen[1].context.repoContext)).not.toContain('--upload-pack');
  });

  it('keeps the established baseline when source metadata changes and recovers when restored', async () => {
    const seen: Task[] = [];
    const h = harness([outputs(seen)]);
    const source = await h.worktreeManager.createRunWorktree('changed-base');
    const base = git(source, 'rev-parse', 'HEAD');
    writeFileSync(join(source, 'change.txt'), 'committed work retained');
    git(source, 'add', 'change.txt');
    git(source, 'commit', '-qm', 'work');
    const runId = await dispatchAt(h, source);
    const metadata = join(h.crewHome, 'runs', '.meta', 'changed-base.json');
    const record = JSON.parse(readFileSync(metadata, 'utf8'));
    writeFileSync(metadata, JSON.stringify({ ...record, branchPointSha: git(source, 'rev-parse', 'HEAD') }));
    await continueRunToolHandler(continueRunInputSchema.parse({ run_id: runId, prompt: 'review' }), extra, depsFor(h));
    await waitFor(() => seen.length === 2 && h.runStateStore.read(runId)?.status === 'success');
    expect(seen[1].context.repoContext?.diff?.complete).toBe(false);
    expect(h.runStateStore.read(runId)?.repositoryReviewSource).toMatchObject({ kind: 'run', baseCommit: base });
    writeFileSync(metadata, JSON.stringify(record));
    await continueRunToolHandler(continueRunInputSchema.parse({ run_id: runId, prompt: 'review' }), extra, depsFor(h));
    await waitFor(() => seen.length === 3 && h.runStateStore.read(runId)?.status === 'success');
    expect(patches(seen[2])).toContain('committed work retained');
  });

  it.each(['fifo', 'symlink', 'oversized'] as const)('refuses %s ownership metadata without hanging or following it', async (kind) => {
    const h = harness([textAdapter()]);
    const source = await h.worktreeManager.createRunWorktree('metadata-file');
    const metadata = join(h.crewHome, 'runs', '.meta', 'metadata-file.json');
    rmSync(metadata);
    if (kind === 'fifo') execFileSync('mkfifo', [metadata]);
    else if (kind === 'symlink') symlinkSync('/dev/zero', metadata);
    else writeFileSync(metadata, 'x'.repeat(16 * 1024 + 1));
    expect(h.worktreeManager.resolveRepositoryReviewSource(source, 'metadata-file').kind).toBe('unavailable');
  });

  it('discovers an authoritative ID that differs from its normalized directory token', async () => {
    const h = harness([textAdapter()]);
    const source = await h.worktreeManager.createRunWorktree('Case-Impl');
    expect(h.worktreeManager.resolveRepositoryReviewSource(source)).toEqual({
      kind: 'run', sourceRunId: 'Case-Impl', baseCommit: git(h.root, 'rev-parse', 'HEAD'),
    });
  });

  it('does not expand an explicitly selected subdirectory into an ancestor repository', async () => {
    const seen: Task[] = [];
    const h = harness([outputs(seen)]);
    mkdirSync(join(h.root, 'nested'));
    writeFileSync(join(h.root, 'outside.txt'), 'outside the selected directory');
    await dispatchAt(h, join(h.root, 'nested'));
    expect(patches(seen[0])).not.toContain('outside the selected directory');
    expect(seen[0].context.repoContext?.diff?.complete).toBe(false);
  });

  it('uses validated canonical metadata for a symlink alias of a run checkout', async () => {
    const seen: Task[] = [];
    const h = harness([outputs(seen)]);
    const path = await h.worktreeManager.createRunWorktree('alias-impl');
    writeFileSync(join(path, 'committed.txt'), 'alias source committed work');
    git(path, 'add', 'committed.txt');
    git(path, 'commit', '-qm', 'source');
    const alias = join(h.root, 'checkout-alias');
    symlinkSync(path, alias);
    const reviewer = await dispatchAt(h, alias);
    expect(patches(seen[0])).toContain('alias source committed work');
    expect(h.runStateStore.read(reviewer)?.repositoryReviewSource).toMatchObject({ kind: 'run', sourceRunId: 'alias-impl' });
  });
});
