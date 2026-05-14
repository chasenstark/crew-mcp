import { describe, expect, it } from 'vitest';

import {
  PANEL_SCHEMA_VERSION,
  panelStateSchemaV1,
  type PanelStateV1,
} from '../../../src/orchestrator/panels/schema.js';

function baseState(overrides: Partial<PanelStateV1> = {}): PanelStateV1 {
  return {
    schemaVersion: PANEL_SCHEMA_VERSION,
    panelId: 'panel-1',
    createdAt: '2026-05-14T00:00:00.000Z',
    panelRepoRoot: '/repo',
    reviewers: [],
    ...overrides,
  };
}

describe('panelStateSchemaV1', () => {
  it('validates an unbound panel with no reviewers', () => {
    expect(panelStateSchemaV1.parse(baseState())).toEqual(baseState());
  });

  it('validates a bound panel with dispatched and failed reviewers', () => {
    const state = baseState({
      implementerRunId: 'impl-run',
      implementerWorktreePath: '/repo/.crew/runs/impl/worktree',
      implementerSummarySnapshot: 'implemented x',
      implementerRepoRoot: '/repo',
      reviewers: [
        {
          runId: 'review-1',
          agentId: 'codex',
          dispatched: true,
          dispatchedAt: '2026-05-14T00:01:00.000Z',
          dispatchWarnings: ['peer_messages.body_truncated: item[0]'],
        },
        {
          runId: null,
          agentId: 'claude-code',
          dispatched: false,
          error: 'agent unavailable',
          dispatchWarnings: [],
        },
      ],
    });

    expect(panelStateSchemaV1.parse(state)).toEqual(state);
  });

  it('rejects a dispatched reviewer without runId and dispatchedAt', () => {
    expect(() => panelStateSchemaV1.parse(baseState({
      reviewers: [
        {
          runId: null,
          agentId: 'codex',
          dispatched: true,
          dispatchWarnings: [],
        } as unknown as PanelStateV1['reviewers'][number],
      ],
    }))).toThrow();
  });

  it('rejects a failed reviewer without error', () => {
    expect(() => panelStateSchemaV1.parse(baseState({
      reviewers: [
        {
          runId: null,
          agentId: 'codex',
          dispatched: false,
          dispatchWarnings: [],
        } as unknown as PanelStateV1['reviewers'][number],
      ],
    }))).toThrow();
  });

  it('rejects missing panelRepoRoot', () => {
    const { panelRepoRoot: _panelRepoRoot, ...withoutRepo } = baseState();
    expect(() => panelStateSchemaV1.parse(withoutRepo)).toThrow();
  });

  it('rejects unknown schemaVersion', () => {
    expect(() => panelStateSchemaV1.parse({
      ...baseState(),
      schemaVersion: 2,
    })).toThrow();
  });
});
