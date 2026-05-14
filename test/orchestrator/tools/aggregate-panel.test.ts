import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  PANEL_SCHEMA_VERSION,
  type PanelReviewerRecord,
  type PanelStateV1,
} from '../../../src/orchestrator/panels/schema.js';
import {
  panelDir,
  writePanelStateAtomic,
} from '../../../src/orchestrator/panels/store.js';
import { peerMessageInputSchema } from '../../../src/orchestrator/peer-messages/schema.js';
import { aggregatePanelHandler } from '../../../src/orchestrator/tools/aggregate-panel.js';
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

function dispatched(runId: string, agentId = 'reviewer'): PanelReviewerRecord {
  return {
    runId,
    agentId,
    dispatched: true,
    dispatchedAt: '2026-05-14T00:00:01.000Z',
    dispatchWarnings: [],
  };
}

function failed(agentId: string, error: string): PanelReviewerRecord {
  return {
    runId: null,
    agentId,
    dispatched: false,
    error,
    dispatchWarnings: [],
  };
}

function panel(h: PanelHarness, reviewers: readonly PanelReviewerRecord[]): PanelStateV1 {
  return {
    schemaVersion: PANEL_SCHEMA_VERSION,
    panelId: `panel-${Math.random().toString(16).slice(2)}`,
    createdAt: '2026-05-14T00:00:00.000Z',
    panelRepoRoot: h.runStateStore.repoRoot,
    reviewers,
  };
}

describe('aggregatePanelHandler', () => {
  it('rejects run_panel.aggregate_not_ready when any reviewer is running', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'reviewer' })]);
    cleanupHarness(h);
    await createRunState(h, { runId: 'r-running', status: 'running' });
    const state = panel(h, [dispatched('r-running')]);
    writePanel(h, state);

    expect(() => aggregatePanelHandler({ panel_id: state.panelId }, h.ctx))
      .toThrow(/^run_panel\.aggregate_not_ready: 1 of 1 reviewers still running/);
  });

  it('happy path emits one sanitized peer_message per terminal reviewer', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'reviewer' })]);
    cleanupHarness(h);
    await createRunState(h, {
      runId: 'r1',
      agentId: 'co`dex#',
      status: 'success',
      summary: 'Looks correct',
      filesChanged: ['src/a.ts'],
    });
    await createRunState(h, {
      runId: 'r2',
      agentId: 'claude',
      status: 'error',
      summary: 'Review crashed after finding issue',
    });
    const state = panel(h, [dispatched('r1'), dispatched('r2')]);
    writePanel(h, state);

    const out = aggregatePanelHandler({ panel_id: state.panelId }, h.ctx);
    expect(out.peer_messages).toHaveLength(2);
    expect(out.peer_messages[0]).toMatchObject({
      body: 'Looks correct',
      kind: 'review',
      from_label: 'co_dex_ (review)',
      files: ['src/a.ts'],
    });
    expect(out.peer_messages[1]).toMatchObject({
      body: 'Review crashed after finding issue',
      from_label: 'claude (review, status=error)',
    });
    for (const message of out.peer_messages) {
      peerMessageInputSchema.parse(message);
    }
  });

  it('includes failed-dispatch reviewers with inline error messages', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'reviewer' })]);
    cleanupHarness(h);
    await createRunState(h, { runId: 'r1', status: 'success', summary: 'ok' });
    const state = panel(h, [
      dispatched('r1'),
      failed('bad#agent', 'agent unavailable'),
    ]);
    writePanel(h, state);

    const out = aggregatePanelHandler({ panel_id: state.panelId }, h.ctx);
    expect(out.peer_messages.map((message) => message.body)).toEqual([
      'ok',
      '(reviewer dispatch failed: agent unavailable)',
    ]);
    expect(out.peer_messages[1].from_label).toBe('bad_agent (dispatch failed)');
  });

  it('handles state_unavailable reviewers with synthetic messages', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'reviewer' })]);
    cleanupHarness(h);
    await createRunState(h, { runId: 'r-lost', status: 'success' });
    rmSync(join(h.crewHome, 'runs', 'r-lost', 'state.json'));
    const state = panel(h, [dispatched('r-lost', 'reviewer#lost')]);
    writePanel(h, state);

    const out = aggregatePanelHandler({ panel_id: state.panelId }, h.ctx);
    expect(out.peer_messages).toEqual([
      {
        body: '(reviewer state unavailable: missing state for run r-lost)',
        kind: 'review',
        from_label: 'reviewer_lost (state lost)',
      },
    ]);
  });

  it('emits all identical messages without de-duplication', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'reviewer' })]);
    cleanupHarness(h);
    await createRunState(h, { runId: 'r1', agentId: 'same', status: 'success', summary: 'same body' });
    await createRunState(h, { runId: 'r2', agentId: 'same', status: 'success', summary: 'same body' });
    const state = panel(h, [dispatched('r1'), dispatched('r2')]);
    writePanel(h, state);

    const out = aggregatePanelHandler({ panel_id: state.panelId }, h.ctx);
    expect(out.peer_messages).toHaveLength(2);
    expect(out.peer_messages[0]).toEqual(out.peer_messages[1]);
  });

  it('rejects run_panel.cross_repo for foreign panels', () => {
    const h = makeHarness([makeMockAdapter({ name: 'reviewer' })]);
    cleanupHarness(h);
    const state: PanelStateV1 = {
      schemaVersion: PANEL_SCHEMA_VERSION,
      panelId: 'foreign',
      createdAt: '2026-05-14T00:00:00.000Z',
      panelRepoRoot: '/other/repo',
      reviewers: [],
    };
    writePanel(h, state);

    expect(() => aggregatePanelHandler({ panel_id: 'foreign' }, h.ctx))
      .toThrow(/^run_panel\.cross_repo:/);
  });

  it('caps terminal reviewer files to 1000 and drops paths over 4096 chars', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'reviewer' })]);
    cleanupHarness(h);
    await createRunState(h, {
      runId: 'r-files',
      status: 'success',
      summary: 'files review',
      filesChanged: [
        ...Array.from({ length: 1200 }, (_, index) => `src/${index}.ts`),
        'x'.repeat(4097),
      ],
    });
    const state = panel(h, [dispatched('r-files')]);
    writePanel(h, state);

    const out = aggregatePanelHandler({ panel_id: state.panelId }, h.ctx);
    expect(out.peer_messages[0].files).toHaveLength(1000);
    expect(out.peer_messages[0].files?.at(-1)).toBe('src/999.ts');
    expect(out.peer_messages[0].files?.some((file) => file.length > 4096)).toBe(false);
    peerMessageInputSchema.parse(out.peer_messages[0]);
  });

  it('aggregate_panel output survives the continue_run peer_messages storage pipeline', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'reviewer' })]);
    cleanupHarness(h);
    await createRunState(h, {
      runId: 'impl',
      agentId: 'implementer',
      status: 'success',
      summary: 'implementation done',
    });
    await createRunState(h, {
      runId: 'review',
      agentId: 'reviewer#bad',
      status: 'success',
      summary: 'review summary',
    });
    const state = panel(h, [dispatched('review')]);
    writePanel(h, state);

    const aggregated = aggregatePanelHandler({ panel_id: state.panelId }, h.ctx);
    const appended = await h.runStateStore.appendPrompt('impl', {
      userPrompt: 'revise per panel',
      peerMessagesInput: aggregated.peer_messages,
    });

    expect(appended.renderedPeerMessages).toHaveLength(1);
    expect(appended.renderedPeerMessages[0].from_label).toBe('reviewer_bad (review)');
    expect(h.runStateStore.read('impl')?.prompts[1].peer_messages_input?.[0].from_label)
      .toBe('reviewer_bad (review)');
  });

  it('property: aggregate_panel is idempotent for a frozen panel', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'reviewer' })]);
    cleanupHarness(h);
    await createRunState(h, { runId: 'r1', status: 'success', summary: 'one' });
    await createRunState(h, { runId: 'r2', status: 'partial', summary: 'two' });
    const state = panel(h, [dispatched('r1'), dispatched('r2'), failed('missing', 'nope')]);
    writePanel(h, state);

    const first = aggregatePanelHandler({ panel_id: state.panelId }, h.ctx);
    const second = aggregatePanelHandler({ panel_id: state.panelId }, h.ctx);
    expect(JSON.stringify(first.peer_messages)).toBe(JSON.stringify(second.peer_messages));
  });
});
