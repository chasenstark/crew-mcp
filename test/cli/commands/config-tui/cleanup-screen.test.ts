import { describe, expect, it } from 'vitest';

import { CleanupScreen } from '../../../../src/cli/commands/config-tui/cleanup-screen.js';

const key = (name: string) => ({ name });

describe('CleanupScreen', () => {
  it('cycles the worktree TTL through presets on space', () => {
    const state = { worktreeTtlDays: 7, runDirTtlDays: 30 };
    const screen = new CleanupScreen(state);
    expect(screen.onKey(key('space'))).toBe('continue'); // 7 → 14
    expect(state.worktreeTtlDays).toBe(14);
    screen.onKey(key('space')); // 14 → 30
    expect(state.worktreeTtlDays).toBe(30);
  });

  it('cycles the run-dir TTL and renders off for -1', () => {
    const state = { worktreeTtlDays: 7, runDirTtlDays: 0 };
    const screen = new CleanupScreen(state);
    screen.onKey(key('down')); // move to run-dir row
    // 0 → 1
    screen.onKey(key('space'));
    expect(state.runDirTtlDays).toBe(1);
    state.runDirTtlDays = -1;
    expect(screen.render().some((l) => l.includes('run-dir TTL:   off'))).toBe(true);
  });

  it('records a dry-run request and exits via save', () => {
    const screen = new CleanupScreen({ worktreeTtlDays: 7, runDirTtlDays: 30 });
    screen.onKey(key('down')); // run-dir
    screen.onKey(key('down')); // preview
    expect(screen.onKey(key('return'))).toBe('save');
    expect(screen.requested).toBe('dry');
  });

  it('records a run request and exits via save', () => {
    const screen = new CleanupScreen({ worktreeTtlDays: 7, runDirTtlDays: 30 });
    screen.onKey(key('down')); // run-dir
    screen.onKey(key('down')); // preview
    screen.onKey(key('down')); // run
    expect(screen.onKey(key('return'))).toBe('save');
    expect(screen.requested).toBe('run');
  });

  it('pops on back without requesting cleanup', () => {
    const screen = new CleanupScreen({ worktreeTtlDays: 7, runDirTtlDays: 30 });
    screen.onKey(key('down')); // run-dir
    screen.onKey(key('down')); // preview
    screen.onKey(key('down')); // run
    screen.onKey(key('down')); // back
    expect(screen.onKey(key('return'))).toBe('pop');
    expect(screen.requested).toBeUndefined();
  });
});
