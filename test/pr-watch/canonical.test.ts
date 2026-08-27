import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../../src/pr-watch/canonical.js';

describe('PR-watch canonical JSON', () => {
  it('sorts keys by locale-independent code-unit order', () => {
    expect(canonicalJson({ 'ä': 1, z: 2, a: 3 })).toBe('{"a":3,"z":2,"ä":1}');
  });
});
