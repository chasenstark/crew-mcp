import { describe, expect, it } from 'vitest';

import { validatePeerMessagesPreflight } from '../../../src/orchestrator/peer-messages/preflight.js';
import type { PeerMessageInput } from '../../../src/orchestrator/peer-messages/schema.js';

describe('validatePeerMessagesPreflight', () => {
  it('returns an empty readonly input when peer_messages is absent', () => {
    expect(validatePeerMessagesPreflight(undefined, { maxItems: 1, maxExcerpts: 1 })).toEqual([]);
  });

  it('throws peer_messages.too_many when item count exceeds runtime cap', () => {
    expect(() => validatePeerMessagesPreflight([
      { body: 'a', kind: 'note' },
      { body: 'b', kind: 'note' },
    ], { maxItems: 1, maxExcerpts: 10 })).toThrow(/^peer_messages\.too_many:/);
  });

  it('throws peer_messages.too_many_excerpts when any item exceeds runtime cap', () => {
    const input: PeerMessageInput[] = [{
      body: 'a',
      kind: 'note',
      excerpts: [
        { file: 'a.ts', range: [1, 1], text: 'a' },
        { file: 'b.ts', range: [1, 1], text: 'b' },
      ],
    }];

    expect(() => validatePeerMessagesPreflight(input, {
      maxItems: 10,
      maxExcerpts: 1,
    })).toThrow(/^peer_messages\.too_many_excerpts:/);
  });
});
