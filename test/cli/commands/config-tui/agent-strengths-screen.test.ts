import { describe, expect, it } from 'vitest';

import {
  AgentStrengthEditScreen,
  AgentStrengthsListScreen,
} from '../../../../src/cli/commands/config-tui/agent-strengths-screen.js';
import { AgentStrengthsState } from '../../../../src/cli/commands/config-tui/agent-strengths-state.js';
import { isPushResult } from '../../../../src/cli/commands/config-tui/screen.js';
import { StrengthsMultiSelectScreen } from '../../../../src/cli/commands/config-tui/strengths-multi-select-screen.js';
import { UseWhenInputScreen } from '../../../../src/cli/commands/config-tui/use-when-input-screen.js';

describe('config TUI agent strengths screens', () => {
  it('navigates list -> edit -> strengths picker', () => {
    const state = new AgentStrengthsState([
      {
        name: 'codex',
        strengths: ['fast-iteration'],
        useWhen: 'Use for edits.',
      },
    ]);
    const list = new AgentStrengthsListScreen(state);

    const edit = list.onKey({ name: 'space' });
    expect(isPushResult(edit)).toBe(true);
    if (!isPushResult(edit)) throw new Error('expected edit push');
    expect(edit.push).toBeInstanceOf(AgentStrengthEditScreen);

    const picker = edit.push.onKey({ name: 'space' });
    expect(isPushResult(picker)).toBe(true);
    if (!isPushResult(picker)) throw new Error('expected picker push');
    expect(picker.push).toBeInstanceOf(StrengthsMultiSelectScreen);
  });

  it('opens the useWhen editor from the edit screen', () => {
    const state = new AgentStrengthsState([
      { name: 'codex', strengths: ['fast-iteration'] },
    ]);
    const edit = new AgentStrengthEditScreen(state, 'codex');
    edit.onKey({ name: 'down' });

    const child = edit.onKey({ name: 'space' });
    expect(isPushResult(child)).toBe(true);
    if (!isPushResult(child)) throw new Error('expected child push');
    expect(child.push).toBeInstanceOf(UseWhenInputScreen);
  });
});

describe('StrengthsMultiSelectScreen', () => {
  it('preserves custom tags and commits deselect-all as []', () => {
    const state = new AgentStrengthsState([
      {
        name: 'codex',
        strengths: ['fast-iteration', 'typescript'],
      },
    ]);
    const screen = new StrengthsMultiSelectScreen({ agentName: 'codex', state });

    expect(screen.render()).toContain('  [x] typescript  (custom)');
    for (let i = 0; i < 20; i++) {
      if (screen.render().some((line) => line.startsWith('> [x] fast-iteration'))) break;
      screen.onKey({ name: 'down' });
    }
    expect(screen.render().some((line) => line.startsWith('> [x] fast-iteration'))).toBe(true);
    screen.onKey({ name: 'space' }); // fast-iteration off
    for (let i = 0; i < 20; i++) {
      if (screen.render().some((line) => line.startsWith('> [x] typescript'))) break;
      screen.onKey({ name: 'down' });
    }
    expect(screen.render().some((line) => line.startsWith('> [x] typescript'))).toBe(true);
    screen.onKey({ name: 'space' }); // typescript off
    expect(screen.onKey({ name: 'return' })).toBe('save');

    expect(state.getStrengths('codex')).toEqual([]);
    expect(state.patches()[0]).toEqual({
      agentName: 'codex',
      patch: { strengths: [] },
    });
  });
});

describe('UseWhenInputScreen', () => {
  it('treats q as literal text and escape as cancel', () => {
    const state = new AgentStrengthsState([
      { name: 'codex', strengths: [] },
    ]);
    const screen = new UseWhenInputScreen({ agentName: 'codex', state });

    expect(screen.onKey({ name: 'q', sequence: 'q' })).toBe('continue');
    expect(screen.render().some((line) => line.includes('q|'))).toBe(true);
    expect(screen.onKey({ name: 'escape' })).toBe('pop');
    expect(state.getUseWhen('codex')).toBeUndefined();
  });

  it('handles named controls before printable characters and saves trimmed text', () => {
    const state = new AgentStrengthsState([
      { name: 'codex', strengths: [] },
    ]);
    const screen = new UseWhenInputScreen({ agentName: 'codex', state });

    screen.onKey({ name: 'space', sequence: ' ' });
    screen.onKey({ name: 'a', sequence: 'a' });
    screen.onKey({ name: 'left' });
    screen.onKey({ name: 'b', sequence: 'b' });
    screen.onKey({ name: 'return' });

    expect(state.getUseWhen('codex')).toBe('ba');
  });

  it('keeps the cursor visible in a horizontal window', () => {
    const state = new AgentStrengthsState([
      { name: 'codex', strengths: [], useWhen: 'abcdefghijklmnop' },
    ]);
    const screen = new UseWhenInputScreen({
      agentName: 'codex',
      state,
      windowSize: 5,
    });

    expect(screen.render()).toContain('  <lmnop| ');
  });
});
