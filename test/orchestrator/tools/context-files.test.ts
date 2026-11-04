import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentAdapter, RepositoryFileContext, Task } from '../../../src/adapters/types.js';
import { panelDir, readPanelState } from '../../../src/orchestrator/panels/store.js';
import { CONTEXT_EGRESS_SKIPPED_WARNING } from '../../../src/orchestrator/context-injection.js';
import { getPanelStatusHandler } from '../../../src/orchestrator/tools/get-panel-status.js';
import { aggregatePanelHandler } from '../../../src/orchestrator/tools/aggregate-panel.js';
import { getDefaultConfig } from '../../../src/workflow/config-codec.js';
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

  it('supports files-only continuation, rereads changed files, and never inherits attachments', async () => {
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
    expect(seen[2].context.repoContext).toBeUndefined();
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
