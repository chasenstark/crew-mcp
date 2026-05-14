import { describe, expect, it } from 'vitest';
import {
  EFFORT_ORDER,
  clampEffortToSupported,
  type EffortLevel,
} from '../../src/adapters/types.js';

describe('EFFORT_ORDER', () => {
  it('lists canonical levels in ascending intensity', () => {
    expect(EFFORT_ORDER).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });
});

describe('clampEffortToSupported', () => {
  it('returns the level unchanged when supported is undefined (no constraint)', () => {
    expect(clampEffortToSupported('max', undefined)).toBe('max');
    expect(clampEffortToSupported('low', undefined)).toBe('low');
  });

  it('returns undefined when supported is empty', () => {
    expect(clampEffortToSupported('medium', [])).toBeUndefined();
  });

  it('returns the level unchanged when it is in the supported set', () => {
    const supported: EffortLevel[] = ['low', 'medium', 'high', 'xhigh'];
    expect(clampEffortToSupported('low', supported)).toBe('low');
    expect(clampEffortToSupported('xhigh', supported)).toBe('xhigh');
  });

  it('clamps down to the highest supported level when requested is above the set', () => {
    // Codex 0.130: supports up to xhigh; max must clamp to xhigh.
    const supported: EffortLevel[] = ['low', 'medium', 'high', 'xhigh'];
    expect(clampEffortToSupported('max', supported)).toBe('xhigh');
  });

  it('skips unsupported intermediate levels when stepping down', () => {
    const supported: EffortLevel[] = ['low', 'high'];
    expect(clampEffortToSupported('xhigh', supported)).toBe('high');
    expect(clampEffortToSupported('medium', supported)).toBe('low');
  });

  it('falls back upward only when nothing supported is ≤ requested', () => {
    // Defensive case: adapter that only supports high-tier efforts.
    const supported: EffortLevel[] = ['high', 'xhigh'];
    expect(clampEffortToSupported('low', supported)).toBe('high');
  });
});
