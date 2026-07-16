import { describe, expect, it } from 'vitest';

import { CheckboxListScreen } from '../../../../src/cli/commands/config-tui/checkbox-list-screen.js';
import {
  AGENT_DEFAULT_PATHS,
  AgentDefaultsState,
  applyAgentDefaultsState,
} from '../../../../src/cli/commands/config-tui/agent-defaults-state.js';
import { AgentDefaultsScreen } from '../../../../src/cli/commands/config-tui/agent-defaults-screen.js';
import { isPushResult } from '../../../../src/cli/commands/config-tui/screen.js';

describe('config TUI agent-defaults screen', () => {
  it('saves the whole config when enter is pressed on an action row', () => {
    // Regression: enter used to open the submenu on an action row; it
    // must save now. space is the only key that opens a submenu.
    const submenu = new AgentDefaultsScreen(new AgentDefaultsState(undefined), {
      agentIds: ['codex'],
      knownIds: new Set(['codex']),
    });
    const root = new CheckboxListScreen({
      title: 'crew-mcp config — toggle settings',
      state: { enabled: true },
      entries: [
        {
          label: 'one',
          description: 'toggle',
          get: (state) => state.enabled,
          set: (state, value) => {
            state.enabled = value;
          },
        },
        {
          kind: 'action',
          label: 'Agent defaults...',
          description: 'Configure default agents',
          onActivate: () => ({ push: submenu }),
        },
      ],
    });

    root.onKey({ name: 'down' }); // move onto the action row
    expect(root.onKey({ name: 'return' })).toBe('save');
    expect(isPushResult(root.onKey({ name: 'space' }))).toBe(true);
  });

  it('pushes from the root list and preserves cursors on pop', () => {
    const crewState = { enabled: true };
    const agentState = new AgentDefaultsState(undefined);
    const submenu = new AgentDefaultsScreen(agentState, {
      agentIds: ['codex', 'claude-code'],
      knownIds: new Set(['codex', 'claude-code']),
    });
    const root = new CheckboxListScreen({
      title: 'crew-mcp config — toggle settings',
      state: crewState,
      entries: [
        {
          label: 'one',
          description: 'toggle',
          get: (state) => state.enabled,
          set: (state, value) => {
            state.enabled = value;
          },
        },
        {
          kind: 'action',
          label: 'Agent defaults...',
          description: 'Configure default agents',
          onActivate: () => ({ push: submenu }),
        },
      ],
    });

    root.onKey({ name: 'down' });
    // space opens submenus now; enter is reserved for saving.
    const pushed = root.onKey({ name: 'space' });
    expect(isPushResult(pushed)).toBe(true);
    expect(root.getCursorIndex()).toBe(1);

    submenu.onKey({ name: 'down' });
    const child = submenu.onKey({ name: 'space' });
    expect(isPushResult(child)).toBe(true);
    expect(submenu.getCursorIndex()).toBe(1);
    if (!isPushResult(child)) throw new Error('expected child push');
    child.push.onKey({ name: 'space' });
    child.push.onKey({ name: 'q' }); // commit-on-leave, back to submenu
    expect(submenu.getCursorIndex()).toBe(1);
    expect(root.getCursorIndex()).toBe(1);
  });

  it('keeps writes in memory until the TUI save path flushes', () => {
    const agentState = new AgentDefaultsState(undefined);
    const submenu = new AgentDefaultsScreen(agentState, {
      agentIds: ['codex'],
      knownIds: new Set(['codex']),
    });
    submenu.onKey({ name: 'down' });
    const child = submenu.onKey({ name: 'space' });
    if (!isPushResult(child)) throw new Error('expected child push');

    const setCalls: string[] = [];
    const unsetCalls: string[] = [];
    child.push.onKey({ name: 'space' });
    child.push.onKey({ name: 'return' }); // commit buffer to in-memory state + save
    expect(agentState.getList(AGENT_DEFAULT_PATHS.iterateReviewers)).toEqual(['codex']);
    expect(setCalls).toEqual([]);
    expect(unsetCalls).toEqual([]);

    applyAgentDefaultsState('/tmp/project', agentState, {
      setConfigValue: (_cwd, path) => setCalls.push(path),
      unsetConfigValue: (_cwd, path) => unsetCalls.push(path),
    });
    expect(setCalls).toContain(AGENT_DEFAULT_PATHS.iterateReviewers);
  });
});
