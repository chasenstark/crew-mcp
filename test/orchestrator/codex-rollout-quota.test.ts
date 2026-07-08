import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  CODEX_ROLLOUT_TAIL_BYTES,
  codexRolloutQuotaSnapshot,
  lastRateLimitsFromTail,
  quotaSnapshotFromRateLimits,
  seedCodexRolloutQuota,
} from '../../src/orchestrator/codex-rollout-quota.js';
import { QuotaCache } from '../../src/orchestrator/quota-cache.js';
import type { QuotaSnapshot } from '../../src/orchestrator/tools/index.js';

const THREAD_ID = '0198f2b4-1111-2222-3333-444455556666';
const NOW = '2026-07-07T12:00:00.000Z';

function tokenCountLine(args: {
  primaryPercent?: number;
  primaryResetsAt?: number;
  secondaryPercent?: number;
  secondaryResetsAt?: number;
  planType?: string;
}): string {
  return JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: {}, last_token_usage: {}, model_context_window: 258400 },
      rate_limits: {
        limit_id: 'codex',
        plan_type: args.planType ?? 'prolite',
        rate_limit_reached_type: null,
        ...(args.primaryPercent !== undefined
          ? {
              primary: {
                used_percent: args.primaryPercent,
                window_minutes: 300,
                resets_at: args.primaryResetsAt ?? 1783533600,
              },
            }
          : {}),
        ...(args.secondaryPercent !== undefined
          ? {
              secondary: {
                used_percent: args.secondaryPercent,
                window_minutes: 10080,
                resets_at: args.secondaryResetsAt ?? 1784116800,
              },
            }
          : {}),
      },
    },
  });
}

describe('codex rollout quota', () => {
  let codexHome: string;
  let sessionDay: string;

  beforeEach(() => {
    codexHome = mkdtempSync(join(tmpdir(), 'crew-codex-home-'));
    sessionDay = join(codexHome, 'sessions', '2026', '07', '07');
    mkdirSync(sessionDay, { recursive: true });
  });

  afterEach(() => {
    rmSync(codexHome, { recursive: true, force: true });
  });

  function writeRollout(lines: string[], threadId = THREAD_ID): string {
    const path = join(sessionDay, `rollout-2026-07-07T10-00-00-${threadId}.jsonl`);
    writeFileSync(path, `${lines.join('\n')}\n`, 'utf-8');
    return path;
  }

  it('parses the LAST token_count rate_limits from a nested rollout', async () => {
    writeRollout([
      JSON.stringify({ type: 'session_meta', payload: { id: THREAD_ID } }),
      tokenCountLine({ primaryPercent: 10, secondaryPercent: 5 }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message' } }),
      tokenCountLine({ primaryPercent: 37.5, secondaryPercent: 12, planType: 'prolite' }),
    ]);

    const snapshot = await codexRolloutQuotaSnapshot({
      threadId: THREAD_ID,
      codexHome,
      now: NOW,
    });
    expect(snapshot).toBeDefined();
    expect(snapshot?.state).toBe('ok');
    expect(snapshot?.usedPercent).toBe(37.5);
    expect(snapshot?.confidence).toBe('medium');
    expect(snapshot?.source).toBe('session-file');
    expect(snapshot?.checkedAt).toBe(NOW);
    expect(snapshot?.resetAt).toBe(new Date(1783533600 * 1000).toISOString());
    expect(snapshot?.message).toContain('5h 37.5% used');
    expect(snapshot?.message).toContain('weekly 12% used');
    expect(snapshot?.message).toContain('plan prolite');
  });

  it('the worst window governs state; near_limit and limited thresholds apply', async () => {
    writeRollout([tokenCountLine({ primaryPercent: 12, secondaryPercent: 91 })]);
    const near = await codexRolloutQuotaSnapshot({ threadId: THREAD_ID, codexHome, now: NOW });
    expect(near?.state).toBe('near_limit');
    expect(near?.usedPercent).toBe(91);
    // Governing window is the weekly one → its reset is the resetAt.
    expect(near?.resetAt).toBe(new Date(1784116800 * 1000).toISOString());

    writeRollout([tokenCountLine({ primaryPercent: 100, secondaryPercent: 40 })]);
    const limited = await codexRolloutQuotaSnapshot({ threadId: THREAD_ID, codexHome, now: NOW });
    expect(limited?.state).toBe('limited');
  });

  it('staleAfter is the EARLIEST window reset (numbers change at that boundary)', async () => {
    const primaryReset = 1783533600;
    const secondaryReset = 1784116800;
    writeRollout([tokenCountLine({
      primaryPercent: 10,
      primaryResetsAt: primaryReset,
      secondaryPercent: 55,
      secondaryResetsAt: secondaryReset,
    })]);
    const snapshot = await codexRolloutQuotaSnapshot({ threadId: THREAD_ID, codexHome, now: NOW });
    expect(snapshot?.staleAfter).toBe(new Date(primaryReset * 1000).toISOString());
  });

  it('returns undefined when the rollout is absent, the thread differs, or the id is implausible', async () => {
    writeRollout([tokenCountLine({ primaryPercent: 10 })], 'ffffffff-aaaa-bbbb-cccc-000000000000');
    expect(await codexRolloutQuotaSnapshot({ threadId: THREAD_ID, codexHome, now: NOW }))
      .toBeUndefined();
    expect(await codexRolloutQuotaSnapshot({
      threadId: '../../../etc/passwd',
      codexHome,
      now: NOW,
    })).toBeUndefined();
    expect(await codexRolloutQuotaSnapshot({
      threadId: THREAD_ID,
      codexHome: join(codexHome, 'does-not-exist'),
      now: NOW,
    })).toBeUndefined();
  });

  it('schema drift fails soft: token_count without parseable windows yields undefined', async () => {
    writeRollout([
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'token_count', info: {}, rate_limits: { primary: { used_percent: 'lots' } } },
      }),
      'not json at all',
    ]);
    expect(await codexRolloutQuotaSnapshot({ threadId: THREAD_ID, codexHome, now: NOW }))
      .toBeUndefined();
  });

  it('skips a trailing malformed token_count and uses the previous valid one', () => {
    const tail = [
      tokenCountLine({ primaryPercent: 42 }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {} } }),
      '{"truncated": ',
    ].join('\n');
    expect(lastRateLimitsFromTail(tail)?.primary?.usedPercent).toBe(42);
  });

  it('only reads the tail — an event buried beyond the window is not found', async () => {
    const filler = JSON.stringify({ type: 'response_item', payload: { pad: 'x'.repeat(1024) } });
    const lines = [tokenCountLine({ primaryPercent: 10 })];
    const fillerCount = Math.ceil(CODEX_ROLLOUT_TAIL_BYTES / filler.length) + 16;
    for (let i = 0; i < fillerCount; i += 1) lines.push(filler);
    writeRollout(lines);
    expect(await codexRolloutQuotaSnapshot({ threadId: THREAD_ID, codexHome, now: NOW }))
      .toBeUndefined();
  });

  it('resolves ${CODEX_HOME} from env when no explicit home is given', async () => {
    writeRollout([tokenCountLine({ primaryPercent: 10 })]);
    const snapshot = await codexRolloutQuotaSnapshot({
      threadId: THREAD_ID,
      env: { CODEX_HOME: codexHome },
      now: NOW,
    });
    expect(snapshot?.usedPercent).toBe(10);
  });

  describe('seedCodexRolloutQuota', () => {
    it('records a snapshot for codex terminal runs', async () => {
      writeRollout([tokenCountLine({ primaryPercent: 65 })]);
      const cache = new QuotaCache();
      await seedCodexRolloutQuota(cache, {
        agentId: 'codex',
        threadId: THREAD_ID,
        codexHome,
        now: NOW,
      });
      const snapshot = cache.get('codex', { now: NOW });
      expect(snapshot?.usedPercent).toBe(65);
      expect(snapshot?.source).toBe('session-file');
    });

    it('does nothing for non-codex agents', async () => {
      writeRollout([tokenCountLine({ primaryPercent: 65 })]);
      const cache = new QuotaCache();
      await seedCodexRolloutQuota(cache, {
        agentId: 'claude-code',
        threadId: THREAD_ID,
        codexHome,
        now: NOW,
      });
      expect(cache.get('claude-code', { now: NOW })).toBeUndefined();
    });

    it('never downgrades a reactive limited snapshot with an ok rollout read', async () => {
      writeRollout([tokenCountLine({ primaryPercent: 20 })]);
      const cache = new QuotaCache();
      const limited: QuotaSnapshot = {
        state: 'limited',
        confidence: 'high',
        source: 'local-ledger',
        checkedAt: NOW,
      };
      cache.record('codex', limited);
      await seedCodexRolloutQuota(cache, {
        agentId: 'codex',
        threadId: THREAD_ID,
        codexHome,
        now: NOW,
      });
      expect(cache.get('codex', { now: NOW })).toEqual(limited);
    });

    it('overwrites a limited snapshot when the rollout ALSO says limited (fresher numbers)', async () => {
      writeRollout([tokenCountLine({ primaryPercent: 100 })]);
      const cache = new QuotaCache();
      cache.record('codex', {
        state: 'limited',
        confidence: 'high',
        source: 'local-ledger',
        checkedAt: NOW,
      });
      await seedCodexRolloutQuota(cache, {
        agentId: 'codex',
        threadId: THREAD_ID,
        codexHome,
        now: NOW,
      });
      expect(cache.get('codex', { now: NOW })?.usedPercent).toBe(100);
    });
  });

  describe('quotaSnapshotFromRateLimits', () => {
    it('falls back to checkedAt + 1h staleness when no window carries a reset', () => {
      const snapshot = quotaSnapshotFromRateLimits(
        { primary: { usedPercent: 5 } },
        NOW,
      );
      expect(snapshot.staleAfter).toBe('2026-07-07T13:00:00.000Z');
      expect(snapshot.resetAt).toBeUndefined();
    });
  });
});
