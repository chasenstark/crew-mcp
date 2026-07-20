import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PANEL_SCHEMA_VERSION,
  type PanelStateV1,
} from '../../../src/orchestrator/panels/schema.js';
import {
  gcPanelStates,
  panelDir,
  readPanelState,
  snapshotPanelReviewerTerminal,
  writePanelStateAtomic,
} from '../../../src/orchestrator/panels/store.js';

function state(panelId = 'panel-1'): PanelStateV1 {
  return {
    schemaVersion: PANEL_SCHEMA_VERSION,
    panelId,
    createdAt: '2026-05-14T00:00:00.000Z',
    panelRepoRoot: '/repo',
    reviewers: [],
  };
}

describe('panel store', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'crew-panel-store-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('panelDir encodes panel ids under crewHome/panels', () => {
    expect(panelDir('/crew', 'panel/a b')).toBe(join('/crew', 'panels', 'panel%2Fa%20b'));
  });

  it('writePanelStateAtomic propagates ENOENT when parent is missing', () => {
    const dir = join(root, 'panel');
    expect(() => writePanelStateAtomic(dir, state())).toThrow(/ENOENT/);
    expect(existsSync(dir)).toBe(false);
  });

  it('writePanelStateAtomic writes and overwrites panel.json when the parent exists', () => {
    const dir = join(root, 'panel');
    mkdirSync(dir);
    writePanelStateAtomic(dir, state('panel-a'));
    writePanelStateAtomic(dir, state('panel-b'));
    expect(readPanelState(dir)?.panelId).toBe('panel-b');
    expect(
      readFileSync(join(dir, 'panel.json'), 'utf-8'),
    ).toContain('"panelId": "panel-b"');
    expect(readdirSync(dir)).toEqual(['panel.json']);
  });

  it('readPanelState returns undefined when panel.json is missing', () => {
    expect(readPanelState(join(root, 'missing'))).toBeUndefined();
  });

  it('readPanelState throws run_panel.unparsable on parse error', () => {
    const dir = join(root, 'panel');
    mkdirSync(dir);
    writeFileSync(join(dir, 'panel.json'), '{ bad json', 'utf-8');
    expect(() => readPanelState(dir)).toThrow(/^run_panel\.unparsable:/);
  });

  it('readPanelState throws run_panel.unknown_schema_version on v != 1', () => {
    const dir = join(root, 'panel');
    mkdirSync(dir);
    writeFileSync(join(dir, 'panel.json'), JSON.stringify({ ...state(), schemaVersion: 2 }), 'utf-8');
    expect(() => readPanelState(dir)).toThrow(/^run_panel\.unknown_schema_version:/);
  });

  it('snapshotPanelReviewerTerminal throws instead of silently dropping a missing reviewer', () => {
    const dir = join(root, 'panel');
    mkdirSync(dir);
    writePanelStateAtomic(dir, state());

    expect(() => snapshotPanelReviewerTerminal(dir, 'missing-run', {
      status: 'success',
      summary: 'done',
      filesChanged: [],
    })).toThrow(/^run_panel\.snapshot_missing_reviewer:/);
  });

  it('gcPanelStates deletes panels after the newest reviewer terminal snapshot TTL', () => {
    const crewHome = root;
    const oldDir = panelDir(crewHome, 'old-panel');
    const freshDir = panelDir(crewHome, 'fresh-panel');
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(freshDir, { recursive: true });
    writePanelStateAtomic(oldDir, {
      ...state('old-panel'),
      reviewers: [
        terminalReviewer('run-1', '2026-01-01T00:00:00.000Z'),
        terminalReviewer('run-2', '2026-01-02T00:00:00.000Z'),
      ],
    });
    writePanelStateAtomic(freshDir, {
      ...state('fresh-panel'),
      reviewers: [terminalReviewer('run-3', '2026-01-09T00:00:00.000Z')],
    });

    const deleted = gcPanelStates(
      crewHome,
      7 * 24 * 60 * 60 * 1000,
      Date.parse('2026-01-10T00:00:00.000Z'),
    );

    expect(deleted).toBe(1);
    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(freshDir)).toBe(true);
  });

  it('gcPanelStates falls back to createdAt for incomplete reviewer snapshots', () => {
    const crewHome = root;
    const dir = panelDir(crewHome, 'pending-panel');
    mkdirSync(dir, { recursive: true });
    writePanelStateAtomic(dir, {
      ...state('pending-panel'),
      createdAt: '2026-01-01T00:00:00.000Z',
      reviewers: [
        terminalReviewer('run-1', '2026-01-01T00:00:00.000Z'),
        {
          runId: null,
          agentId: 'reviewer-2',
          dispatched: false,
          pending: true,
          dispatchWarnings: [],
        },
      ],
    });

    const deleted = gcPanelStates(
      crewHome,
      7 * 24 * 60 * 60 * 1000,
      Date.parse('2026-01-10T00:00:00.000Z'),
    );

    expect(deleted).toBe(1);
    expect(existsSync(dir)).toBe(false);
  });

  it('gcPanelStates evicts parsed panel cache entries after deletion', () => {
    const crewHome = root;
    const dir = panelDir(crewHome, 'cached-panel');
    mkdirSync(dir, { recursive: true });
    writePanelStateAtomic(dir, {
      ...state('cached-panel'),
      reviewers: [terminalReviewer('run-1', '2026-01-01T00:00:00.000Z')],
    });
    expect(readPanelState(dir)?.panelId).toBe('cached-panel');

    expect(gcPanelStates(
      crewHome,
      7 * 24 * 60 * 60 * 1000,
      Date.parse('2026-01-10T00:00:00.000Z'),
    )).toBe(1);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'panel.json'), JSON.stringify(state('replacement-panel')), 'utf-8');

    expect(readPanelState(dir)?.panelId).toBe('replacement-panel');
  });
});

function terminalReviewer(runId: string, completedAt: string): PanelStateV1['reviewers'][number] {
  return {
    runId,
    agentId: `agent-${runId}`,
    dispatched: true,
    dispatchedAt: '2026-01-01T00:00:00.000Z',
    dispatchWarnings: [],
    terminalSnapshot: {
      status: 'success',
      summary: 'done',
      filesChanged: [],
      completedAt,
    },
  };
}
