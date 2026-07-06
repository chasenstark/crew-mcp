/**
 * Regression tests for the event-log scan discipline: running-status
 * polls must not re-read the whole log, terminal tails must be served
 * from the size-keyed cache, and terminal/deleted runs must release
 * their cursor and cache entries.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const mockNotifyTerminal = vi.hoisted(() => vi.fn());

vi.mock('../../src/orchestrator/notifications.js', () => ({
  notifyTerminal: mockNotifyTerminal,
}));

import { RunStateStore } from '../../src/orchestrator/run-state.js';

describe('RunStateStore event-log scan discipline', () => {
  let crewHome: string;
  let repoRoot: string;
  let store: RunStateStore;

  beforeEach(() => {
    mockNotifyTerminal.mockClear();
    crewHome = mkdtempSync(join(tmpdir(), 'crew-eventscan-home-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'crew-eventscan-repo-'));
    store = new RunStateStore({ crewHome, repoRoot });
  });

  afterEach(() => {
    rmSync(crewHome, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });

  async function createRun(runId: string): Promise<void> {
    await store.create({
      runId,
      agentId: 'a',
      worktreePath: '/x',
      initialPrompt: 'p',
    });
  }

  it('getEventLineCount pays one full read to seed, then stays incremental', async () => {
    await createRun('r-count');
    store.appendEvent('r-count', 'line one');
    store.appendEvent('r-count', 'line two');

    expect(store.getEventLineCount('r-count')).toBe(2);
    expect(store.eventReadDiagnosticsForTest().fullEventLogReads).toBe(1);

    // Unchanged file: fstat-only fast path, no additional full read.
    expect(store.getEventLineCount('r-count')).toBe(2);
    expect(store.getEventLineCount('r-count')).toBe(2);
    expect(store.eventReadDiagnosticsForTest().fullEventLogReads).toBe(1);

    // Appends are picked up via the byte cursor, still without a full read.
    store.appendEvent('r-count', 'line three');
    expect(store.getEventLineCount('r-count')).toBe(3);
    expect(store.eventReadDiagnosticsForTest().fullEventLogReads).toBe(1);
  });

  it('getEventLineCount stays incremental even when callers previously read from line 0', async () => {
    await createRun('r-mixed');
    store.appendEvent('r-mixed', 'one');

    // A caller-style read from 0 seeds the cursor (one full read)...
    expect(store.readEventsSince('r-mixed', 0).nextLine).toBe(1);
    const seeded = store.eventReadDiagnosticsForTest().fullEventLogReads;

    // ...and subsequent count-only polls never fall back to a full read,
    // even though the documented captain call shape passes no cursor.
    store.appendEvent('r-mixed', 'two');
    expect(store.getEventLineCount('r-mixed')).toBe(2);
    expect(store.getEventLineCount('r-mixed')).toBe(2);
    expect(store.eventReadDiagnosticsForTest().fullEventLogReads).toBe(seeded);
  });

  it('getEventLineCount returns 0 for a run with no events.log', async () => {
    await createRun('r-empty');
    expect(store.getEventLineCount('r-empty')).toBe(0);
    expect(store.eventReadDiagnosticsForTest().fullEventLogReads).toBe(0);
  });

  it('readFilteredTailFromEnd serves repeat reads from the size-keyed cache', async () => {
    await createRun('r-tail');
    store.appendEvent('r-tail', 'assistant text');
    store.appendEvent('r-tail', '[codex] command: started npm test');
    store.appendEvent('r-tail', 'more assistant text');

    const first = store.readFilteredTailFromEnd('r-tail', 10);
    expect(first.lines).toEqual(['assistant text', 'more assistant text']);
    expect(first.totalLineCount).toBe(3);
    expect(first.totalFilteredCount).toBe(2);
    expect(store.eventReadDiagnosticsForTest().terminalTailScans).toBe(1);

    // Same size + same limit: cached, no rescan, identical payload.
    const second = store.readFilteredTailFromEnd('r-tail', 10);
    expect(second).toEqual(first);
    expect(store.eventReadDiagnosticsForTest().terminalTailScans).toBe(1);

    // A different limit is a different projection: one rescan.
    const capped = store.readFilteredTailFromEnd('r-tail', 1);
    expect(capped.lines).toEqual(['more assistant text']);
    expect(store.eventReadDiagnosticsForTest().terminalTailScans).toBe(2);

    // Growth invalidates the size key.
    store.appendEvent('r-tail', 'late line');
    const grown = store.readFilteredTailFromEnd('r-tail', 1);
    expect(grown.lines).toEqual(['late line']);
    expect(grown.totalLineCount).toBe(4);
    expect(store.eventReadDiagnosticsForTest().terminalTailScans).toBe(3);
  });

  it('markTerminal releases the run read cursor; deleteRunDir releases cursor and tail cache', async () => {
    await createRun('r-release');
    store.appendEvent('r-release', 'one');
    expect(store.getEventLineCount('r-release')).toBe(1);
    expect(store.eventReadDiagnosticsForTest().eventReadCursorCount).toBe(1);

    await store.markTerminal('r-release', {
      status: 'success',
      summary: 'done',
      filesChanged: [],
    });
    expect(store.eventReadDiagnosticsForTest().eventReadCursorCount).toBe(0);

    store.readFilteredTailFromEnd('r-release', 10);
    expect(store.eventReadDiagnosticsForTest().terminalTailCacheCount).toBe(1);

    store.deleteRunDir('r-release');
    const after = store.eventReadDiagnosticsForTest();
    expect(after.eventReadCursorCount).toBe(0);
    expect(after.terminalTailCacheCount).toBe(0);
  });
});
