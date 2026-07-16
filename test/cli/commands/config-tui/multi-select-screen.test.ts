import { describe, expect, it } from 'vitest';

import {
  AGENT_DEFAULT_PATHS,
  AgentDefaultsState,
  applyAgentDefaultsState,
} from '../../../../src/cli/commands/config-tui/agent-defaults-state.js';
import { MultiSelectScreen } from '../../../../src/cli/commands/config-tui/multi-select-screen.js';

describe('config TUI multi-select screen', () => {
  it('preserves toggle order and renders numbered selections', () => {
    const state = new AgentDefaultsState(undefined);
    const screen = new MultiSelectScreen({
      title: 'Pick iterate.reviewers (order = preference order)',
      path: AGENT_DEFAULT_PATHS.iterateReviewers,
      agentIds: ['codex', 'claude-code', 'gemini-cli'],
      knownIds: new Set(['codex', 'claude-code', 'gemini-cli']),
      state,
    });

    screen.onKey({ name: 'space' });
    screen.onKey({ name: 'down' });
    screen.onKey({ name: 'space' });
    expect(screen.render()).toEqual(expect.arrayContaining([
      '> [x] 2. claude-code',
      '  [x] 1. codex',
    ]));
    expect(screen.onKey({ name: 'return' })).toBe('save');
    expect(state.getList(AGENT_DEFAULT_PATHS.iterateReviewers)).toEqual([
      'codex',
      'claude-code',
    ]);
  });

  it('moves deselected then reselected items to the end', () => {
    const state = new AgentDefaultsState({
      iterate: { reviewers: ['codex', 'claude-code'] },
    });
    const screen = new MultiSelectScreen({
      title: 'Pick iterate.reviewers (order = preference order)',
      path: AGENT_DEFAULT_PATHS.iterateReviewers,
      agentIds: ['codex', 'claude-code'],
      knownIds: new Set(['codex', 'claude-code']),
      state,
    });

    screen.onKey({ name: 'space' });
    screen.onKey({ name: 'space' });
    expect(screen.render()).toEqual(expect.arrayContaining([
      '> [x] 2. codex',
      '  [x] 1. claude-code',
    ]));
    expect(screen.onKey({ name: 'return' })).toBe('save');
    expect(state.getList(AGENT_DEFAULT_PATHS.iterateReviewers)).toEqual([
      'claude-code',
      'codex',
    ]);
  });

  it('unsets the config path when an empty selection is saved', () => {
    const state = new AgentDefaultsState({
      iterate: { reviewers: ['codex'] },
    });
    const screen = new MultiSelectScreen({
      title: 'Pick iterate.reviewers (order = preference order)',
      path: AGENT_DEFAULT_PATHS.iterateReviewers,
      agentIds: ['codex'],
      knownIds: new Set(['codex']),
      state,
    });

    screen.onKey({ name: 'space' });
    expect(screen.onKey({ name: 'return' })).toBe('save');

    const setCalls: string[] = [];
    const unsetCalls: string[] = [];
    applyAgentDefaultsState('/tmp/project', state, {
      setConfigValue: (_cwd, path) => setCalls.push(path),
      unsetConfigValue: (_cwd, path) => unsetCalls.push(path),
    });
    expect(unsetCalls).toContain(AGENT_DEFAULT_PATHS.iterateReviewers);
    expect(setCalls).not.toContain(AGENT_DEFAULT_PATHS.iterateReviewers);
  });
});
