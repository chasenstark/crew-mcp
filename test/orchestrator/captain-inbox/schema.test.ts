import { describe, expect, it } from 'vitest';

import { captainInboxMessageSchema } from '../../../src/orchestrator/captain-inbox/schema.js';

const baseMessage = {
  inbox_schema_version: 1,
  msg_id: '01K00000000000000000000000',
  to: { kind: 'captain' },
  from: { kind: 'run', run_id: 'run-1', agent_id: 'codex' },
  kind: 'note',
  body: 'hello',
  status: 'unread',
  created_at: '2026-07-06T00:00:00.000Z',
  worker_run_id_at_send: 'run-1',
  worker_agent_id_at_send: 'codex',
  repo_root_at_send: '/repo',
};

describe('captain inbox message schema', () => {
  it('accepts every peer-message-aligned kind', () => {
    for (const kind of ['note', 'review', 'question', 'answer', 'status']) {
      expect(captainInboxMessageSchema.safeParse({ ...baseMessage, kind }).success).toBe(true);
    }
  });

  it('rejects threading fields in v1', () => {
    const result = captainInboxMessageSchema.strict().safeParse({
      ...baseMessage,
      in_reply_to: 'msg-1',
    });
    expect(result.success).toBe(false);
  });

  it('rejects traversal msg_id values and reversed excerpt ranges', () => {
    expect(captainInboxMessageSchema.safeParse({
      ...baseMessage,
      msg_id: '../../runs/run-1/.worker-ready',
    }).success).toBe(false);

    expect(captainInboxMessageSchema.safeParse({
      ...baseMessage,
      excerpts: [{ file: 'x.ts', range: [50, 3], text: 'bad range' }],
    }).success).toBe(false);
  });
});
