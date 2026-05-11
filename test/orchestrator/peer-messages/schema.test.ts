import { describe, expect, it } from 'vitest';

import {
  PEER_MESSAGES_SCHEMA_VERSION,
  peerMessageInputSchema,
  peerMessagesInputSchema,
} from '../../../src/orchestrator/peer-messages/schema.js';

describe('peerMessageInputSchema', () => {
  it('applies defaults and exports schema version 1', () => {
    const parsed = peerMessageInputSchema.parse({ body: 'hello' });

    expect(PEER_MESSAGES_SCHEMA_VERSION).toBe(1);
    expect(parsed.kind).toBe('note');
  });

  it('rejects empty body', () => {
    expect(() => peerMessageInputSchema.parse({ body: '' })).toThrow();
  });

  it('allows body text above the runtime body cap', () => {
    expect(peerMessageInputSchema.parse({
      body: 'x'.repeat(64 * 1024),
    }).body).toHaveLength(64 * 1024);
  });

  it('rejects each forbidden from_label refinement path', () => {
    for (const from_label of ['bad\u0000label', 'bad\u001flabel', 'bad\u007flabel', 'bad\nlabel', 'bad\rlabel', 'bad`label', 'bad#label']) {
      expect(() => peerMessageInputSchema.parse({ body: 'hello', from_label })).toThrow(
        /no control chars/,
      );
    }
  });

  it('allows from_label at max length and rejects one past max', () => {
    expect(peerMessageInputSchema.parse({
      body: 'hello',
      from_label: 'x'.repeat(80),
    }).from_label).toHaveLength(80);

    expect(() => peerMessageInputSchema.parse({
      body: 'hello',
      from_label: 'x'.repeat(81),
    })).toThrow();
  });

  it('allows static files ceilings far above runtime defaults', () => {
    expect(peerMessageInputSchema.parse({
      body: 'hello',
      files: Array.from({ length: 1000 }, () => 'x'.repeat(4096)),
    }).files).toHaveLength(1000);

    expect(() => peerMessageInputSchema.parse({
      body: 'hello',
      files: Array.from({ length: 1001 }, () => 'a'),
    })).toThrow();

    expect(() => peerMessageInputSchema.parse({
      body: 'hello',
      files: ['x'.repeat(4097)],
    })).toThrow();
  });

  it('allows static excerpts ceilings and validates file/range boundaries', () => {
    const excerpt = {
      file: 'x'.repeat(4096),
      range: [1, 1],
      text: '',
    };
    expect(peerMessageInputSchema.parse({
      body: 'hello',
      excerpts: Array.from({ length: 1000 }, () => excerpt),
    }).excerpts).toHaveLength(1000);

    expect(() => peerMessageInputSchema.parse({
      body: 'hello',
      excerpts: Array.from({ length: 1001 }, () => excerpt),
    })).toThrow();

    expect(() => peerMessageInputSchema.parse({
      body: 'hello',
      excerpts: [{ ...excerpt, file: 'x'.repeat(4097) }],
    })).toThrow();

    expect(() => peerMessageInputSchema.parse({
      body: 'hello',
      excerpts: [{ ...excerpt, range: [0, 1] }],
    })).toThrow();

    expect(() => peerMessageInputSchema.parse({
      body: 'hello',
      excerpts: [{ ...excerpt, range: [1.5, 2] }],
    })).toThrow();
  });

  it('allows excerpt text above the runtime excerpt cap', () => {
    const parsed = peerMessageInputSchema.parse({
      body: 'a',
      excerpts: [{ file: 'f', range: [1, 1], text: 'x'.repeat(64 * 1024) }],
    });

    expect(parsed.excerpts?.[0].text).toHaveLength(64 * 1024);
  });

  it('exports a top-level anti-DOS array ceiling of 10000', () => {
    expect(peerMessagesInputSchema.parse(
      Array.from({ length: 10000 }, () => ({ body: 'hello' })),
    )).toHaveLength(10000);

    expect(() => peerMessagesInputSchema.parse(
      Array.from({ length: 10001 }, () => ({ body: 'hello' })),
    )).toThrow();
  });
});
