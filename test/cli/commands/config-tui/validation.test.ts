import { describe, expect, it } from 'vitest';

import { CheckboxListScreen } from '../../../../src/cli/commands/config-tui/checkbox-list-screen.js';
import {
  AGENT_DEFAULT_PATHS,
  AgentDefaultsState,
} from '../../../../src/cli/commands/config-tui/agent-defaults-state.js';
import { MultiSelectScreen } from '../../../../src/cli/commands/config-tui/multi-select-screen.js';

describe('config TUI agent-default validation', () => {
  it('shows an inline collision error and blocks save', () => {
    const state = new AgentDefaultsState({
      iterate: {
        reviewers: ['codex'],
        banList: ['codex'],
      },
    });
    const root = new CheckboxListScreen({
      title: 'crew-mcp config — toggle settings',
      state: { enabled: true },
      beforeSave: () => state.validateForSave(),
      entries: [
        {
          label: 'one',
          description: 'toggle',
          get: (value) => value.enabled,
          set: (value, next) => {
            value.enabled = next;
          },
        },
      ],
    });

    expect(root.onKey({ name: 'return' })).toBe('continue');
    expect(root.render()).toContain(
      "Conflict: 'codex' is in both iterate.reviewers and iterate.banList. Remove one before saving.",
    );
  });

  it('renders unknown configured ids without blocking save', () => {
    const state = new AgentDefaultsState({
      iterate: { reviewers: ['missing-agent'] },
    });
    const screen = new MultiSelectScreen({
      title: 'Pick iterate.reviewers (order = preference order)',
      path: AGENT_DEFAULT_PATHS.iterateReviewers,
      agentIds: ['codex'],
      knownIds: new Set(['codex']),
      state,
    });

    expect(screen.render()).toContain('Note: 1 configured id(s) are not in list_agents');
    expect(screen.render()).toContain('  [x] 1. missing-agent  (unknown — not in list_agents)');

    const root = new CheckboxListScreen({
      title: 'crew-mcp config — toggle settings',
      state: { enabled: true },
      beforeSave: () => state.validateForSave(),
      entries: [
        {
          label: 'one',
          description: 'toggle',
          get: (value) => value.enabled,
          set: (value, next) => {
            value.enabled = next;
          },
        },
      ],
    });
    expect(root.onKey({ name: 'return' })).toBe('save');
  });
});
