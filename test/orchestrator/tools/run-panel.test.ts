import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TaskResult } from '../../../src/adapters/types.js';
import {
  DispatchError,
  dispatchRunAgentInternal,
  type DispatchRunAgentInternalResult,
} from '../../../src/orchestrator/dispatch-run-agent-internal.js';
import { buildImplementerPeerMessage } from '../../../src/orchestrator/panels/implementer-message.js';
import { panelDir, readPanelState } from '../../../src/orchestrator/panels/store.js';
import { buildPrependBlock } from '../../../src/orchestrator/peer-messages/prepend.js';
import { peerMessageInputSchema } from '../../../src/orchestrator/peer-messages/schema.js';
import type { DispatchTask } from '../../../src/orchestrator/tool-dispatcher.js';
import {
  runPanelHandler,
  type RunPanelHandlerContext,
} from '../../../src/orchestrator/tools/run-panel.js';
import { getPanelStatusHandler } from '../../../src/orchestrator/tools/get-panel-status.js';
import {
  createDeferred,
  createRunState,
  makeHarness,
  makeMockAdapter,
  type PanelHarness,
  waitFor,
} from './panel-test-harness.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

function cleanupHarness(h: PanelHarness): void {
  cleanups.push(h.cleanup);
}

function withEnv(overrides: Record<string, string>): () => void {
  const prior = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    prior.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function fakeDispatchResult(agentId: string, index: number): DispatchRunAgentInternalResult {
  return {
    runId: `${agentId}-run-${index}`,
    worktreePath: `/tmp/${agentId}-${index}`,
    readOnly: true,
    tailUrl: `crew-tail:///${agentId}-${index}`,
    tailCommandPath: `/tmp/${agentId}-${index}/tail.command`,
    toolCallId: `tool-${agentId}-${index}`,
    warnings: [],
  };
}

describe('runPanelHandler', () => {
  it('dispatches two bound reviewers with stub and incremental panel writes', async () => {
    const terminals = [createDeferred<TaskResult>(), createDeferred<TaskResult>()];
    const executions: Array<{
      prompt: string;
      workingDirectory: string;
      sandbox: string | undefined;
    }> = [];
    let executeIndex = 0;
    const adapter = makeMockAdapter({
      name: 'reviewer',
      execute: async (task) => {
        executions.push({
          prompt: task.prompt,
          workingDirectory: task.context.workingDirectory,
          sandbox: task.constraints?.sandbox,
        });
        return terminals[executeIndex++].promise;
      },
    });
    const h = makeHarness([adapter]);
    cleanupHarness(h);
    const implementer = await createRunState(h, {
      runId: 'impl',
      agentId: 'impl`agent#',
      summary: 'Implemented the feature',
      filesChanged: ['src/impl.ts'],
    });
    const writeSizes: number[] = [];

    const out = await runPanelHandler({
      implementer_run_id: 'impl',
      reviewers: [
        { agent_id: 'reviewer', prompt: 'review correctness' },
        { agent_id: 'reviewer', prompt: 'review style' },
      ],
    }, {
      ...h.ctx,
      onPanelStateWritten: (state) => {
        writeSizes.push(state.reviewers.length);
      },
    });

    expect(out.partial).toBe(false);
    expect(out.reviewers).toHaveLength(2);
    expect(out.failed_reviewers).toEqual([]);
    expect(writeSizes).toEqual([0, 1, 2]);

    const panelState = readPanelState(panelDir(h.crewHome, out.panel_id));
    expect(panelState?.panelRepoRoot).toBe(h.runStateStore.repoRoot);
    expect(panelState?.implementerRunId).toBe('impl');
    expect(panelState?.reviewers).toHaveLength(2);

    for (const reviewer of out.reviewers) {
      const state = h.runStateStore.read(reviewer.run_id);
      expect(state?.worktreePath).toBe(implementer.worktreePath);
      expect(state?.readOnly).toBe(true);
      const stored = state?.prompts[0].peer_messages_input ?? [];
      expect(stored[0]).toMatchObject({
        body: 'Implemented the feature',
        kind: 'review',
        from_label: 'impl_agent_ (run impl)',
        files: ['src/impl.ts'],
      });
    }

    await waitFor(() => executions.length === 2);
    expect(executions.map((e) => e.workingDirectory)).toEqual([
      implementer.worktreePath,
      implementer.worktreePath,
    ]);
    expect(executions.map((e) => e.sandbox)).toEqual(['read-only', 'read-only']);

    terminals[0].resolve({ output: 'r1', filesModified: [], status: 'success', metadata: {} });
    terminals[1].resolve({ output: 'r2', filesModified: [], status: 'success', metadata: {} });
    await waitFor(() => out.reviewers.every((r) =>
      h.runStateStore.read(r.run_id)?.status === 'success'));
  });

  it('suppresses bound working_directory auto-default when reviewer sets read_only false', async () => {
    const executions: Array<{ workingDirectory: string; sandbox?: string }> = [];
    const adapter = makeMockAdapter({
      name: 'reviewer',
      execute: async (task) => {
        executions.push({
          workingDirectory: task.context.workingDirectory,
          sandbox: task.constraints?.sandbox,
        });
        return { output: 'ok', filesModified: [], status: 'success', metadata: {} };
      },
    });
    const h = makeHarness([adapter]);
    cleanupHarness(h);
    const implementer = await createRunState(h, { runId: 'impl' });

    const out = await runPanelHandler({
      implementer_run_id: 'impl',
      reviewers: [{ agent_id: 'reviewer', prompt: 'review', read_only: false }],
    }, h.ctx);

    await waitFor(() => executions.length === 1);
    expect(out.reviewers).toHaveLength(1);
    expect(out.reviewers[0].worktree_path).not.toBe(implementer.worktreePath);
    expect(executions[0].workingDirectory).toBe(out.reviewers[0].worktree_path);
    expect(executions[0].sandbox).toBe('workspace-write');
    expect(h.runStateStore.read(out.reviewers[0].run_id)?.readOnly).toBeUndefined();
  });

  it('uses explicit working_directory with read_only false on a bound reviewer', async () => {
    const executions: string[] = [];
    const adapter = makeMockAdapter({
      name: 'reviewer',
      execute: async (task) => {
        executions.push(task.context.workingDirectory);
        return { output: 'ok', filesModified: [], status: 'success', metadata: {} };
      },
    });
    const h = makeHarness([adapter]);
    cleanupHarness(h);
    await createRunState(h, { runId: 'impl' });
    const explicit = join(h.root, 'explicit-wd');
    mkdirSync(explicit);

    const out = await runPanelHandler({
      implementer_run_id: 'impl',
      reviewers: [{
        agent_id: 'reviewer',
        prompt: 'review',
        read_only: false,
        working_directory: explicit,
      }],
    }, h.ctx);

    await waitFor(() => executions.length === 1);
    expect(executions[0]).toBe(explicit);
    expect(out.reviewers[0].worktree_path).not.toBe(explicit);
  });

  it('uses plain run_agent semantics when unbound', async () => {
    const adapter = makeMockAdapter({
      name: 'reviewer',
      execute: async () => ({ output: 'ok', filesModified: [], status: 'success', metadata: {} }),
    });
    const h = makeHarness([adapter]);
    cleanupHarness(h);

    const out = await runPanelHandler({
      reviewers: [{ agent_id: 'reviewer', prompt: 'review' }],
    }, h.ctx);

    const panelState = readPanelState(panelDir(h.crewHome, out.panel_id));
    expect(panelState?.panelRepoRoot).toBe(h.runStateStore.repoRoot);
    expect(panelState?.implementerRunId).toBeUndefined();
    const reviewerState = h.runStateStore.read(out.reviewers[0].run_id);
    expect(reviewerState?.readOnly).toBeUndefined();
    expect(reviewerState?.worktreePath).toBe(out.reviewers[0].worktree_path);
    expect(reviewerState?.prompts[0].peer_messages_input).toBeUndefined();
  });

  it('records a failing reviewer and still dispatches later reviewers', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'good' })]);
    cleanupHarness(h);
    await createRunState(h, { runId: 'impl' });

    const out = await runPanelHandler({
      implementer_run_id: 'impl',
      reviewers: [
        { agent_id: 'good', prompt: 'review 1' },
        { agent_id: 'missing', prompt: 'review 2' },
        { agent_id: 'good', prompt: 'review 3' },
      ],
    }, h.ctx);

    expect(out.partial).toBe(true);
    expect(out.reviewers).toHaveLength(2);
    expect(out.failed_reviewers).toEqual([
      {
        agent_id: 'missing',
        error: expect.stringContaining('Unknown agent_id "missing"'),
      },
    ]);
    expect(readPanelState(panelDir(h.crewHome, out.panel_id))?.reviewers)
      .toHaveLength(3);
  });

  it('rejects every implementer preflight path with namespaced errors', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'reviewer' })]);
    cleanupHarness(h);

    await expect(runPanelHandler({
      reviewers: Array.from({ length: 21 }, (_, index) => ({
        agent_id: 'reviewer',
        prompt: `review ${index}`,
      })),
    }, h.ctx)).rejects.toThrow(/^run_panel\.too_many_reviewers:/);

    await expect(runPanelHandler({
      implementer_run_id: 'missing',
      reviewers: [{ agent_id: 'reviewer', prompt: 'review' }],
    }, h.ctx)).rejects.toThrow(/^run_panel\.implementer_unknown:/);

    for (const status of ['running', 'discarded', 'merged', 'merge_conflict'] as const) {
      await createRunState(h, { runId: `impl-${status}`, status });
      await expect(runPanelHandler({
        implementer_run_id: `impl-${status}`,
        reviewers: [{ agent_id: 'reviewer', prompt: 'review' }],
      }, h.ctx)).rejects.toThrow(/^run_panel\.implementer_not_terminal:/);
    }

    const unavailable = await createRunState(h, { runId: 'impl-unavailable' });
    rmSync(unavailable.worktreePath, { recursive: true, force: true });
    await expect(runPanelHandler({
      implementer_run_id: 'impl-unavailable',
      reviewers: [{ agent_id: 'reviewer', prompt: 'review' }],
    }, h.ctx)).rejects.toThrow(/^run_panel\.implementer_worktree_unavailable:/);

    await createRunState(h, { runId: 'impl-legacy', repoRoot: null });
    await expect(runPanelHandler({
      implementer_run_id: 'impl-legacy',
      reviewers: [{ agent_id: 'reviewer', prompt: 'review' }],
    }, h.ctx)).rejects.toThrow(/^run_panel\.implementer_legacy_no_repo:/);

    await createRunState(h, { runId: 'impl-foreign', repoRoot: '/other/repo' });
    await expect(runPanelHandler({
      implementer_run_id: 'impl-foreign',
      reviewers: [{ agent_id: 'reviewer', prompt: 'review' }],
    }, h.ctx)).rejects.toThrow(/^run_panel\.implementer_cross_repo:/);
  });

  it('records a failed reviewer when implementer worktree disappears mid-dispatch', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'reviewer' })]);
    cleanupHarness(h);
    const implementer = await createRunState(h, { runId: 'impl' });

    const out = await runPanelHandler({
      implementer_run_id: 'impl',
      reviewers: [
        { agent_id: 'reviewer', prompt: 'review 1' },
        { agent_id: 'reviewer', prompt: 'review 2' },
        { agent_id: 'reviewer', prompt: 'review 3' },
      ],
    }, {
      ...h.ctx,
      onPanelStateWritten: (state) => {
        if (state.reviewers.length === 2) {
          rmSync(implementer.worktreePath, { recursive: true, force: true });
        }
      },
    });

    expect(out.reviewers).toHaveLength(2);
    expect(out.failed_reviewers).toEqual([
      {
        agent_id: 'reviewer',
        error: expect.stringContaining('working_directory does not exist:'),
      },
    ]);
  });

  it('keeps concurrent panels isolated', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'reviewer' })]);
    cleanupHarness(h);
    await createRunState(h, { runId: 'impl-a', summary: 'A' });
    await createRunState(h, { runId: 'impl-b', summary: 'B' });

    const [a, b] = await Promise.all([
      runPanelHandler({
        implementer_run_id: 'impl-a',
        reviewers: [{ agent_id: 'reviewer', prompt: 'review A' }],
      }, h.ctx),
      runPanelHandler({
        implementer_run_id: 'impl-b',
        reviewers: [{ agent_id: 'reviewer', prompt: 'review B' }],
      }, h.ctx),
    ]);

    expect(a.panel_id).not.toBe(b.panel_id);
    const stateA = readPanelState(panelDir(h.crewHome, a.panel_id));
    const stateB = readPanelState(panelDir(h.crewHome, b.panel_id));
    expect(stateA?.implementerRunId).toBe('impl-a');
    expect(stateB?.implementerRunId).toBe('impl-b');
    expect(stateA?.reviewers[0]?.runId).not.toBe(stateB?.reviewers[0]?.runId);
  });

  it('records DispatchError failures and preserves warnings from the helper', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'reviewer' })]);
    cleanupHarness(h);
    let call = 0;

    const out = await runPanelHandler({
      reviewers: [
        { agent_id: 'reviewer', prompt: 'review 1' },
        { agent_id: 'reviewer', prompt: 'review 2' },
        { agent_id: 'reviewer', prompt: 'review 3' },
      ],
    }, {
      ...h.ctx,
      dispatchRunAgentInternalImpl: async (args) => {
        call += 1;
        if (call === 3) {
          throw new DispatchError('mock dispatch failed', {
            warnings: ['peer_messages.body_truncated: item[0]'],
          });
        }
        return dispatchRunAgentInternal(args);
      },
    });

    expect(out.reviewers).toHaveLength(2);
    expect(out.failed_reviewers).toEqual([
      { agent_id: 'reviewer', error: 'mock dispatch failed' },
    ]);
    const records = readPanelState(panelDir(h.crewHome, out.panel_id))?.reviewers ?? [];
    expect(records[2]).toMatchObject({
      dispatched: false,
      dispatchWarnings: ['peer_messages.body_truncated: item[0]'],
    });
  });

  it('records plan.kind error from a missing agent as failed_reviewer', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'reviewer' })]);
    cleanupHarness(h);
    const out = await runPanelHandler({
      reviewers: [{ agent_id: 'missing', prompt: 'review' }],
    }, h.ctx);

    expect(out.partial).toBe(true);
    expect(out.reviewers).toEqual([]);
    expect(out.failed_reviewers[0].error).toContain('Unknown agent_id "missing"');
  });

  it('records dispatcher.start sync throw, terminal error state, cleanup, and warnings', async () => {
    const restore = withEnv({ CREW_PEER_MESSAGE_BODY_CAP_CHARS: '8' });
    try {
      const h = makeHarness([makeMockAdapter({ name: 'reviewer' })]);
      cleanupHarness(h);
      const originalStart = h.dispatcher.start.bind(h.dispatcher);
      let count = 0;
      let failedTask: DispatchTask | undefined;
      vi.spyOn(h.dispatcher, 'start').mockImplementation((task) => {
        count += 1;
        if (count === 2) {
          failedTask = task;
          throw new Error('sync start failure');
        }
        return originalStart(task);
      });

      const out = await runPanelHandler({
        reviewers: [
          { agent_id: 'reviewer', prompt: 'review 1' },
          {
            agent_id: 'reviewer',
            prompt: 'review 2',
            peer_messages: [{ body: 'this body truncates', kind: 'review' }],
          },
        ],
      }, h.ctx);

      expect(out.reviewers).toHaveLength(1);
      expect(out.failed_reviewers).toEqual([
        { agent_id: 'reviewer', error: 'sync start failure' },
      ]);
      expect(failedTask?.runId).toBeDefined();
      const failedState = h.runStateStore.read(failedTask!.runId!);
      expect(failedState?.status).toBe('error');
      expect(failedState?.prompts.at(-1)?.summary).toBe('sync start failure');
      expect(existsSync(join(h.crewHome, 'runs', failedTask!.runId!, 'worktree'))).toBe(false);
      const records = readPanelState(panelDir(h.crewHome, out.panel_id))?.reviewers ?? [];
      expect(records[1]).toMatchObject({
        dispatched: false,
        dispatchWarnings: [expect.stringContaining('peer_messages.body_truncated:')],
      });
    } finally {
      restore();
    }
  });

  it('records per-reviewer peer_messages preflight failure and continues', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'reviewer' })]);
    cleanupHarness(h);

    const out = await runPanelHandler({
      reviewers: [
        {
          agent_id: 'reviewer',
          prompt: 'bad',
          peer_messages: Array.from({ length: 51 }, (_, index) => ({
            body: `msg ${index}`,
            kind: 'review' as const,
          })),
        },
        { agent_id: 'reviewer', prompt: 'good' },
      ],
    }, h.ctx);

    expect(out.reviewers).toHaveLength(1);
    expect(out.failed_reviewers).toEqual([
      {
        agent_id: 'reviewer',
        error: expect.stringContaining('peer_messages.too_many:'),
      },
    ]);
  });

  it('leaves a crash-recovery panel observable after reviewer #2 record commits', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'reviewer' })]);
    cleanupHarness(h);
    let panelId = '';

    await expect(runPanelHandler({
      reviewers: [
        { agent_id: 'reviewer', prompt: 'review 1' },
        { agent_id: 'reviewer', prompt: 'review 2' },
        { agent_id: 'reviewer', prompt: 'review 3' },
      ],
    }, {
      ...h.ctx,
      onPanelStateWritten: (state) => {
        panelId = state.panelId;
        if (state.reviewers.length === 2) {
          throw new Error('simulated crash after record write');
        }
      },
    })).rejects.toThrow('simulated crash after record write');

    const status = getPanelStatusHandler({ panel_id: panelId }, h.ctx);
    expect(status.total_count).toBe(2);
    expect(status.reviewers).toHaveLength(2);
    expect(status.failed_reviewers).toEqual([]);
  });

  it('property: random panel sizes 1..20 surface every dispatched run_id in status', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'reviewer' })]);
    cleanupHarness(h);
    for (let size = 1; size <= 20; size += 1) {
      let count = 0;
      const ctx: RunPanelHandlerContext = {
        ...h.ctx,
        dispatchRunAgentInternalImpl: async (args) => {
          count += 1;
          return fakeDispatchResult(args.input.agent_id, count);
        },
      };
      const out = await runPanelHandler({
        reviewers: Array.from({ length: size }, (_, index) => ({
          agent_id: 'reviewer',
          prompt: `review ${index}`,
        })),
      }, ctx);
      const status = getPanelStatusHandler({ panel_id: out.panel_id }, h.ctx);
      expect(status.reviewers.map((reviewer) => reviewer.run_id).sort())
        .toEqual(out.reviewers.map((reviewer) => reviewer.run_id).sort());
    }
  });

  it('adapter prompt probe prepends implementer context byte-for-byte', async () => {
    let observedPrompt = '';
    const adapter = makeMockAdapter({
      name: 'reviewer',
      execute: async (task) => {
        observedPrompt = task.prompt;
        return { output: 'ok', filesModified: [], status: 'success', metadata: {} };
      },
    });
    const h = makeHarness([adapter]);
    cleanupHarness(h);
    const implementer = await createRunState(h, {
      runId: 'impl',
      agentId: 'implementer',
      summary: 'Implementation summary',
      filesChanged: ['src/impl.ts'],
    });
    const expectedMessage = buildImplementerPeerMessage(implementer);
    peerMessageInputSchema.parse(expectedMessage);

    const out = await runPanelHandler({
      implementer_run_id: 'impl',
      reviewers: [{ agent_id: 'reviewer', prompt: 'review now' }],
    }, h.ctx);

    await waitFor(() => observedPrompt.length > 0);
    const state = h.runStateStore.read(out.reviewers[0].run_id);
    const renderedMessages = state?.prompts[0].peer_messages_input ?? [];
    const rendered = renderedMessages[0];
    const expectedBlock = buildPrependBlock(renderedMessages, {
      aggregateCap: h.runStateStore.caps.aggregate,
      hardCeiling: h.runStateStore.caps.hardCeiling,
    }).rendered;
    expect(rendered).toMatchObject(expectedMessage);
    expect(observedPrompt).toBe(`${expectedBlock}review now`);
  });

  it('panel-dispatched reviewer reaches terminal through lifecycle listeners', async () => {
    const adapter = makeMockAdapter({
      name: 'reviewer',
      execute: async () => ({
        output: 'terminal review',
        filesModified: ['review.md'],
        status: 'partial',
        metadata: {},
      }),
    });
    const h = makeHarness([adapter]);
    cleanupHarness(h);

    const out = await runPanelHandler({
      reviewers: [{ agent_id: 'reviewer', prompt: 'review' }],
    }, h.ctx);

    await waitFor(() => h.runStateStore.read(out.reviewers[0].run_id)?.status === 'partial');
    const state = h.runStateStore.read(out.reviewers[0].run_id);
    expect(state?.prompts.at(-1)?.summary).toBe('terminal review');
    expect(state?.filesChanged).toEqual(['review.md']);
  });
});
