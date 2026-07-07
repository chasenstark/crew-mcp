import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  appendMessage,
  listMessages,
  transitionMessages,
} from '../../../src/orchestrator/captain-inbox/store.js';
import {
  acknowledgeMessagesInputSchema,
  acknowledgeMessagesToolHandler,
} from '../../../src/orchestrator/tools/acknowledge-messages.js';

function tempRoot(): { readonly crewHome: string; readonly repoRoot: string; readonly cleanup: () => void } {
  const crewHome = mkdtempSync(join(tmpdir(), 'crew-ack-inbox-home-'));
  const repoRoot = mkdtempSync(join(tmpdir(), 'crew-ack-inbox-repo-'));
  return {
    crewHome,
    repoRoot,
    cleanup: () => {
      rmSync(crewHome, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    },
  };
}

function message(repoRoot: string, index: number) {
  return {
    to: { kind: 'captain' as const },
    from: { kind: 'run' as const, run_id: `run-${index}`, agent_id: 'codex' },
    kind: 'note' as const,
    body: `body ${index}`,
    worker_run_id_at_send: `run-${index}`,
    worker_agent_id_at_send: 'codex',
    repo_root_at_send: repoRoot,
  };
}

describe('acknowledge_messages', () => {
  it('returns acknowledged, not_found, and already_in_target_state buckets', async () => {
    const h = tempRoot();
    try {
      const unread = await appendMessage({ crewHome: h.crewHome, message: message(h.repoRoot, 1) });
      const alreadyRead = await appendMessage({ crewHome: h.crewHome, message: message(h.repoRoot, 2) });
      await transitionMessages({
        crewHome: h.crewHome,
        repoRoot: h.repoRoot,
        msgIds: [alreadyRead.msg_id],
        action: 'read',
      });

      const result = await acknowledgeMessagesToolHandler(
        acknowledgeMessagesInputSchema.parse({
          msg_ids: [unread.msg_id, alreadyRead.msg_id, '01K0000000000000000000000'],
          action: 'read',
        }),
        { crewHome: h.crewHome, projectRoot: h.repoRoot },
      );

      expect(result.structuredContent).toEqual({
        acknowledged: [unread.msg_id],
        already_in_target_state: [alreadyRead.msg_id],
        not_found: ['01K0000000000000000000000'],
      });
    } finally {
      h.cleanup();
    }
  });

  it('allows read messages to be dismissed', async () => {
    const h = tempRoot();
    try {
      const read = await appendMessage({ crewHome: h.crewHome, message: message(h.repoRoot, 1) });
      await transitionMessages({
        crewHome: h.crewHome,
        repoRoot: h.repoRoot,
        msgIds: [read.msg_id],
        action: 'read',
      });

      const result = await acknowledgeMessagesToolHandler(
        acknowledgeMessagesInputSchema.parse({ msg_ids: [read.msg_id], action: 'dismiss' }),
        { crewHome: h.crewHome, projectRoot: h.repoRoot },
      );

      expect(result.structuredContent).toMatchObject({ acknowledged: [read.msg_id] });
      expect(listMessages({ crewHome: h.crewHome, repoRoot: h.repoRoot })).toMatchObject([
        { msg_id: read.msg_id, status: 'dismissed' },
      ]);
    } finally {
      h.cleanup();
    }
  });

  it('keeps overlapping concurrent acknowledges race-safe', async () => {
    const h = tempRoot();
    try {
      const messages = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          appendMessage({ crewHome: h.crewHome, message: message(h.repoRoot, index) })),
      );
      const ids = messages.map((m) => m.msg_id);

      const results = await Promise.all([
        acknowledgeMessagesToolHandler(
          acknowledgeMessagesInputSchema.parse({ msg_ids: ids.slice(0, 4), action: 'read' }),
          { crewHome: h.crewHome, projectRoot: h.repoRoot },
        ),
        acknowledgeMessagesToolHandler(
          acknowledgeMessagesInputSchema.parse({ msg_ids: ids.slice(2), action: 'read' }),
          { crewHome: h.crewHome, projectRoot: h.repoRoot },
        ),
      ]);

      for (const result of results) {
        const buckets = result.structuredContent as {
          acknowledged: string[];
          not_found: string[];
          already_in_target_state: string[];
        };
        const seen = [
          ...buckets.acknowledged,
          ...buckets.not_found,
          ...buckets.already_in_target_state,
        ];
        expect(new Set(seen).size).toBe(seen.length);
      }
      expect(listMessages({ crewHome: h.crewHome, repoRoot: h.repoRoot }))
        .toHaveLength(6);
      expect(listMessages({ crewHome: h.crewHome, repoRoot: h.repoRoot }).every((m) => m.status === 'read'))
        .toBe(true);
    } finally {
      h.cleanup();
    }
  });
});
