import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Preference-fill reads the EFFECTIVE config, which merges the global
// ~/.crew/workflow.yaml (resolved via os.homedir()). Mock homedir to an
// isolated empty dir so the developer's real global agentDefaults can't
// leak into the preference-fill assertions.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

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
import { confirmCriteriaHandler } from '../../../src/orchestrator/tools/confirm-criteria.js';
import { createCriteriaHandler } from '../../../src/orchestrator/tools/create-criteria.js';
import { criteriaDir, readCriteriaState } from '../../../src/orchestrator/criteria/store.js';
import { setConfigValue } from '../../../src/workflow/config-service.js';
import { getPanelStatusHandler } from '../../../src/orchestrator/tools/get-panel-status.js';
import {
  createDeferred,
  createRunState,
  makeHarness,
  makeMockAdapter,
  type PanelHarness,
  waitFor,
} from './panel-test-harness.js';
import { getDefaultConfig } from '../../../src/workflow/config-codec.js';

const cleanups: Array<() => void> = [];
const mockedHomedir = vi.mocked(homedir);
let isolatedHome: string;

beforeEach(() => {
  isolatedHome = mkdtempSync(join(tmpdir(), 'crew-run-panel-home-'));
  mockedHomedir.mockReturnValue(isolatedHome);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(isolatedHome, { recursive: true, force: true });
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

async function createConfirmedCriteria(h: PanelHarness, id = 'criteria-1'): Promise<void> {
  createCriteriaHandler({
    criteria: [
      {
        title: 'Tests green',
        type: 'mechanical',
        detail: 'npm run test:run exits 0',
        signal: 'test output',
      },
      {
        title: 'Review contract enforced',
        type: 'behavioral',
        subCriteria: ['reviewers receive the contract'],
      },
      {
        title: 'No regressions',
        type: 'negative',
        detail: 'panel without criteria stays unchanged',
      },
    ],
  }, {
    crewHome: h.crewHome,
    repoRoot: h.runStateStore.repoRoot,
    makeCriteriaSetId: () => id,
  });
  await confirmCriteriaHandler({ criteria_set_id: id }, { crewHome: h.crewHome });
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
  it('fills empty reviewers from panel agent defaults', async () => {
    const h = makeHarness([
      makeMockAdapter({ name: 'codex' }),
      makeMockAdapter({ name: 'claude-code' }),
    ]);
    cleanupHarness(h);
    setConfigValue(h.root, 'workflow.agentDefaults.panel.reviewers', '["codex","claude-code"]');
    const dispatched: string[] = [];

    const out = await runPanelHandler({
      reviewers: [],
    }, {
      ...h.ctx,
      dispatchRunAgentInternalImpl: async (args) => {
        dispatched.push(args.input.agent_id);
        return fakeDispatchResult(args.input.agent_id, dispatched.length);
      },
    });

    expect(out.reviewers.map((reviewer) => reviewer.agent_id)).toEqual(['codex', 'claude-code']);
    expect(dispatched).toEqual(['codex', 'claude-code']);
  });

  it('adds one required_next_action per reviewer run for Claude Code panels', async () => {
    const h = makeHarness([
      makeMockAdapter({ name: 'codex' }),
      makeMockAdapter({ name: 'gemini-cli' }),
    ]);
    cleanupHarness(h);
    let dispatched = 0;

    const out = await runPanelHandler({
      reviewers: [
        { agent_id: 'codex', prompt: 'review a' },
        { agent_id: 'gemini-cli', prompt: 'review b' },
      ],
    }, {
      ...h.ctx,
      clientKind: 'claude-code',
      crewWaitCommand: '/usr/local/bin/crew-wait',
      dispatchRunAgentInternalImpl: async (args) => {
        dispatched += 1;
        return fakeDispatchResult(args.input.agent_id, dispatched);
      },
    });

    expect(out.reviewers).toHaveLength(2);
    expect(out.reviewers.map((reviewer) => reviewer.required_next_action)).toEqual([
      {
        type: 'spawn_watcher',
        mechanism: 'background_shell',
        command: '/usr/local/bin/crew-wait codex-run-1',
        run_id: 'codex-run-1',
        run_in_background: true,
        per_run: true,
        consequence_if_skipped:
          'Skip it and the run is orphaned; no watcher-triggered terminal turn will surface completion.',
      },
      {
        type: 'spawn_watcher',
        mechanism: 'background_shell',
        command: '/usr/local/bin/crew-wait gemini-cli-run-2',
        run_id: 'gemini-cli-run-2',
        run_in_background: true,
        per_run: true,
        consequence_if_skipped:
          'Skip it and the run is orphaned; no watcher-triggered terminal turn will surface completion.',
      },
    ]);
  });

  it('injects a passed criteria contract into reviewer runs without relinking implementerRunId', async () => {
    let capturedPrompt = '';
    const h = makeHarness([makeMockAdapter({
      name: 'reviewer',
      execute: async (task) => {
        capturedPrompt = task.prompt;
        return {
          output: 'review done',
          filesModified: [],
          status: 'success',
          metadata: {},
        };
      },
    })]);
    cleanupHarness(h);
    await createConfirmedCriteria(h);
    await createRunState(h, {
      runId: 'impl',
      agentId: 'implementer',
      status: 'success',
      summary: 'implementation summary',
      filesChanged: ['src/a.ts'],
    });
    await h.runStateStore.update('impl', (state) => ({
      ...state,
      criteriaSetId: 'criteria-1',
      criteriaEpoch: 0,
    }));

    const out = await runPanelHandler({
      implementer_run_id: 'impl',
      criteria_set_id: 'criteria-1',
      reviewers: [
        {
          agent_id: 'reviewer',
          prompt: 'review',
        },
      ],
    }, h.ctx);

    expect(out.reviewers).toHaveLength(1);
    await waitFor(() => capturedPrompt.length > 0);
    expect(capturedPrompt.startsWith('Acceptance Criteria Contract\ncriteria_set_id: criteria-1')).toBe(true);
    expect(capturedPrompt.indexOf('Acceptance Criteria Contract')).toBeLessThan(
      capturedPrompt.indexOf('## Peer messages'),
    );
    const reviewerState = h.runStateStore.read(out.reviewers[0].run_id);
    expect(reviewerState?.criteriaSetId).toBe('criteria-1');
    expect(reviewerState?.prompts[0].criteriaContract).toContain('criteria_set_id: criteria-1');
    expect(readCriteriaState(criteriaDir(h.crewHome, 'criteria-1'))?.implementerRunId)
      .toBeUndefined();
  });

  it('rejects criteria linkage mismatch against the implementer run', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'reviewer' })]);
    cleanupHarness(h);
    await createConfirmedCriteria(h, 'criteria-1');
    await createRunState(h, {
      runId: 'impl',
      status: 'success',
    });
    await h.runStateStore.update('impl', (state) => ({
      ...state,
      criteriaSetId: 'other-criteria',
      criteriaEpoch: 0,
    }));

    await expect(runPanelHandler({
      implementer_run_id: 'impl',
      criteria_set_id: 'criteria-1',
      reviewers: [{ agent_id: 'reviewer', prompt: 'review' }],
    }, h.ctx)).rejects.toThrow(/^criteria\.linkage_mismatch:/);
  });

  it('rejects empty preference-filled reviewers after banList filtering', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'codex' })]);
    cleanupHarness(h);

    await expect(runPanelHandler({
      reviewers: [],
    }, {
      ...h.ctx,
      loadConfig: () => {
        const config = getDefaultConfig();
        config.workflow.agentDefaults = {
          panel: {
            reviewers: ['codex'],
            banList: ['codex'],
          },
        };
        return config;
      },
    })).rejects.toThrow(/^run_panel\.no_reviewers:/);
  });

  it('lets explicit reviewers override preferences and banList', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'codex' })]);
    cleanupHarness(h);
    setConfigValue(h.root, 'workflow.agentDefaults.panel.reviewers', '["codex"]');
    setConfigValue(h.root, 'workflow.agentDefaults.panel.banList', '["explicit-reviewer"]');
    const dispatched: Array<{ agent_id: string; prompt: string }> = [];

    const out = await runPanelHandler({
      reviewers: [{ agent_id: 'explicit-reviewer', prompt: 'review explicitly' }],
    }, {
      ...h.ctx,
      dispatchRunAgentInternalImpl: async (args) => {
        dispatched.push({
          agent_id: args.input.agent_id,
          prompt: args.input.prompt,
        });
        return fakeDispatchResult(args.input.agent_id, dispatched.length);
      },
    });

    expect(out.reviewers.map((reviewer) => reviewer.agent_id)).toEqual(['explicit-reviewer']);
    expect(dispatched).toEqual([{ agent_id: 'explicit-reviewer', prompt: 'review explicitly' }]);
  });

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
    expect(writeSizes.slice(0, 2)).toEqual([0, 2]);
    expect(writeSizes.every((size) => size === 0 || size === 2)).toBe(true);

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

  it('writes ordered pending reviewer records before starting panel dispatches', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'reviewer' })]);
    cleanupHarness(h);
    let panelId = '';
    const snapshots: string[][] = [];

    const out = await runPanelHandler({
      reviewers: [
        { agent_id: 'reviewer', prompt: 'review 1' },
        { agent_id: 'missing', prompt: 'review 2' },
        { agent_id: 'reviewer', prompt: 'review 3' },
      ],
    }, {
      ...h.ctx,
      onPanelStateWritten: (state) => {
        panelId = state.panelId;
        snapshots.push(state.reviewers.map((reviewer) => {
          if (reviewer.dispatched) return `run:${reviewer.runId}`;
          if ('pending' in reviewer && reviewer.pending) return `pending:${reviewer.agentId}`;
          return `failed:${reviewer.agentId}`;
        }));
      },
    });

    expect(out.reviewers).toHaveLength(2);
    expect(out.failed_reviewers).toHaveLength(1);
    expect(snapshots[1]).toEqual([
      'pending:reviewer',
      'pending:missing',
      'pending:reviewer',
    ]);
    const state = readPanelState(panelDir(h.crewHome, panelId));
    expect(state?.reviewers.map((reviewer) => reviewer.agentId)).toEqual([
      'reviewer',
      'missing',
      'reviewer',
    ]);
    for (const reviewer of out.reviewers) {
      expect(state?.reviewers.some((record) =>
        record.dispatched && record.runId === reviewer.run_id)).toBe(true);
    }
  });

  it('keeps started reviewer records durable when a later setup write crashes', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'reviewer' })]);
    cleanupHarness(h);
    let panelId = '';
    const firstStarted = createDeferred<void>();

    await expect(runPanelHandler({
      reviewers: [
        { agent_id: 'reviewer', prompt: 'review 1' },
        { agent_id: 'reviewer', prompt: 'review 2' },
      ],
    }, {
      ...h.ctx,
      dispatchRunAgentInternalImpl: async (args) => {
        if (args.input.prompt === 'review 1') {
          await args.onStart?.({
            agentName: args.input.agent_id,
            runId: 'reviewer-run-1',
            worktreePath: '/tmp/reviewer-run-1',
          });
          firstStarted.resolve();
          return fakeDispatchResult(args.input.agent_id, 1);
        }
        await firstStarted.promise;
        throw new DispatchError('simulated later setup failure');
      },
      onPanelStateWritten: (state) => {
        panelId = state.panelId;
        if (state.reviewers.some((reviewer) =>
          !reviewer.dispatched && !('pending' in reviewer && reviewer.pending))) {
          throw new Error('simulated crash after later setup failure');
        }
      },
    })).rejects.toThrow('simulated crash after later setup failure');

    const state = readPanelState(panelDir(h.crewHome, panelId));
    expect(state?.reviewers).toHaveLength(2);
    expect(state?.reviewers[0]).toMatchObject({
      agentId: 'reviewer',
      dispatched: true,
    });
    expect(state?.reviewers[1]).toMatchObject({
      agentId: 'reviewer',
      dispatched: false,
      error: 'simulated later setup failure',
    });
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
        if (state.reviewers.filter((reviewer) => reviewer.dispatched).length === 2) {
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
  }, 10_000);

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
      let failedTask: DispatchTask | undefined;
      vi.spyOn(h.dispatcher, 'start').mockImplementation((task) => {
        if (task.input?.prompt === 'review 2') {
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
    let twoDispatchedWrites = 0;

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
        if (state.reviewers.filter((reviewer) => reviewer.dispatched).length === 2) {
          twoDispatchedWrites += 1;
          if (twoDispatchedWrites === 2) {
            throw new Error('simulated crash after record write');
          }
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

  it('panel-dispatched reviewer reaches terminal through lifecycle listeners without dropping its snapshot', async () => {
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
    const panelState = readPanelState(panelDir(h.crewHome, out.panel_id));
    expect(panelState?.reviewers[0]).toMatchObject({
      dispatched: true,
      terminalSnapshot: {
        status: 'partial',
        summary: 'terminal review',
        filesChanged: ['review.md'],
      },
    });
  });

  it('sets up reviewer dispatches concurrently while preserving output order', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'reviewer' })]);
    cleanupHarness(h);
    const releaseFirst = createDeferred<void>();
    const started: string[] = [];

    const outPromise = runPanelHandler({
      reviewers: [
        { agent_id: 'reviewer', prompt: 'slow' },
        { agent_id: 'reviewer', prompt: 'fast' },
      ],
    }, {
      ...h.ctx,
      dispatchRunAgentInternalImpl: async (args) => {
        started.push(args.input.prompt);
        if (args.input.prompt === 'slow') {
          await releaseFirst.promise;
          return fakeDispatchResult(args.input.agent_id, 1);
        }
        return fakeDispatchResult(args.input.agent_id, 2);
      },
    });

    await waitFor(() => started.length === 2);
    expect(started).toEqual(['slow', 'fast']);
    releaseFirst.resolve();
    const out = await outPromise;
    expect(out.reviewers.map((reviewer) => reviewer.run_id)).toEqual([
      'reviewer-run-1',
      'reviewer-run-2',
    ]);
  });
});
