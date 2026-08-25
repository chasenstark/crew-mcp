import { describe, expect, it } from 'vitest';

import { IterateLimitsScreen } from '../../../../src/cli/commands/config-tui/iterate-limits-screen.js';

const key = (name: string) => ({ name });

describe('IterateLimitsScreen', () => {
  it('cycles the per-epoch limit and raises the total when needed', () => {
    const state = { maxRoundsPerEpoch: 3, maxTotalRounds: 3 };
    const screen = new IterateLimitsScreen(state);

    expect(screen.onKey(key('space'))).toBe('continue');
    expect(state).toEqual({ maxRoundsPerEpoch: 5, maxTotalRounds: 5 });
  });

  it('cycles the total limit without dropping below the per-epoch limit', () => {
    const state = { maxRoundsPerEpoch: 5, maxTotalRounds: 15 };
    const screen = new IterateLimitsScreen(state);
    screen.onKey(key('down'));

    screen.onKey(key('space'));
    expect(state.maxTotalRounds).toBe(20);
    expect(state.maxTotalRounds).toBeGreaterThanOrEqual(state.maxRoundsPerEpoch);
  });

  it('renders current values and pops from the back row', () => {
    const state = { maxRoundsPerEpoch: 5, maxTotalRounds: 15 };
    const screen = new IterateLimitsScreen(state);
    expect(screen.render().join('\n')).toContain('rounds per epoch: 5');
    expect(screen.render().join('\n')).toContain('total rounds:     15');

    screen.onKey(key('down'));
    screen.onKey(key('down'));
    expect(screen.onKey(key('space'))).toBe('pop');
  });
});
