import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { main, usage } from '../../src/cli/pr-watch.js';
import { sha256Canonical } from '../../src/pr-watch/canonical.js';
import { makePrWatchId, makePrWatchTransactionId } from '../../src/pr-watch/id.js';
import { appendPrWatchPollLog, type PrWatchPollLogRecordV1 } from '../../src/pr-watch/poll-log.js';
import { createInitialPrWatchState } from '../../src/pr-watch/reducer.js';
import { PrWatchStore } from '../../src/pr-watch/store.js';

describe('crew-pr-watch polls', () => {
  const cleanup: string[] = [];
  const restores: Array<() => void> = [];
  afterEach(() => {
    for (const restore of restores.splice(0)) restore();
    for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it('prints a summary and table by default and raw records with --json', async () => {
    const { crewHome, store, watchId } = await createWatch();
    cleanup.push(crewHome);
    const previous = process.env.CREW_HOME;
    process.env.CREW_HOME = crewHome;
    restores.push(() => {
      if (previous === undefined) delete process.env.CREW_HOME;
      else process.env.CREW_HOME = previous;
    });
    const watchDir = store.watchDir(watchId);
    const now = Date.now();
    appendPrWatchPollLog(watchDir, record(watchId, { ts: new Date(now - 4 * 60_000).toISOString(), mode: 'full', queryCost: 53 }));
    appendPrWatchPollLog(watchDir, record(watchId, { ts: new Date(now - 2 * 60_000).toISOString(), mode: 'probe', queryCost: 2 }));
    appendPrWatchPollLog(watchDir, record(watchId, { ts: new Date(now).toISOString(), mode: 'partial', queryCost: 5, dirtyCount: 1, dirtyPrNumbers: [7] }));

    expect(usage()).toContain('polls');
    let stdout = captureStdout(restores);
    expect(await main(['polls', watchId, '--tail', '2'])).toBe(0);
    const text = stdout();
    expect(text).toContain('polls, 7 points');
    expect(text).toContain('mode');
    const rows = text.split('\n').filter((line) => /^\d{4}-\d{2}-\d{2} /.test(line));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.split(/\s+/)[2])).toEqual(['probe', 'partial']);

    stdout = captureStdout(restores);
    expect(await main(['polls', watchId, '--json'])).toBe(0);
    const parsed = JSON.parse(stdout()) as PrWatchPollLogRecordV1[];
    expect(parsed.map((entry) => entry.mode)).toEqual(['full', 'probe', 'partial']);

    expect(await main(['polls', watchId, '--tail', '0'])).toBe(2);
    expect(await main(['polls', watchId, '--nope'])).toBe(2);
  });
});

async function createWatch() {
  const crewHome = mkdtempSync(join(tmpdir(), 'crew-pr-watch-cli-'));
  const store = new PrWatchStore(crewHome);
  const watchId = makePrWatchId();
  const initial = createInitialPrWatchState({
    watchId,
    initialization: {
      repository: 'example/repo',
      anchorPrNumber: 1,
      repoRoot: '/tmp/example',
      effectiveConfig: {
        maxPrs: 50,
        maxActionableWakes: 20,
        maxActionRounds: 5,
        maxWatchAgeDays: -1,
        policyHash: sha256Canonical({ mode: 'github_rules' }),
      },
      expectedHeads: { '1': 'abc123' },
    },
  });
  await store.create(initial, makePrWatchTransactionId());
  return { crewHome, store, watchId };
}

function record(watchId: string, overrides: Partial<PrWatchPollLogRecordV1>): PrWatchPollLogRecordV1 {
  return {
    v: 1,
    ts: '2026-09-02T12:00:00.000Z',
    watchId,
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

function captureStdout(restores: Array<() => void>): () => string {
  const original = process.stdout.write;
  let captured = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  restores.push(() => {
    process.stdout.write = original;
  });
  return () => captured;
}
