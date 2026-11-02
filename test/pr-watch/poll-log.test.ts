import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  PR_WATCH_POLL_LOG_FILE,
  PR_WATCH_POLL_LOG_ROTATED_FILE,
  appendPrWatchPollLog,
  readPrWatchPollLog,
  renderPrWatchPollSummary,
  renderPrWatchPollTable,
  summarizePrWatchPolls,
  type PrWatchPollLogRecordV1,
} from '../../src/pr-watch/poll-log.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('PR-watch poll log', () => {
  it('appends one line per poll and reads back the newest records, skipping torn lines', () => {
    const dir = tempDir();
    expect(readPrWatchPollLog(dir)).toEqual([]);
    expect(appendPrWatchPollLog(dir, record({ ts: '2026-09-02T12:00:00.000Z', mode: 'full' }))).toBe(true);
    expect(appendPrWatchPollLog(dir, record({ ts: '2026-09-02T12:02:00.000Z', mode: 'probe' }))).toBe(true);
    writeFileSync(join(dir, PR_WATCH_POLL_LOG_FILE), '{"v":1,"ts":"torn', { flag: 'a' });
    expect(appendPrWatchPollLog(dir, record({ ts: '2026-09-02T12:04:00.000Z', mode: 'partial' }))).toBe(true);
    const all = readPrWatchPollLog(dir);
    // The torn fragment glued itself onto the next line; that line is dropped, not the file.
    expect(all.map((entry) => entry.mode)).toEqual(['full', 'probe']);
    expect(readPrWatchPollLog(dir, { tail: 1 }).map((entry) => entry.mode)).toEqual(['probe']);
    expect(appendPrWatchPollLog(join(dir, 'missing'), record({}))).toBe(false);
  });

  it('reads only the tail of a large file and rotates once past the cap', () => {
    const dir = tempDir();
    const path = join(dir, PR_WATCH_POLL_LOG_FILE);
    const line = `${JSON.stringify(record({ ts: '2026-09-02T12:00:00.000Z' }))}\n`;
    writeFileSync(path, line.repeat(200));
    const tail = readPrWatchPollLog(dir, { maxBytes: line.length * 3 + 10 });
    expect(tail.length).toBe(3);
    writeFileSync(path, 'x'.repeat(8 * 1024 * 1024));
    expect(appendPrWatchPollLog(dir, record({ ts: '2026-09-02T13:00:00.000Z' }))).toBe(true);
    expect(statSync(join(dir, PR_WATCH_POLL_LOG_ROTATED_FILE)).size).toBe(8 * 1024 * 1024);
    expect(readFileSync(path, 'utf-8').split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('summarizes a window by mode, spend, dirtiness, latency, and outcomes', () => {
    const now = new Date('2026-09-02T13:00:00.000Z');
    const records = [
      record({ ts: '2026-09-02T11:30:00.000Z', mode: 'full', queryCost: 53, apiCalls: 1 }),
      record({ ts: '2026-09-02T12:10:00.000Z', mode: 'full', queryCost: 53, apiCalls: 1, observeMs: 9000, totalMs: 9500 }),
      record({ ts: '2026-09-02T12:12:00.000Z', mode: 'probe', queryCost: 2, apiCalls: 1, observeMs: 5000, totalMs: 5200, rateRemaining: 4800 }),
      record({ ts: '2026-09-02T12:14:00.000Z', mode: 'partial', queryCost: 5, apiCalls: 2, dirtyCount: 2, observeMs: 8000, totalMs: 8300, status: 'actionable', rateRemaining: 4790 }),
      record({ ts: '2026-09-02T12:16:00.000Z', mode: 'probe', queryCost: 55, apiCalls: 2, forcedRefresh: true, observeMs: 14000, totalMs: 14400 }),
      record({ ts: '2026-09-02T12:18:00.000Z', status: 'blocked', blockerKind: 'provider_timeout', error: 'pr_watch.transition_timeout', apiCalls: 0, queryCost: 0, probeCost: 0, observeMs: 60000, totalMs: 60100 }),
    ];
    const summary = summarizePrWatchPolls(records, { now });
    expect(summary).toEqual({
      windowMs: 3_600_000,
      polls: 5,
      points: 115,
      apiCalls: 6,
      byMode: { full: 1, probe: 2, partial: 1 },
      forcedRefreshes: 1,
      dirtyPrTotal: 2,
      avgObserveMs: 19200,
      maxObserveMs: 60000,
      avgTotalMs: 19500,
      actionable: 1,
      blocked: 1,
      errors: 1,
      lastRateRemaining: 4790,
    });
    const text = renderPrWatchPollSummary(summary);
    expect(text).toContain('last 60 min: 5 polls, 115 points, 6 calls');
    expect(text).toContain('forced re-reads 1');
    const table = renderPrWatchPollTable(records.slice(-3));
    expect(table.split('\n')).toHaveLength(4);
    expect(table).toContain('partial');
    expect(table).toContain('error: pr_watch.transition_timeout');
  });
});

function record(overrides: Partial<PrWatchPollLogRecordV1>): PrWatchPollLogRecordV1 {
  return {
    v: 1,
    ts: '2026-09-02T12:00:00.000Z',
    watchId: 'pw-00000000000000000000000000000000',
    generation: 1,
    prCount: 50,
    forcedRefresh: false,
    apiCalls: 1,
    queryCost: 1,
    probeCost: 1,
    detailCost: 0,
    dirtyCount: 0,
    dirtyPrNumbers: [],
    cachePersisted: true,
    projectedPollCost: 9,
    observeMs: 100,
    totalMs: 120,
    status: 'active',
    ...overrides,
  };
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-pr-watch-poll-log-'));
  roots.push(dir);
  return dir;
}
