import { describe, expect, it } from 'vitest';

import {
  CODEX_PR_WATCH_ESCALATION_JUSTIFICATION,
  prWatchRequiredAction,
} from '../../src/orchestrator/tools/pr-watch.js';
import type { PrWatchStateV1 } from '../../src/pr-watch/types.js';

const STATE = {
  status: 'active',
  watchId: 'pw-0123456789abcdef0123456789abcdef',
  generation: 3,
  observationMode: 'full',
  waiter: { watcherActionId: 'wa-current' },
} as unknown as Extract<PrWatchStateV1, { readonly status: 'active' }>;

const CONTEXT = { crewHome: '/crew', projectRoot: '/repo' };

describe('prWatchRequiredAction', () => {
  it('gives Codex the complete escalated spawn recipe alongside the JSON-safe command', () => {
    const action = prWatchRequiredAction(STATE, CONTEXT, 'crew-pr-watch-wait --codex-queue-thread thread-1', 'codex');
    expect(action).toMatchObject({
      type: 'spawn_pr_watch_watcher',
      mechanism: 'codex_queue',
      watch_id: STATE.watchId,
      generation: 3,
      watcher_action_id: 'wa-current',
    });
    expect(action.command_json).toBe(JSON.stringify(action.command));
    expect(JSON.parse(action.spawn_recipe_json as string)).toEqual({
      cmd: action.command,
      workdir: '/repo',
      sandbox_permissions: 'require_escalated',
      justification: CODEX_PR_WATCH_ESCALATION_JUSTIFICATION,
      yield_time_ms: 1_000,
      max_output_tokens: 1_000,
    });
  });

  it('keeps Claude Code actions free of Codex launcher fields', () => {
    const action = prWatchRequiredAction(STATE, CONTEXT, 'crew-pr-watch-wait', 'claude-code');
    expect(action).toMatchObject({ mechanism: 'background_shell' });
    expect(action).not.toHaveProperty('command_json');
    expect(action).not.toHaveProperty('spawn_recipe_json');
    expect(action).not.toHaveProperty('working_directory_json');
  });
});
