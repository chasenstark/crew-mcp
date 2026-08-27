import { describe, expect, it } from 'vitest';

import {
  makePrWatchId,
  parsePrWatchId,
} from '../../src/pr-watch/id.js';

describe('PR-watch opaque ids', () => {
  it('mints and accepts only the canonical server shape', () => {
    const id = makePrWatchId();
    expect(id).toMatch(/^pw-[0-9a-f]{32}$/);
    expect(parsePrWatchId(id)).toBe(id);
  });

  it.each([
    '',
    'pw-ABCDEF0123456789abcdef0123456789',
    'pw-0123456789abcdef0123456789abcde',
    'pw-0123456789abcdef0123456789abcdef0',
    '../pw-0123456789abcdef0123456789abcdef',
    'pw-0123456789abcdef0123456789abcdef/child',
    'pw-%2e%2e%2f0123456789abcdef01234567',
    'pw-0123456789abcdef0123456789abcdé',
  ])('rejects unsafe id %j before filesystem use', (id) => {
    expect(() => parsePrWatchId(id)).toThrow('pr_watch.invalid_watch_id');
  });
});
