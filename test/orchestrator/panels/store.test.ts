import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PANEL_SCHEMA_VERSION,
  type PanelStateV1,
} from '../../../src/orchestrator/panels/schema.js';
import {
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
});
