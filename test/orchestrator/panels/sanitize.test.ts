import { describe, expect, it } from 'vitest';

import { peerMessageInputSchema } from '../../../src/orchestrator/peer-messages/schema.js';
import { sanitizeFromLabel } from '../../../src/orchestrator/panels/sanitize.js';

describe('sanitizeFromLabel', () => {
  it('replaces control chars with underscores', () => {
    const controls = [
      ...Array.from({ length: 0x20 }, (_, code) => String.fromCharCode(code)),
      String.fromCharCode(0x7f),
    ];
    for (const ch of controls) {
      const out = sanitizeFromLabel(`a${ch}b`);
      expect(out).toBe('a_b');
      peerMessageInputSchema.shape.from_label.parse(out);
    }
  });

  it('replaces backticks, #, carriage returns, and newlines', () => {
    const out = sanitizeFromLabel('a`b#c\rd\ne');
    expect(out).toBe('a_b_c_d_e');
    peerMessageInputSchema.shape.from_label.parse(out);
  });

  it('composes raw and suffix only when suffix is non-empty', () => {
    expect(sanitizeFromLabel('codex', 'review')).toBe('codex (review)');
    expect(sanitizeFromLabel('codex', '')).toBe('codex');
    expect(sanitizeFromLabel('codex')).toBe('codex');
  });

  it('truncates to 80 chars', () => {
    const out = sanitizeFromLabel('x'.repeat(100));
    expect(out).toHaveLength(80);
    peerMessageInputSchema.shape.from_label.parse(out);
  });

  it('returns valid input unchanged', () => {
    expect(sanitizeFromLabel('codex reviewer')).toBe('codex reviewer');
  });

  it('always returns a value accepted by peerMessageInputSchema.from_label', () => {
    const cases = [
      'simple',
      'bad`#\nlabel',
      `${'x'.repeat(120)}\u0000`,
      sanitizeFromLabel('nested', 'suffix`#\n'),
    ];
    for (const value of cases) {
      const out = sanitizeFromLabel(value, 'suf\rfix');
      peerMessageInputSchema.shape.from_label.parse(out);
    }
  });
});
