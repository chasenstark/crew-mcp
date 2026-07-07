import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  appendMessage,
  CaptainInboxError,
  clearCaptainInboxSweepStateForTest,
  inboxRepoDir,
  listMessages,
  sweepExpiredMessages,
  transitionMessages,
} from '../../../src/orchestrator/captain-inbox/store.js';

function tempRoot(): { readonly crewHome: string; readonly repoRoot: string; readonly cleanup: () => void } {
  const crewHome = mkdtempSync(join(tmpdir(), 'crew-inbox-home-'));
  const repoRoot = mkdtempSync(join(tmpdir(), 'crew-inbox-repo-'));
  return {
    crewHome,
    repoRoot,
    cleanup: () => {
      rmSync(crewHome, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    },
  };
}

function message(repoRoot: string, index = 0) {
  return {
    to: { kind: 'captain' as const },
    from: { kind: 'run' as const, run_id: 'run-1', agent_id: 'codex' },
    kind: 'note' as const,
    body: `body ${index}`,
    worker_run_id_at_send: 'run-1',
    worker_agent_id_at_send: 'codex',
    repo_root_at_send: repoRoot,
  };
}

describe('captain inbox store', () => {
  it('serializes concurrent appends under caps without corrupt files', async () => {
    const h = tempRoot();
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 12 }, (_, index) =>
          appendMessage({
            crewHome: h.crewHome,
            message: message(h.repoRoot, index),
            env: {
              CREW_CAPTAIN_INBOX_MAX_UNREAD: '5',
              CREW_CAPTAIN_INBOX_MAX_TOTAL: '100',
            } as NodeJS.ProcessEnv,
          })),
      );

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(5);
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(rejected).toHaveLength(7);
      for (const result of rejected) {
        expect((result as PromiseRejectedResult).reason).toBeInstanceOf(CaptainInboxError);
        expect((result as PromiseRejectedResult).reason.code).toBe('inbox_full');
      }

      const dir = inboxRepoDir(h.crewHome, h.repoRoot);
      expect(existsSync(join(dir, '.lock'))).toBe(false);
      expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
      expect(listMessages({ crewHome: h.crewHome, repoRoot: h.repoRoot })).toHaveLength(5);
    } finally {
      h.cleanup();
    }
  });

  it('enforces total cap across read/dismissed messages', async () => {
    const h = tempRoot();
    try {
      const first = await appendMessage({
        crewHome: h.crewHome,
        message: message(h.repoRoot, 1),
        env: {
          CREW_CAPTAIN_INBOX_MAX_UNREAD: '10',
          CREW_CAPTAIN_INBOX_MAX_TOTAL: '1',
        } as NodeJS.ProcessEnv,
      });
      await transitionMessages({
        crewHome: h.crewHome,
        repoRoot: h.repoRoot,
        msgIds: [first.msg_id],
        action: 'read',
        now: new Date('2026-07-06T00:00:01.000Z'),
      });

      await expect(appendMessage({
        crewHome: h.crewHome,
        message: message(h.repoRoot, 2),
        env: {
          CREW_CAPTAIN_INBOX_MAX_UNREAD: '10',
          CREW_CAPTAIN_INBOX_MAX_TOTAL: '1',
        } as NodeJS.ProcessEnv,
      })).rejects.toMatchObject({ code: 'inbox_total_full' });
    } finally {
      h.cleanup();
    }
  });

  it('lists valid messages sorted and skips malformed files', async () => {
    const h = tempRoot();
    try {
      const second = await appendMessage({
        crewHome: h.crewHome,
        message: message(h.repoRoot, 2),
        now: new Date('2026-07-06T00:00:02.000Z'),
      });
      const first = await appendMessage({
        crewHome: h.crewHome,
        message: message(h.repoRoot, 1),
        now: new Date('2026-07-06T00:00:01.000Z'),
      });
      writeFileSync(join(inboxRepoDir(h.crewHome, h.repoRoot), 'bad.json'), '{ bad', 'utf-8');

      expect(listMessages({ crewHome: h.crewHome, repoRoot: h.repoRoot }).map((m) => m.msg_id))
        .toEqual([first.msg_id, second.msg_id]);
    } finally {
      h.cleanup();
    }
  });

  it('skips filename/id mismatches and cannot transition-write outside the inbox dir', async () => {
    const h = tempRoot();
    try {
      const good = await appendMessage({
        crewHome: h.crewHome,
        message: message(h.repoRoot, 1),
        now: new Date('2026-07-06T00:00:01.000Z'),
      });
      const mismatched = await appendMessage({
        crewHome: h.crewHome,
        message: message(h.repoRoot, 2),
        now: new Date('2026-07-06T00:00:02.000Z'),
      });
      const dir = inboxRepoDir(h.crewHome, h.repoRoot);
      const mismatchedPath = join(dir, `${mismatched.msg_id}.json`);
      writeFileSync(
        mismatchedPath,
        JSON.stringify({ ...mismatched, msg_id: good.msg_id }, null, 2) + '\n',
        'utf-8',
      );
      const traversalName = '../../outside';
      writeFileSync(
        join(dir, '01K0000000000000000000000.json'),
        JSON.stringify({ ...good, msg_id: traversalName }, null, 2) + '\n',
        'utf-8',
      );

      expect(listMessages({ crewHome: h.crewHome, repoRoot: h.repoRoot }).map((m) => m.msg_id))
        .toEqual([good.msg_id]);

      const outsidePath = join(dir, '..', '..', 'outside.json');
      const result = await transitionMessages({
        crewHome: h.crewHome,
        repoRoot: h.repoRoot,
        msgIds: [good.msg_id, traversalName],
        action: 'read',
        now: new Date('2026-07-06T00:00:03.000Z'),
      });

      expect(result).toEqual({
        acknowledged: [good.msg_id],
        not_found: [traversalName],
        already_in_target_state: [],
      });
      expect(existsSync(outsidePath)).toBe(false);
      expect(JSON.parse(readFileSync(mismatchedPath, 'utf-8'))).toMatchObject({
        msg_id: good.msg_id,
        status: 'unread',
      });
    } finally {
      h.cleanup();
    }
  });

  it('sweeps only expired read and dismissed messages', async () => {
    clearCaptainInboxSweepStateForTest();
    const h = tempRoot();
    try {
      const oldUnread = await appendMessage({
        crewHome: h.crewHome,
        message: { ...message(h.repoRoot, 1), created_at: '2026-06-01T00:00:00.000Z' },
      });
      const oldRead = await appendMessage({ crewHome: h.crewHome, message: message(h.repoRoot, 2) });
      const freshRead = await appendMessage({ crewHome: h.crewHome, message: message(h.repoRoot, 3) });
      const oldDismissed = await appendMessage({ crewHome: h.crewHome, message: message(h.repoRoot, 4) });
      await transitionMessages({
        crewHome: h.crewHome,
        repoRoot: h.repoRoot,
        msgIds: [oldRead.msg_id],
        action: 'read',
        now: new Date('2026-06-01T00:00:00.000Z'),
      });
      await transitionMessages({
        crewHome: h.crewHome,
        repoRoot: h.repoRoot,
        msgIds: [freshRead.msg_id],
        action: 'read',
        now: new Date('2026-07-05T00:00:00.000Z'),
      });
      await transitionMessages({
        crewHome: h.crewHome,
        repoRoot: h.repoRoot,
        msgIds: [oldDismissed.msg_id],
        action: 'dismiss',
        now: new Date('2026-06-01T00:00:00.000Z'),
      });

      const sweep = await sweepExpiredMessages({
        crewHome: h.crewHome,
        repoRoot: h.repoRoot,
        now: new Date('2026-07-06T00:00:00.000Z'),
      });

      expect(sweep).toEqual({ swept: 2, skipped: false });
      expect(listMessages({ crewHome: h.crewHome, repoRoot: h.repoRoot }).map((m) => m.msg_id))
        .toEqual([oldUnread.msg_id, freshRead.msg_id]);
    } finally {
      h.cleanup();
      clearCaptainInboxSweepStateForTest();
    }
  });

  it('honors retention env override and cooldown skips immediate second sweep', async () => {
    clearCaptainInboxSweepStateForTest();
    const h = tempRoot();
    try {
      const expired = await appendMessage({ crewHome: h.crewHome, message: message(h.repoRoot, 1) });
      await transitionMessages({
        crewHome: h.crewHome,
        repoRoot: h.repoRoot,
        msgIds: [expired.msg_id],
        action: 'read',
        now: new Date('2026-07-04T00:00:00.000Z'),
      });
      expect(await sweepExpiredMessages({
        crewHome: h.crewHome,
        repoRoot: h.repoRoot,
        now: new Date('2026-07-06T00:00:00.000Z'),
        env: { CREW_CAPTAIN_INBOX_RETENTION_DAYS: '1' } as NodeJS.ProcessEnv,
      })).toEqual({ swept: 1, skipped: false });

      const secondExpired = await appendMessage({ crewHome: h.crewHome, message: message(h.repoRoot, 2) });
      await transitionMessages({
        crewHome: h.crewHome,
        repoRoot: h.repoRoot,
        msgIds: [secondExpired.msg_id],
        action: 'dismiss',
        now: new Date('2026-07-04T00:00:00.000Z'),
      });

      expect(await sweepExpiredMessages({
        crewHome: h.crewHome,
        repoRoot: h.repoRoot,
        now: new Date('2026-07-06T00:00:01.000Z'),
        env: { CREW_CAPTAIN_INBOX_RETENTION_DAYS: '1' } as NodeJS.ProcessEnv,
      })).toEqual({ swept: 0, skipped: true });
      expect(listMessages({ crewHome: h.crewHome, repoRoot: h.repoRoot }).map((m) => m.msg_id))
        .toEqual([secondExpired.msg_id]);
    } finally {
      h.cleanup();
      clearCaptainInboxSweepStateForTest();
    }
  });

  it('serializes sweep and transition without corrupting files', async () => {
    clearCaptainInboxSweepStateForTest();
    const h = tempRoot();
    try {
      const unread = await appendMessage({
        crewHome: h.crewHome,
        message: { ...message(h.repoRoot, 1), created_at: '2026-06-01T00:00:00.000Z' },
      });

      const [transition] = await Promise.all([
        transitionMessages({
          crewHome: h.crewHome,
          repoRoot: h.repoRoot,
          msgIds: [unread.msg_id],
          action: 'read',
          now: new Date('2026-07-06T00:00:00.000Z'),
        }),
        sweepExpiredMessages({
          crewHome: h.crewHome,
          repoRoot: h.repoRoot,
          now: new Date('2026-07-06T00:00:00.000Z'),
          force: true,
        }),
      ]);

      expect([
        transition.acknowledged.includes(unread.msg_id),
        transition.not_found.includes(unread.msg_id),
        transition.already_in_target_state.includes(unread.msg_id),
      ].filter(Boolean)).toHaveLength(1);
      const remaining = listMessages({ crewHome: h.crewHome, repoRoot: h.repoRoot });
      expect(remaining).toHaveLength(1);
      expect(remaining[0].msg_id).toBe(unread.msg_id);
    } finally {
      h.cleanup();
      clearCaptainInboxSweepStateForTest();
    }
  });
});
