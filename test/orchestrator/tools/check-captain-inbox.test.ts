import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  appendMessage,
  clearCaptainInboxSweepStateForTest,
  inboxRepoDir,
  listMessages,
  transitionMessages,
} from '../../../src/orchestrator/captain-inbox/store.js';
import {
  CAPTAIN_INBOX_BODY_PREVIEW_MAX_CHARS,
  checkCaptainInboxInputSchema,
  checkCaptainInboxToolHandler,
} from '../../../src/orchestrator/tools/check-captain-inbox.js';
import { logger } from '../../../src/utils/logger.js';

function tempRoot(): { readonly crewHome: string; readonly repoRoot: string; readonly cleanup: () => void } {
  const crewHome = mkdtempSync(join(tmpdir(), 'crew-check-inbox-home-'));
  const repoRoot = mkdtempSync(join(tmpdir(), 'crew-check-inbox-repo-'));
  return {
    crewHome,
    repoRoot,
    cleanup: () => {
      rmSync(crewHome, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    },
  };
}

function message(repoRoot: string, index: number, runId = `run-${index}`) {
  return {
    to: { kind: 'captain' as const },
    from: { kind: 'run' as const, run_id: runId, agent_id: 'codex' },
    kind: 'note' as const,
    body: `body ${index}`,
    worker_run_id_at_send: runId,
    worker_agent_id_at_send: 'codex',
    repo_root_at_send: repoRoot,
  };
}

describe('check_captain_inbox', () => {
  it('filters by status, limit, since, and from_run_id while totals ignore filters', async () => {
    clearCaptainInboxSweepStateForTest();
    vi.useFakeTimers({ now: new Date('2026-07-06T01:00:00.000Z') });
    const h = tempRoot();
    try {
      const unreadOld = await appendMessage({
        crewHome: h.crewHome,
        message: message(h.repoRoot, 1, 'run-a'),
        now: new Date('2026-07-06T00:00:01.000Z'),
      });
      const read = await appendMessage({
        crewHome: h.crewHome,
        message: message(h.repoRoot, 2, 'run-b'),
        now: new Date('2026-07-06T00:00:02.000Z'),
      });
      const dismissed = await appendMessage({
        crewHome: h.crewHome,
        message: message(h.repoRoot, 3, 'run-a'),
        now: new Date('2026-07-06T00:00:03.000Z'),
      });
      const unreadNew = await appendMessage({
        crewHome: h.crewHome,
        message: message(h.repoRoot, 4, 'run-b'),
        now: new Date('2026-07-06T00:00:04.000Z'),
      });
      await transitionMessages({
        crewHome: h.crewHome,
        repoRoot: h.repoRoot,
        msgIds: [read.msg_id],
        action: 'read',
        now: new Date('2026-07-06T00:01:00.000Z'),
      });
      await transitionMessages({
        crewHome: h.crewHome,
        repoRoot: h.repoRoot,
        msgIds: [dismissed.msg_id],
        action: 'dismiss',
        now: new Date('2026-07-06T00:01:00.000Z'),
      });

      const defaults = await checkCaptainInboxToolHandler(
        checkCaptainInboxInputSchema.parse({}),
        { crewHome: h.crewHome, projectRoot: h.repoRoot },
      );
      expect(defaults.structuredContent).toMatchObject({
        messages: [
          expect.objectContaining({ msg_id: unreadNew.msg_id }),
          expect.objectContaining({ msg_id: unreadOld.msg_id }),
        ],
        message_detail: 'compact',
        total_unread: 2,
        total_in_inbox: 4,
        oldest_unread_at: unreadOld.created_at,
      });

      const allLimited = await checkCaptainInboxToolHandler(
        checkCaptainInboxInputSchema.parse({ status: 'all', limit: 2 }),
        { crewHome: h.crewHome, projectRoot: h.repoRoot },
      );
      expect((allLimited.structuredContent?.messages as Array<{ msg_id: string }>).map((m) => m.msg_id))
        .toEqual([unreadNew.msg_id, dismissed.msg_id]);

      const readOnly = await checkCaptainInboxToolHandler(
        checkCaptainInboxInputSchema.parse({ status: 'read' }),
        { crewHome: h.crewHome, projectRoot: h.repoRoot },
      );
      expect((readOnly.structuredContent?.messages as Array<{ msg_id: string }>).map((m) => m.msg_id))
        .toEqual([read.msg_id]);

      const dismissedOnly = await checkCaptainInboxToolHandler(
        checkCaptainInboxInputSchema.parse({ status: 'dismissed' }),
        { crewHome: h.crewHome, projectRoot: h.repoRoot },
      );
      expect((dismissedOnly.structuredContent?.messages as Array<{ msg_id: string }>).map((m) => m.msg_id))
        .toEqual([dismissed.msg_id]);

      const sinceAndRun = await checkCaptainInboxToolHandler(
        checkCaptainInboxInputSchema.parse({
          status: 'all',
          since: '2026-07-06T00:00:03.000Z',
          from_run_id: 'run-b',
        }),
        { crewHome: h.crewHome, projectRoot: h.repoRoot },
      );
      expect((sinceAndRun.structuredContent?.messages as Array<{ msg_id: string }>).map((m) => m.msg_id))
        .toEqual([unreadNew.msg_id]);
      expect(sinceAndRun.structuredContent).toMatchObject({ total_unread: 2, total_in_inbox: 4 });
      expect(sinceAndRun.structuredContent).toMatchObject({ message_detail: 'full' });
    } finally {
      vi.useRealTimers();
      h.cleanup();
      clearCaptainInboxSweepStateForTest();
    }
  });

  it('returns compact body previews by default and full bodies for a scoped run', async () => {
    clearCaptainInboxSweepStateForTest();
    const h = tempRoot();
    try {
      const tail = ' full-body-tail';
      const fullBody = `${'x'.repeat((16 * 1024) - tail.length)}${tail}`;
      const stored = await appendMessage({
        crewHome: h.crewHome,
        message: {
          ...message(h.repoRoot, 1, 'run-large'),
          body: fullBody,
        },
      });

      const defaults = await checkCaptainInboxToolHandler(
        checkCaptainInboxInputSchema.parse({}),
        { crewHome: h.crewHome, projectRoot: h.repoRoot },
      );
      const defaultText = defaults.content[0].text;
      expect(defaultText).toContain(`msg_id=${stored.msg_id}`);
      expect(defaultText).toContain('from.run_id=run-large');
      expect(defaultText).toContain('agent=codex');
      expect(defaultText).toContain('kind=note');
      expect(defaultText).toContain(`created_at=${stored.created_at}`);
      expect(defaultText).toContain('[body_truncated ');
      expect(defaultText).not.toContain('full-body-tail');
      expect(defaultText).not.toContain(fullBody);
      expect(defaultText).not.toContain('"messages":');
      expect(defaultText.length).toBeLessThan(1_000);
      expect(defaults.structuredContent).toMatchObject({
        message_detail: 'compact',
        messages: [{
          msg_id: stored.msg_id,
          body_preview_truncated: true,
          body_preview_omitted_chars: expect.any(Number),
        }],
      });
      const [defaultMessage] = defaults.structuredContent?.messages as Array<Record<string, unknown>>;
      expect(defaultMessage).not.toHaveProperty('body');
      expect(defaultMessage.body_preview).toHaveLength(CAPTAIN_INBOX_BODY_PREVIEW_MAX_CHARS);

      const scoped = await checkCaptainInboxToolHandler(
        checkCaptainInboxInputSchema.parse({ from_run_id: 'run-large' }),
        { crewHome: h.crewHome, projectRoot: h.repoRoot },
      );
      expect(scoped.structuredContent).toMatchObject({
        message_detail: 'full',
        messages: [{ msg_id: stored.msg_id, body: fullBody }],
      });
      expect(scoped.content[0].text).not.toContain('full-body-tail');
    } finally {
      h.cleanup();
      clearCaptainInboxSweepStateForTest();
    }
  });

  it('returns the newest unread messages when unread exceeds the limit', async () => {
    clearCaptainInboxSweepStateForTest();
    const h = tempRoot();
    try {
      const unread = [];
      for (let index = 1; index <= 4; index += 1) {
        unread.push(await appendMessage({
          crewHome: h.crewHome,
          message: message(h.repoRoot, index),
          now: new Date(`2026-07-06T00:00:0${index}.000Z`),
        }));
      }

      const result = await checkCaptainInboxToolHandler(
        checkCaptainInboxInputSchema.parse({ limit: 2 }),
        { crewHome: h.crewHome, projectRoot: h.repoRoot },
      );
      expect((result.structuredContent?.messages as Array<{ msg_id: string }>).map((m) => m.msg_id))
        .toEqual([unread[3].msg_id, unread[2].msg_id]);
      expect(result.content[0].text).toContain(`msg_id=${unread[3].msg_id}`);
      expect(result.content[0].text).not.toContain(`msg_id=${unread[0].msg_id}`);
    } finally {
      h.cleanup();
      clearCaptainInboxSweepStateForTest();
    }
  });

  it('rejects invalid ISO since filters at schema validation', () => {
    expect(checkCaptainInboxInputSchema.safeParse({ since: 'not-a-date' }).success).toBe(false);
  });

  it('uses time comparisons for sub-second and offset since filters', async () => {
    clearCaptainInboxSweepStateForTest();
    const h = tempRoot();
    try {
      const before = await appendMessage({
        crewHome: h.crewHome,
        message: message(h.repoRoot, 1),
        now: new Date('2026-07-06T11:59:59.999Z'),
      });
      const afterSubsecond = await appendMessage({
        crewHome: h.crewHome,
        message: message(h.repoRoot, 2),
        now: new Date('2026-07-06T12:00:00.500Z'),
      });

      const subsecond = await checkCaptainInboxToolHandler(
        checkCaptainInboxInputSchema.parse({
          status: 'all',
          since: '2026-07-06T12:00:00Z',
        }),
        { crewHome: h.crewHome, projectRoot: h.repoRoot },
      );
      expect((subsecond.structuredContent?.messages as Array<{ msg_id: string }>).map((m) => m.msg_id))
        .toEqual([afterSubsecond.msg_id]);

      const offset = await checkCaptainInboxToolHandler(
        checkCaptainInboxInputSchema.parse({
          status: 'all',
          since: '2026-07-06T08:00:00-04:00',
        }),
        { crewHome: h.crewHome, projectRoot: h.repoRoot },
      );
      expect((offset.structuredContent?.messages as Array<{ msg_id: string }>).map((m) => m.msg_id))
        .toEqual([afterSubsecond.msg_id]);
      expect((offset.structuredContent?.messages as Array<{ msg_id: string }>).map((m) => m.msg_id))
        .not.toContain(before.msg_id);
    } finally {
      h.cleanup();
      clearCaptainInboxSweepStateForTest();
    }
  });

  it('does not block or fail reads when the opportunistic sweep cannot acquire the lock', async () => {
    clearCaptainInboxSweepStateForTest();
    const previousTimeout = process.env.CREW_CAPTAIN_INBOX_LOCK_TIMEOUT_MS;
    process.env.CREW_CAPTAIN_INBOX_LOCK_TIMEOUT_MS = '1';
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const h = tempRoot();
    try {
      const unread = await appendMessage({
        crewHome: h.crewHome,
        message: message(h.repoRoot, 1),
      });
      mkdirSync(join(inboxRepoDir(h.crewHome, h.repoRoot), '.lock'));

      const startedAt = Date.now();
      const result = await checkCaptainInboxToolHandler(
        checkCaptainInboxInputSchema.parse({}),
        { crewHome: h.crewHome, projectRoot: h.repoRoot },
      );

      expect(Date.now() - startedAt).toBeLessThan(100);
      expect((result.structuredContent?.messages as Array<{ msg_id: string }>).map((m) => m.msg_id))
        .toEqual([unread.msg_id]);
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('captain inbox sweep: failed'));
    } finally {
      if (previousTimeout === undefined) delete process.env.CREW_CAPTAIN_INBOX_LOCK_TIMEOUT_MS;
      else process.env.CREW_CAPTAIN_INBOX_LOCK_TIMEOUT_MS = previousTimeout;
      warnSpy.mockRestore();
      h.cleanup();
      clearCaptainInboxSweepStateForTest();
    }
  });

  it('does not mutate message status when reading', async () => {
    clearCaptainInboxSweepStateForTest();
    const h = tempRoot();
    try {
      const unread = await appendMessage({
        crewHome: h.crewHome,
        message: message(h.repoRoot, 1),
      });

      await checkCaptainInboxToolHandler(
        checkCaptainInboxInputSchema.parse({ status: 'all' }),
        { crewHome: h.crewHome, projectRoot: h.repoRoot },
      );

      expect(listMessages({ crewHome: h.crewHome, repoRoot: h.repoRoot })).toMatchObject([
        { msg_id: unread.msg_id, status: 'unread' },
      ]);
    } finally {
      h.cleanup();
      clearCaptainInboxSweepStateForTest();
    }
  });
});
