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
import { getPanelStatusHandler } from '../../../src/orchestrator/tools/get-panel-status.js';
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
