import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  PANEL_SCHEMA_VERSION,
  type PanelStateV1,
} from '../../../src/orchestrator/panels/schema.js';
import {
  panelDir,
  readPanelState,
  writePanelStateAtomic,
} from '../../../src/orchestrator/panels/store.js';
import {
  getPanelStatusHandler,
  getPanelStatusToolHandler,
  PANEL_STATUS_SUMMARY_MAX_CHARS,
  PANEL_STATUS_TRUNCATION_MARKER,
  type GetPanelStatusOutput,
} from '../../../src/orchestrator/tools/get-panel-status.js';
import {
  createRunState,
  makeHarness,
  makeMockAdapter,
  type PanelHarness,
} from './panel-test-harness.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function cleanupHarness(h: PanelHarness): void {
  cleanups.push(h.cleanup);
}

function writePanel(h: PanelHarness, state: PanelStateV1): void {
  const dir = panelDir(h.crewHome, state.panelId);
  mkdirSync(dir, { recursive: true });
  writePanelStateAtomic(dir, state);
}

function panel(overrides: Partial<PanelStateV1> = {}): PanelStateV1 {
  return {
    schemaVersion: PANEL_SCHEMA_VERSION,
    panelId: 'panel-1',
    createdAt: '2026-05-14T00:00:00.000Z',
    panelRepoRoot: '/repo',
    reviewers: [],
    ...overrides,
  };
}

describe('getPanelStatusHandler', () => {
  it('reflects terminal_count and running_count across lifecycle', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'reviewer' })]);
    cleanupHarness(h);
    await createRunState(h, { runId: 'r-success', status: 'success', summary: 'done' });
    await createRunState(h, { runId: 'r-running', status: 'running' });
    writePanel(h, panel({
      panelRepoRoot: h.runStateStore.repoRoot,
      reviewers: [
        {
          runId: 'r-success',
          agentId: 'reviewer',
          dispatched: true,
          dispatchedAt: '2026-05-14T00:00:01.000Z',
          dispatchWarnings: [],
        },
        {
          runId: 'r-running',
          agentId: 'reviewer',
          dispatched: true,
          dispatchedAt: '2026-05-14T00:00:02.000Z',
          dispatchWarnings: [],
        },
        {
          runId: null,
          agentId: 'missing',
          dispatched: false,
          error: 'agent unavailable',
          dispatchWarnings: [],
        },
      ],
    }));

    const out = getPanelStatusHandler({ panel_id: 'panel-1' }, h.ctx);
    expect(out.partial).toBe(true);
    expect(out.total_count).toBe(2);
    expect(out.terminal_count).toBe(1);
    expect(out.running_count).toBe(1);
    expect(out.failed_reviewers).toEqual([
      { agent_id: 'missing', error: 'agent unavailable', dispatch_warnings: [] },
    ]);
    expect(out.reviewers[0]).toMatchObject({
      run_id: 'r-success',
      state_unavailable: false,
      status: 'success',
      summary: 'done',
      files_changed: [],
    });
    expect(out.reviewers[1]).toMatchObject({
      run_id: 'r-running',
      state_unavailable: false,
      status: 'running',
    });
  });

  it('returns a fresh check-in watcher for a running panel and omits it when terminal or context-free', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'reviewer' })]);
    cleanupHarness(h);
    await createRunState(h, { runId: 'r-watch-running', status: 'running' });
    await createRunState(h, { runId: 'r-watch-done', status: 'success', summary: 'done' });
    writePanel(h, panel({
      panelRepoRoot: h.runStateStore.repoRoot,
      reviewers: [
        {
          runId: 'r-watch-running',
          agentId: 'reviewer',
          dispatched: true,
          dispatchedAt: '2026-05-14T00:00:01.000Z',
          dispatchWarnings: [],
        },
        {
          runId: 'r-watch-done',
          agentId: 'reviewer',
          dispatched: true,
          dispatchedAt: '2026-05-14T00:00:02.000Z',
          dispatchWarnings: [],
        },
      ],
    }));

    const watcherCtx = {
      ...h.ctx,
      clientKind: 'codex' as const,
      crewWaitCommand: 'crew-wait --codex-queue-thread thread-1',
      checkInIntervalMs: 600_000,
    };
    const out = getPanelStatusHandler({ panel_id: 'panel-1' }, watcherCtx);
    expect(out.running_count).toBe(1);
    expect(out.required_next_action).toMatchObject({
      type: 'spawn_watcher',
      mechanism: 'codex_queue',
      run_ids: ['r-watch-running', 'r-watch-done'],
      run_generations: [1, 1],
      check_in_interval_ms: 600_000,
      per_run: false,
    });
    expect(out.required_next_action?.command)
      .toContain(' --check-in-ms 600000 --check-in-action-id ');
    expect(out.required_next_action?.spawn_recipe_json).toBeDefined();

    // Without watcher context the payload stays action-free.
    expect(getPanelStatusHandler({ panel_id: 'panel-1' }, h.ctx).required_next_action)
      .toBeUndefined();

    // A fully terminal panel needs no re-arm.
    await h.runStateStore.markTerminal('r-watch-running', {
      status: 'success',
      summary: 'done late',
      filesChanged: [],
    });
    const terminalOut = getPanelStatusHandler({ panel_id: 'panel-1' }, watcherCtx);
    expect(terminalOut.running_count).toBe(0);
    expect(terminalOut.required_next_action).toBeUndefined();
  });

  it('omits the re-arm watcher when a reviewer state is unreadable without a snapshot', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'reviewer' })]);
    cleanupHarness(h);
    await createRunState(h, { runId: 'r-still-running', status: 'running' });
    writePanel(h, panel({
      panelRepoRoot: h.runStateStore.repoRoot,
      reviewers: [
        {
          runId: 'r-still-running',
          agentId: 'reviewer',
          dispatched: true,
          dispatchedAt: '2026-05-14T00:00:01.000Z',
          dispatchWarnings: [],
        },
        {
          runId: 'r-state-gone',
          agentId: 'reviewer',
          dispatched: true,
          dispatchedAt: '2026-05-14T00:00:02.000Z',
          dispatchWarnings: [],
        },
      ],
    }));

    const out = getPanelStatusHandler({ panel_id: 'panel-1' }, {
      ...h.ctx,
      clientKind: 'codex' as const,
      crewWaitCommand: 'crew-wait --codex-queue-thread thread-1',
      checkInIntervalMs: 600_000,
    });
    expect(out.running_count).toBe(1);
    // Generations feed the durable wake claim, so an unreadable reviewer
    // disqualifies the re-arm rather than risking a stale claim.
    expect(out.required_next_action).toBeUndefined();
  });

  it('reports distinct same-provider models and preserves a failed requested model', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'claude-code' })]);
    cleanupHarness(h);
    await Promise.all([
      createRunState(h, { runId: 'r-opus', agentId: 'claude-code', status: 'success' }),
      createRunState(h, { runId: 'r-fable', agentId: 'claude-code', status: 'running' }),
      createRunState(h, { runId: 'r-sonnet', agentId: 'claude-code', status: 'success' }),
    ]);
    writePanel(h, panel({
      panelRepoRoot: h.runStateStore.repoRoot,
      reviewers: [
        {
          runId: 'r-opus',
          agentId: 'claude-code',
          dispatched: true,
          dispatchedAt: '2026-08-20T00:00:01.000Z',
          dispatchWarnings: [],
          modelSelection: {
            source: 'per_call',
            requestedModel: 'opus',
            modelArgument: 'opus',
            displayName: 'Claude Opus',
            validation: 'syntax',
          },
        },
        {
          runId: 'r-fable',
          agentId: 'claude-code',
          dispatched: true,
          dispatchedAt: '2026-08-20T00:00:02.000Z',
          dispatchWarnings: [],
          modelSelection: {
            source: 'per_call',
            requestedModel: 'fable',
            modelArgument: 'fable',
            displayName: 'Claude Fable',
            validation: 'syntax',
          },
        },
        {
          runId: 'r-sonnet',
          agentId: 'claude-code',
          dispatched: true,
          dispatchedAt: '2026-08-20T00:00:03.000Z',
          dispatchWarnings: [],
          modelSelection: {
            source: 'per_call',
            requestedModel: 'sonnet',
            modelArgument: 'sonnet',
            displayName: 'Claude Sonnet',
            validation: 'syntax',
          },
        },
        {
          runId: null,
          agentId: 'claude-code',
          dispatched: false,
          error: 'model_not_found: unknown model',
          dispatchWarnings: [],
          requestedModel: 'not-a-claude-model',
        },
      ],
    }));

    const result = getPanelStatusToolHandler({ panel_id: 'panel-1' }, h.ctx);
    const structured = result.structuredContent as unknown as GetPanelStatusOutput;
    expect(structured.reviewers.map((reviewer) => reviewer.model_selection?.model_argument))
      .toEqual(['opus', 'fable', 'sonnet']);
    expect(structured.failed_reviewers[0]?.requested_model).toBe('not-a-claude-model');

    const markdown = result.content[0].text;
    expect(markdown).toContain('`claude-code`: model=Claude Opus status=`success`');
    expect(markdown).toContain('`claude-code`: model=Claude Fable status=`running`');
    expect(markdown).toContain('`claude-code`: model=Claude Sonnet status=`success`');
    expect(markdown).toContain(
      '`claude-code`: model=not-a-claude-model status=`dispatch_failed`',
    );
  });

  it('renders compact reviewer summaries while preserving the full structured payload', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'reviewer' })]);
    cleanupHarness(h);
    const longSummary = `${'review finding '.repeat(100)}FULL_SUMMARY_TAIL`;
    await createRunState(h, {
      runId: 'r-long-summary',
      agentId: 'reviewer',
      status: 'success',
      summary: longSummary,
      filesChanged: ['src/a.ts', 'src/b.ts'],
    });
    writePanel(h, panel({
      panelRepoRoot: h.runStateStore.repoRoot,
      reviewers: [
        {
          runId: 'r-long-summary',
          agentId: 'reviewer',
          dispatched: true,
          dispatchedAt: '2026-05-14T00:00:01.000Z',
          dispatchWarnings: [],
        },
        {
          runId: null,
          agentId: 'unavailable',
          dispatched: false,
          error: 'agent unavailable',
          dispatchWarnings: [],
        },
      ],
    }));

    const result = getPanelStatusToolHandler({ panel_id: 'panel-1' }, h.ctx);
    const text = result.content[0].text;
    const structured = result.structuredContent as unknown as GetPanelStatusOutput;

    expect(text).toContain(
      'Panel `panel-1`: total=1 terminal=1 running=0 failed_reviewers=1.',
    );
    expect(text).toContain('- `reviewer`: status=`success` files_changed=2 summary=');
    expect(text).toContain(PANEL_STATUS_TRUNCATION_MARKER);
    expect(text).toContain(
      '- `unavailable`: status=`dispatch_failed` files_changed=0 summary=agent unavailable',
    );
    expect(text).not.toContain('FULL_SUMMARY_TAIL');
    const renderedSummary = text.split(' summary=')[1]?.split('\n')[0] ?? '';
    expect(Array.from(renderedSummary)).toHaveLength(PANEL_STATUS_SUMMARY_MAX_CHARS);

    expect(structured).toMatchObject({
      panel_id: 'panel-1',
      total_count: 1,
      terminal_count: 1,
      running_count: 0,
      failed_reviewers: [
        { agent_id: 'unavailable', error: 'agent unavailable', dispatch_warnings: [] },
      ],
    });
    expect(structured.reviewers[0]).toMatchObject({
      agent_id: 'reviewer',
      status: 'success',
      summary: longSummary,
      files_changed: ['src/a.ts', 'src/b.ts'],
    });
  });

  it('returns state_unavailable for manual state deletion but not discarded runs', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'reviewer' })]);
    cleanupHarness(h);
    await createRunState(h, { runId: 'r-deleted', status: 'success' });
    await createRunState(h, { runId: 'r-discarded', status: 'discarded' });
    rmSync(join(h.crewHome, 'runs', 'r-deleted', 'state.json'));
    writePanel(h, panel({
      panelRepoRoot: h.runStateStore.repoRoot,
      reviewers: [
        {
          runId: 'r-deleted',
          agentId: 'reviewer',
          dispatched: true,
          dispatchedAt: '2026-05-14T00:00:01.000Z',
          dispatchWarnings: [],
        },
        {
          runId: 'r-discarded',
          agentId: 'reviewer',
          dispatched: true,
          dispatchedAt: '2026-05-14T00:00:02.000Z',
          dispatchWarnings: [],
        },
      ],
    }));

    const out = getPanelStatusHandler({ panel_id: 'panel-1' }, h.ctx);
    expect(out.reviewers[0]).toMatchObject({
      state_unavailable: true,
      state_unavailable_reason: expect.stringContaining('missing state'),
    });
    expect(out.reviewers[1]).toMatchObject({
      state_unavailable: false,
      status: 'discarded',
    });
  });

  it('falls back to panel terminalSnapshot when reviewer state is missing', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'reviewer' })]);
    cleanupHarness(h);
    await createRunState(h, { runId: 'r-snap', status: 'success' });
    rmSync(join(h.crewHome, 'runs', 'r-snap', 'state.json'));
    writePanel(h, panel({
      panelRepoRoot: h.runStateStore.repoRoot,
      reviewers: [
        {
          runId: 'r-snap',
          agentId: 'reviewer',
          dispatched: true,
          dispatchedAt: '2026-05-14T00:00:01.000Z',
          dispatchWarnings: [],
          terminalSnapshot: {
            status: 'success',
            summary: 'durable summary',
            filesChanged: ['review.md'],
            completedAt: '2026-05-14T00:00:02.000Z',
            goal: {
              policy: 'not_requested',
              outcome: 'not_requested',
              authoritative: true,
              turnsUsed: 0,
              wallClockMsUsed: 0,
            },
          },
        },
      ],
    }));

    const out = getPanelStatusHandler({ panel_id: 'panel-1' }, h.ctx);
    expect(out.terminal_count).toBe(1);
    expect(out.reviewers[0]).toMatchObject({
      run_id: 'r-snap',
      state_unavailable: false,
      status: 'success',
      summary: 'durable summary',
      files_changed: ['review.md'],
      completedAt: '2026-05-14T00:00:02.000Z',
      goal: {
        policy: 'not_requested',
        outcome: 'not_requested',
        authoritative: true,
        turns_used: 0,
        wall_clock_ms_used: 0,
      },
    });
  });

  it('round-trips terminal snapshot failure through strict panel state and status', () => {
    const h = makeHarness([makeMockAdapter({ name: 'reviewer' })]);
    cleanupHarness(h);
    const failure = {
      kind: 'quota_exhausted',
      confidence: 'high',
      providerCode: 'codex',
      retryAfterSeconds: 60,
      resetAt: '2026-05-14T00:05:00.000Z',
      rawSignal: 'quota exceeded',
      recommendation: 'reroute',
    } as const;
    writePanel(h, panel({
      panelRepoRoot: h.runStateStore.repoRoot,
      reviewers: [
        {
          runId: 'r-quota',
          agentId: 'reviewer',
          dispatched: true,
          dispatchedAt: '2026-05-14T00:00:01.000Z',
          dispatchWarnings: [],
          terminalSnapshot: {
            status: 'error',
            summary: 'quota stopped',
            filesChanged: ['review.md'],
            completedAt: '2026-05-14T00:00:02.000Z',
            failure,
          },
        },
      ],
    }));

    const restored = readPanelState(panelDir(h.crewHome, 'panel-1'));
    expect(restored?.reviewers[0]).toMatchObject({
      dispatched: true,
      terminalSnapshot: { failure },
    });

    const out = getPanelStatusHandler({ panel_id: 'panel-1' }, h.ctx);
    expect(out.reviewers[0]).toMatchObject({
      run_id: 'r-quota',
      state_unavailable: false,
      status: 'error',
      failure,
    });
  });

  it('preserves dispatch_warnings from panel.json per reviewer', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'reviewer' })]);
    cleanupHarness(h);
    await createRunState(h, { runId: 'r-warning', status: 'success' });
    writePanel(h, panel({
      panelRepoRoot: h.runStateStore.repoRoot,
      reviewers: [
        {
          runId: 'r-warning',
          agentId: 'reviewer',
          dispatched: true,
          dispatchedAt: '2026-05-14T00:00:01.000Z',
          dispatchWarnings: ['peer_messages.body_truncated: item[0]'],
        },
      ],
    }));

    const out = getPanelStatusHandler({ panel_id: 'panel-1' }, h.ctx);
    expect(out.reviewers[0].dispatch_warnings).toEqual([
      'peer_messages.body_truncated: item[0]',
    ]);
  });

  it('preserves dispatch_warnings from panel.json for failed reviewers', () => {
    const h = makeHarness([makeMockAdapter({ name: 'reviewer' })]);
    cleanupHarness(h);
    writePanel(h, panel({
      panelRepoRoot: h.runStateStore.repoRoot,
      reviewers: [
        {
          runId: null,
          agentId: 'reviewer',
          dispatched: false,
          error: 'dispatcher.start failed',
          dispatchWarnings: ['peer_messages.body_truncated: item[0]'],
        },
      ],
    }));

    const out = getPanelStatusHandler({ panel_id: 'panel-1' }, h.ctx);
    expect(out.failed_reviewers[0]?.dispatch_warnings).toEqual([
      'peer_messages.body_truncated: item[0]',
    ]);
  });

  it('throws run_panel.unknown for a missing panel', () => {
    const h = makeHarness([makeMockAdapter({ name: 'reviewer' })]);
    cleanupHarness(h);
    expect(() => getPanelStatusHandler({ panel_id: 'missing' }, h.ctx))
      .toThrow(/^run_panel\.unknown:/);
  });

  it('throws run_panel.unparsable for corrupted panel.json', () => {
    const h = makeHarness([makeMockAdapter({ name: 'reviewer' })]);
    cleanupHarness(h);
    const dir = panelDir(h.crewHome, 'panel-bad');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'panel.json'), '{ bad json', 'utf-8');
    expect(() => getPanelStatusHandler({ panel_id: 'panel-bad' }, h.ctx))
      .toThrow(/^run_panel\.unparsable:/);
  });

  it('throws run_panel.unknown_schema_version for v != 1', () => {
    const h = makeHarness([makeMockAdapter({ name: 'reviewer' })]);
    cleanupHarness(h);
    const dir = panelDir(h.crewHome, 'panel-v2');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'panel.json'), JSON.stringify({
      ...panel({ panelId: 'panel-v2', panelRepoRoot: h.runStateStore.repoRoot }),
      schemaVersion: 2,
    }), 'utf-8');
    expect(() => getPanelStatusHandler({ panel_id: 'panel-v2' }, h.ctx))
      .toThrow(/^run_panel\.unknown_schema_version:/);
  });

  it('throws run_panel.cross_repo for foreign-repo panel', () => {
    const h = makeHarness([makeMockAdapter({ name: 'reviewer' })]);
    cleanupHarness(h);
    writePanel(h, panel({ panelRepoRoot: '/other/repo' }));
    expect(() => getPanelStatusHandler({ panel_id: 'panel-1' }, h.ctx))
      .toThrow(/^run_panel\.cross_repo:/);
  });
});
