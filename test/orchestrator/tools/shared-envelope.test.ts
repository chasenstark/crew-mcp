import { describe, expect, it } from 'vitest';

import type { RunMode } from '../../../src/orchestrator/run-mode.js';
import {
  DISPATCH_RELAY_FIELD_MAX_BYTES,
  dispatchRelayFields,
  type FullRunEnvelope,
  type RequiredNextAction,
  requiredNextActionForRun,
  structuredRunEnvelope,
} from '../../../src/orchestrator/tools/shared.js';

describe('dispatch envelope JIT fields', () => {
  it('defines every required_next_action discriminator and preserves spawn_watcher fields', () => {
    const spawn = requiredNextActionForRun(
      'claude-code',
      'crew-wait',
      'run-1',
      '/crew',
      '/repo',
    );
    expect(spawn).toMatchObject({
      type: 'spawn_watcher',
      mechanism: 'background_shell',
      command: expect.any(String),
      working_directory: '/repo',
      run_id: 'run-1',
      run_in_background: true,
      per_run: true,
      consequence_if_skipped: expect.any(String),
    });

    const variants: RequiredNextAction[] = [
      {
        type: 'check_inbox',
        run_id: 'run-1',
        unread_count: 2,
        consequence_if_skipped: 'findings missed',
      },
      {
        type: 'confirm_with_user',
        run_id: 'run-1',
        prompt: 'Continue?',
        consequence_if_skipped: 'no confirmation',
      },
      {
        type: 'merge_or_discard',
        run_id: 'run-1',
        consequence_if_skipped: 'work may be collected',
      },
    ];
    expect(variants.map((variant) => variant.type)).toEqual([
      'check_inbox',
      'confirm_with_user',
      'merge_or_discard',
    ]);
  });

  it.each<RunMode>(['write', 'read_only', 'ephemeral_review'])(
    'builds single-line, UTF-8-byte-capped relay fields for %s mode and keeps them after trimming',
    (runMode) => {
      const fields = dispatchRelayFields({
        agentId: `codex\n${'🧠'.repeat(80)}`,
        runId: `run-${'é'.repeat(120)}`,
        runMode,
        tailUrl: `crew-tail://open?path=${'界'.repeat(120)}`,
      });
      for (const value of [fields.relay_verbatim, fields.ledger_line]) {
        expect(value).not.toMatch(/[\r\n]/u);
        expect(Buffer.byteLength(value ?? '', 'utf8')).toBeLessThanOrEqual(
          DISPATCH_RELAY_FIELD_MAX_BYTES,
        );
      }

      const full: FullRunEnvelope = {
        run_id: 'run-1',
        tail_url: 'crew-tail://run-1',
        summary: 'dispatched',
        files_changed: [],
        ...fields,
        status: 'running',
        agent_id: 'codex',
        worktree_path: '/repo/worktree',
        events_log_path: '/crew/events.log',
        tail_command_path: '/crew/tail.command',
        tail_command_url: 'file:///crew/tail.command',
      };
      expect(structuredRunEnvelope(full)).toMatchObject(fields);
    },
  );
});
