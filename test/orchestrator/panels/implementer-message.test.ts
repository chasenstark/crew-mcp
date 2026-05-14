import { describe, expect, it } from 'vitest';

import { peerMessageInputSchema } from '../../../src/orchestrator/peer-messages/schema.js';
import type { RunStateV1 } from '../../../src/orchestrator/run-state.js';
import { buildImplementerPeerMessage } from '../../../src/orchestrator/panels/implementer-message.js';

function state(overrides: Partial<RunStateV1> = {}): RunStateV1 {
  return {
    schemaVersion: 1,
    runId: '12345678-1234-4234-8234-123456789abc',
    agentId: 'codex',
    status: 'success',
    startedAt: '2026-05-14T00:00:00.000Z',
    completedAt: '2026-05-14T00:01:00.000Z',
    worktreePath: '/repo/.crew/runs/impl/worktree',
    repoRoot: '/repo',
    prompts: [
      {
        turn: 1,
        prompt: 'do work',
        startedAt: '2026-05-14T00:00:00.000Z',
        completedAt: '2026-05-14T00:01:00.000Z',
        summary: 'Implemented feature',
      },
    ],
    filesChanged: ['src/a.ts'],
    ...overrides,
  };
}

describe('buildImplementerPeerMessage', () => {
  it('uses a terminal success summary and non-empty filesChanged', () => {
    const message = buildImplementerPeerMessage(state());
    expect(message).toMatchObject({
      body: 'Implemented feature',
      kind: 'review',
      from_label: 'codex (run 12345678)',
      files: ['src/a.ts'],
    });
    peerMessageInputSchema.parse(message);
  });

  it('uses fallback text when the summary is empty', () => {
    const message = buildImplementerPeerMessage(state({
      prompts: [{ ...state().prompts[0], summary: '   ' }],
    }));
    expect(message.body).toBe(
      '(no summary captured for implementer 12345678; status=success)',
    );
    peerMessageInputSchema.parse(message);
  });

  it('preserves terminal error summaries', () => {
    const message = buildImplementerPeerMessage(state({
      status: 'error',
      prompts: [{ ...state().prompts[0], summary: 'Failed after partial work' }],
    }));
    expect(message.body).toBe('Failed after partial work');
    peerMessageInputSchema.parse(message);
  });

  it('omits files when filesChanged is empty', () => {
    const message = buildImplementerPeerMessage(state({ filesChanged: [] }));
    expect(message).not.toHaveProperty('files');
    peerMessageInputSchema.parse(message);
  });

  it('sanitizes agentId in from_label', () => {
    const message = buildImplementerPeerMessage(state({ agentId: 'co`dex#bad' }));
    expect(message.from_label).toBe('co_dex_bad (run 12345678)');
    peerMessageInputSchema.parse(message);
  });

  it('slices filesChanged to 1000 items', () => {
    const filesChanged = Array.from({ length: 1200 }, (_, index) => `src/${index}.ts`);
    const message = buildImplementerPeerMessage(state({ filesChanged }));
    expect(message.files).toHaveLength(1000);
    expect(message.files?.at(-1)).toBe('src/999.ts');
    peerMessageInputSchema.parse(message);
  });

  it('drops filesChanged paths longer than 4096 chars', () => {
    const message = buildImplementerPeerMessage(state({
      filesChanged: ['src/ok.ts', `${'x'.repeat(4097)}.ts`],
    }));
    expect(message.files).toEqual(['src/ok.ts']);
    peerMessageInputSchema.parse(message);
  });

  it('always outputs a valid PeerMessageInput', () => {
    const message = buildImplementerPeerMessage(state({
      agentId: `bad${String.fromCharCode(0)}agent#`,
      filesChanged: [
        ...Array.from({ length: 1005 }, (_, index) => `src/${index}.ts`),
        'x'.repeat(5000),
      ],
    }));
    expect(() => peerMessageInputSchema.parse(message)).not.toThrow();
  });
});
