import { describe, expect, it } from 'vitest';

import {
  AGENT_DEFAULT_PATHS,
  AgentDefaultsState,
  applyAgentDefaultsState,
} from '../../../../src/cli/commands/config-tui/agent-defaults-state.js';
import { SingleSelectScreen } from '../../../../src/cli/commands/config-tui/single-select-screen.js';

describe('config TUI single-select screen', () => {
  it('renders one active radio and selects with space', () => {
    const state = new AgentDefaultsState({
      iterate: { implementer: 'codex' },
    });
    const screen = new SingleSelectScreen({
      title: 'Pick iterate.implementer',
      path: AGENT_DEFAULT_PATHS.iterateImplementer,
      agentIds: ['codex', 'claude-code'],
      knownIds: new Set(['codex', 'claude-code']),
      state,
    });

    expect(screen.render().filter((line) => line.includes('(•)'))).toHaveLength(1);
    screen.onKey({ name: 'down' });
    expect(screen.onKey({ name: 'space' })).toBe('pop');
    expect(state.getSingle(AGENT_DEFAULT_PATHS.iterateImplementer)).toBe('claude-code');
    const activeLines = screen.render().filter((line) => line.includes('(•)'));
    expect(activeLines).toEqual(['> (•) claude-code']);
  });

  it('selects with enter', () => {
    const state = new AgentDefaultsState(undefined);
    const screen = new SingleSelectScreen({
      title: 'Pick iterate.implementer',
      path: AGENT_DEFAULT_PATHS.iterateImplementer,
      agentIds: ['codex'],
      knownIds: new Set(['codex']),
      state,
    });

    expect(screen.onKey({ name: 'return' })).toBe('pop');
    expect(state.getSingle(AGENT_DEFAULT_PATHS.iterateImplementer)).toBe('codex');
  });

  it('unsets via the unset sentinel on save', () => {
    const state = new AgentDefaultsState({
      iterate: { implementer: 'codex' },
    });
    const screen = new SingleSelectScreen({
      title: 'Pick iterate.implementer',
      path: AGENT_DEFAULT_PATHS.iterateImplementer,
      agentIds: ['codex'],
      knownIds: new Set(['codex']),
      state,
    });
    screen.onKey({ name: 'down' });
    expect(screen.onKey({ name: 'space' })).toBe('pop');

    const setCalls: string[] = [];
    const unsetCalls: string[] = [];
    applyAgentDefaultsState('/tmp/project', state, {
      setConfigValue: (_cwd, path) => setCalls.push(path),
      unsetConfigValue: (_cwd, path) => unsetCalls.push(path),
    });

    expect(setCalls).not.toContain(AGENT_DEFAULT_PATHS.iterateImplementer);
    expect(unsetCalls).toContain(AGENT_DEFAULT_PATHS.iterateImplementer);
  });
});
