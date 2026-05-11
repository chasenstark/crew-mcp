import { describe, expect, it } from 'vitest';

import { runPeerMessagesPipeline, truncateInputs } from '../../../src/orchestrator/peer-messages/pipeline.js';
import type { PeerMessageInput } from '../../../src/orchestrator/peer-messages/schema.js';

const NOW = '2026-05-11T12:00:00.000Z';

describe('peer message cap pipeline', () => {
  it('truncates body and excerpts with records and warnings before rendering', () => {
    const input: PeerMessageInput[] = [{
      body: 'b'.repeat(50),
      kind: 'note',
      excerpts: [{ file: 'src/a.ts', range: [1, 2], text: 'e'.repeat(50) }],
    }];

    const out = truncateInputs(input, NOW, 3, { body: 40, excerpt: 40 });

    expect(out.messages[0]).toMatchObject({
      peer_messages_schema_version: 1,
      kind: 'note',
      rendered_at: NOW,
      rendered_in_turn: 3,
      body_truncated: { original_length: 50 },
      excerpt_truncations: [{ index: 0, original_length: 50 }],
    });
    expect(out.messages[0].body).toContain('[... truncated; original was 50 chars]');
    expect(out.messages[0].body).toHaveLength(40);
    expect(out.messages[0].excerpts?.[0].text).toContain('[... truncated; original was 50 chars]');
    expect(out.messages[0].excerpts?.[0].text).toHaveLength(40);
    expect(out.warnings).toEqual([
      'peer_messages.body_truncated: item[0] body was 50 chars, capped at 40',
      'peer_messages.excerpt_truncated: item[0].excerpts[0] text was 50 chars, capped at 40',
    ]);
  });

  it('runs truncation and aggregate rendering as one pure pipeline', () => {
    const input: PeerMessageInput[] = [
      { body: 'first', kind: 'note' },
      { body: 'second', kind: 'note' },
      { body: 'third', kind: 'note' },
    ];

    const firstOnly = runPeerMessagesPipeline([input[0]], {
      renderedAt: NOW,
      renderedInTurn: 4,
      caps: { body: 100, excerpt: 100, aggregate: 100_000, hardCeiling: 100_000 },
    });
    const out = runPeerMessagesPipeline(input, {
      renderedAt: NOW,
      renderedInTurn: 4,
      caps: {
        body: 100,
        excerpt: 100,
        aggregate: Buffer.byteLength(firstOnly.rendered, 'utf8'),
        hardCeiling: 100_000,
      },
    });

    expect(out.renderedMessages.map((message) => message.body)).toEqual(['first']);
    expect(out.warnings).toEqual([
      'peer_messages.aggregate_cap_reached: dropped 2 items after rendering 1 (aggregate 1KB)',
    ]);
  });
});
