/**
 * Unit tests for the per-run state store.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const mockNotifyTerminal = vi.hoisted(() => vi.fn());

vi.mock('../../src/orchestrator/notifications.js', () => ({
  notifyTerminal: mockNotifyTerminal,
}));

import { RunStateStore } from '../../src/orchestrator/run-state.js';
import { filterEventsTailNoise } from '../../src/orchestrator/events-filter.js';
import { logger } from '../../src/utils/logger.js';

describe('RunStateStore', () => {
  let crewHome: string;
  let repoRoot: string;
  let store: RunStateStore;

  beforeEach(() => {
    mockNotifyTerminal.mockClear();
    crewHome = mkdtempSync(join(tmpdir(), 'crew-runstate-home-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'crew-runstate-repo-'));
    store = new RunStateStore({ crewHome, repoRoot });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(crewHome, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('create() writes a state.json with status: running under crewHome/runs/', () => {
    const state = store.create({
      runId: 'r-1',
      agentId: 'mock-coder',
      worktreePath: '/tmp/wt',
      initialPrompt: 'do a thing',
    });
    expect(state.status).toBe('running');
    expect(state.prompts).toHaveLength(1);
    expect(state.prompts[0].turn).toBe(1);
    expect(state.prompts[0].prompt).toBe('do a thing');
    expect(existsSync(join(crewHome, 'runs', 'r-1', 'state.json'))).toBe(true);
  });

  it('create() persists repoRoot (symlink-resolved) on the state', () => {
    const state = store.create({
      runId: 'r-1',
      agentId: 'a',
      worktreePath: '/x',
      initialPrompt: 'p',
    });
    // realpath because macOS tmpdir is a symlink (/var/... → /private/var/...)
    expect(state.repoRoot).toBe(realpathSync(repoRoot));
  });

  it('create() does NOT write under the host repoRoot (host repo stays clean)', () => {
    store.create({
      runId: 'r-1',
      agentId: 'a',
      worktreePath: '/x',
      initialPrompt: 'p',
    });
    expect(existsSync(join(repoRoot, '.crew'))).toBe(false);
  });

  it('create() drops an executable tail.command helper next to events.log', () => {
    // The tail.command file is the user-facing progress channel — a
    // tiny shell script that, when opened (macOS double-click /
    // Linux `bash <path>`), follows the run's events.log live in a
    // side terminal. We assert: existence, expected path
    // (`tailCommandPath` returns the canonical location), executable
    // bit, shebang, and that the embedded path matches the run's
    // events.log.
    store.create({
      runId: 'r-1',
      agentId: 'a',
      worktreePath: '/x',
      initialPrompt: 'p',
    });
    const tailPath = store.tailCommandPath('r-1');
    expect(tailPath).toBe(join(crewHome, 'runs', 'r-1', 'tail.command'));
    expect(existsSync(tailPath)).toBe(true);
    expect(statSync(tailPath).mode & 0o100).toBe(0o100);

    const contents = readFileSync(tailPath, 'utf-8');
    expect(contents.startsWith('#!/bin/bash\n')).toBe(true);
    expect(contents).toContain(`exec tail -F '${store.eventsLogPath('r-1')}'`);
  });

  it('tail.command embeds the events.log path with single-quote escaping', () => {
    // Defense against a run id that contains a single quote (rare but
    // not impossible if a future runId scheme uses unusual characters).
    // The script wraps the path in single quotes and `'\''` -escapes
    // any quote in the path itself.
    const trickyRunId = "r'1";
    store.create({
      runId: trickyRunId,
      agentId: 'a',
      worktreePath: '/x',
      initialPrompt: 'p',
    });
    const tailPath = store.tailCommandPath(trickyRunId);
    const contents = readFileSync(tailPath, 'utf-8');
    // The single quote in the runId becomes part of the events.log
    // path, which is then `'\''`-escaped inside the outer single
    // quotes — confirming the path can't break out of the quoting.
    expect(contents).toContain("'\\''");
    // Sanity: the script can be parsed by bash without breaking out
    // of the quoting (bash -n).
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:child_process').execSync(`bash -n ${JSON.stringify(tailPath)}`);
    }).not.toThrow();
  });

  it('logs tail.command helper write failures without aborting dispatch', () => {
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const runId = 'blocked';
    writeFileSync(join(crewHome, 'runs', runId), 'not a directory', 'utf-8');

    expect(() => {
      (store as unknown as { writeTailCommandHelper(runId: string): void })
        .writeTailCommandHelper(runId);
    }).not.toThrow();
    expect(debug).toHaveBeenCalledWith(
      'Failed to write tail.command helper',
      expect.objectContaining({
        runId,
        tailPath: store.tailCommandPath(runId),
      }),
    );
  });

  it('read() returns undefined for unknown runs', () => {
    expect(store.read('nope')).toBeUndefined();
  });

  it('read() propagates non-ENOENT read errors', () => {
    store.create({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
    chmodSync(join(crewHome, 'runs', 'r-1', 'state.json'), 0o000);

    expect(() => store.read('r-1')).toThrow(/EACCES|permission/i);
  });

  it('read() throws for unknown schemaVersion', () => {
    store.create({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
    writeFileSync(
      join(crewHome, 'runs', 'r-1', 'state.json'),
      JSON.stringify({ schemaVersion: 99 }),
      'utf-8',
    );
    expect(() => store.read('r-1')).toThrow(/schemaVersion/);
  });

  it('read() tolerates legacy v1 records without repoRoot (no throw, undefined field)', () => {
    store.create({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
    writeFileSync(
      join(crewHome, 'runs', 'r-1', 'state.json'),
      JSON.stringify({
        schemaVersion: 1,
        runId: 'r-1',
        agentId: 'a',
        status: 'running',
        startedAt: '2026-05-04T00:00:00Z',
        worktreePath: '/x',
        prompts: [{ turn: 1, prompt: 'p', startedAt: '2026-05-04T00:00:00Z' }],
        filesChanged: [],
      }),
      'utf-8',
    );
    const state = store.read('r-1');
    expect(state).toBeDefined();
    expect(state?.repoRoot).toBeUndefined();
  });

  it('appendPrompt() resets status to running and grows prompts', () => {
    store.create({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'first' });
    store.markTerminal('r-1', { status: 'success', summary: 'ok', filesChanged: [] });
    const next = store.appendPrompt('r-1', 'second');
    expect(next.status).toBe('running');
    expect(next.completedAt).toBeUndefined();
    expect(next.prompts).toHaveLength(2);
    expect(next.prompts[1].turn).toBe(2);
    expect(next.prompts[1].prompt).toBe('second');
  });

  it('create() truncates oversized initial prompts with a marker (Tier 3 #14)', () => {
    // 20 KB prompt — exceeds the 16 KB default cap.
    const oversized = 'x'.repeat(20_480);
    store.create({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: oversized });
    const state = store.read('r-1');
    expect(state).toBeDefined();
    const stored = state!.prompts[0].prompt;
    // Bounded by the 16 KB cap (small slop for the appended marker).
    expect(stored.length).toBeLessThanOrEqual(16 * 1024);
    expect(stored).toMatch(/\[\.\.\. truncated for storage; original was \d+ bytes\]$/);
    // Prefix preserved.
    expect(stored.startsWith('xxxxxxxxxx')).toBe(true);
  });

  it('appendPrompt() truncates oversized continuation prompts with a marker (Tier 3 #14)', () => {
    store.create({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'first' });
    store.markTerminal('r-1', { status: 'success', summary: 'ok', filesChanged: [] });
    const oversized = 'y'.repeat(20_480);
    const next = store.appendPrompt('r-1', oversized);
    const stored = next.prompts[1].prompt;
    expect(stored.length).toBeLessThanOrEqual(16 * 1024);
    expect(stored).toMatch(/\[\.\.\. truncated for storage; original was \d+ bytes\]$/);
    expect(stored.startsWith('yyyyyyyyyy')).toBe(true);
    // First prompt was small and untouched.
    expect(next.prompts[0].prompt).toBe('first');
  });

  it('truncate is configurable via CREW_PROMPT_STORAGE_CAP_CHARS (0 disables)', () => {
    const original = process.env.CREW_PROMPT_STORAGE_CAP_CHARS;
    try {
      process.env.CREW_PROMPT_STORAGE_CAP_CHARS = '0';
      const big = 'z'.repeat(20_480);
      store.create({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: big });
      const state = store.read('r-1');
      expect(state!.prompts[0].prompt).toBe(big);
      expect(state!.prompts[0].prompt).not.toMatch(/truncated for storage/);
    } finally {
      if (original === undefined) delete process.env.CREW_PROMPT_STORAGE_CAP_CHARS;
      else process.env.CREW_PROMPT_STORAGE_CAP_CHARS = original;
    }
  });

  it('appendPrompt() refreshes serverPid to the current process (continue_run sweeper safety)', () => {
    // Regression: continued runs were carrying the original (possibly
    // dead) server's serverPid forward. A sibling crew-mcp serve
    // startup would then run the sweeper, see a stale PID on a
    // currently-active continuation, and mark it "abandoned (server
    // restart)" mid-execution.
    store.create({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'first' });
    // Manually overwrite serverPid to simulate a dead PID inherited
    // from a prior server that completed the run before crashing.
    const DEAD_PID = 2_000_000_000;
    const promotedToDead = store.update('r-1', (s) => ({ ...s, serverPid: DEAD_PID }));
    expect(promotedToDead.serverPid).toBe(DEAD_PID);

    store.markTerminal('r-1', { status: 'success', summary: 'ok', filesChanged: [] });
    const next = store.appendPrompt('r-1', 'second');

    expect(next.status).toBe('running');
    expect(next.serverPid).toBe(process.pid);
  });

  it('markTerminal() does NOT re-fire notification when called on an already-terminal run', () => {
    // Sweeper races and explicit retries must not double-notify the
    // user. Notification fires on running → terminal transition only.
    store.create({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
    store.markTerminal('r-1', { status: 'success', summary: 'first', filesChanged: [] });
    const firstCallCount = mockNotifyTerminal.mock.calls.length;
    expect(firstCallCount).toBe(1);

    // Re-call markTerminal on an already-terminal run (e.g., sweeper
    // sees status:'success' but tries to mark again — should be a
    // no-op for notification purposes).
    store.markTerminal('r-1', { status: 'success', summary: 'duplicate', filesChanged: [] });

    expect(mockNotifyTerminal.mock.calls.length).toBe(firstCallCount);
  });

  it('markTerminal() sets status + completedAt + summary on the last prompt', () => {
    store.create({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
    const next = store.markTerminal('r-1', {
      status: 'success',
      summary: 'all done',
      filesChanged: ['src/a.ts', 'src/b.ts'],
    });
    expect(next.status).toBe('success');
    expect(next.completedAt).toBeDefined();
    expect(next.filesChanged).toEqual(['src/a.ts', 'src/b.ts']);
    expect(next.prompts[0].completedAt).toBeDefined();
    expect(next.prompts[0].summary).toBe('all done');
  });

  it('markTerminal() fires a terminal OS notification hook after state write', () => {
    store.create({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
    const next = store.markTerminal('r-1', {
      status: 'error',
      summary: 'failed',
      filesChanged: [],
    });

    expect(next.status).toBe('error');
    expect(store.read('r-1')?.status).toBe('error');
    expect(mockNotifyTerminal).toHaveBeenCalledWith({
      runId: 'r-1',
      agentId: 'a',
      status: 'error',
    });
  });

  it('markTerminal() unions filesChanged across turns', () => {
    store.create({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
    store.markTerminal('r-1', {
      status: 'success',
      summary: 'first',
      filesChanged: ['a.ts', 'b.ts'],
    });
    store.appendPrompt('r-1', 'second turn');
    const next = store.markTerminal('r-1', {
      status: 'success',
      summary: 'second',
      filesChanged: ['b.ts', 'c.ts'],
    });
    expect(next.filesChanged.slice().sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('markMerged() / markMergeConflict() / markDiscarded() transition status', () => {
    store.create({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
    store.markTerminal('r-1', { status: 'success', summary: 'ok', filesChanged: [] });

    const merged = store.markMerged('r-1', { target: 'main', commitSha: 'abc123' });
    expect(merged.status).toBe('merged');
    expect(merged.mergeStatus).toEqual({ target: 'main', commitSha: 'abc123' });

    store.create({ runId: 'r-2', agentId: 'a', worktreePath: '/y', initialPrompt: 'q' });
    const conflict = store.markMergeConflict('r-2', {
      target: 'main',
      conflicts: ['src/a.ts'],
    });
    expect(conflict.status).toBe('merge_conflict');
    expect(conflict.mergeStatus?.conflicts).toEqual(['src/a.ts']);

    const discarded = store.markDiscarded('r-2');
    expect(discarded?.status).toBe('discarded');
  });

  it('markDiscarded() returns undefined for unknown runs (idempotent)', () => {
    expect(store.markDiscarded('nope')).toBeUndefined();
  });

  it('appendEvent() / tailEvents() roundtrip', () => {
    store.create({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
    store.appendEvent('r-1', 'line one');
    store.appendEvent('r-1', 'line two\n'); // trailing newline tolerated
    store.appendEvent('r-1', 'line three');
    const tail = store.tailEvents('r-1', 2);
    expect(tail).toEqual(['line two', 'line three']);
  });

  it('appendEvent() requires the run directory created by create()', () => {
    expect(() => store.appendEvent('r-missing', 'line one')).toThrow(/ENOENT/);
    expect(existsSync(join(crewHome, 'runs', 'r-missing'))).toBe(false);
  });

  it('tailEvents() returns [] when log does not exist', () => {
    store.create({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
    expect(store.tailEvents('r-1')).toEqual([]);
  });

  it('readEventsSince() returns an empty cursor when log does not exist', () => {
    store.create({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
    expect(store.readEventsSince('r-1')).toEqual({ lines: [], nextLine: 0 });
  });

  it('event readers propagate non-ENOENT read errors', () => {
    store.create({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
    store.appendEvent('r-1', 'line one');
    chmodSync(store.eventsLogPath('r-1'), 0o000);

    expect(() => store.tailEvents('r-1')).toThrow(/EACCES|permission/i);
    expect(() => store.readEventsSince('r-1')).toThrow(/EACCES|permission/i);
    expect(() => store.readFilteredTailFromEnd('r-1', 10)).toThrow(/EACCES|permission/i);
  });

  describe('readFilteredTailFromEnd', () => {
    const chunkBytes = 64 * 1024;

    function createRun(runId = 'r-tail'): string {
      store.create({ runId, agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
      return runId;
    }

    function writeRawEvents(runId: string, content: string): void {
      writeFileSync(store.eventsLogPath(runId), content, 'utf-8');
    }

    function writeEventLines(runId: string, lines: readonly string[], trailingNewline = true): void {
      writeRawEvents(runId, `${lines.join('\n')}${trailingNewline ? '\n' : ''}`);
    }

    function expectFilteredTailParity(runId: string, n: number): void {
      const legacyAll = store.readEventsSince(runId, 0).lines;
      const filtered = filterEventsTailNoise(legacyAll);
      const result = store.readFilteredTailFromEnd(runId, n);
      expect(result.lines).toEqual(filtered.slice(-n));
      expect(result.totalLineCount).toBe(legacyAll.length);
      expect(result.totalFilteredCount).toBe(filtered.length);
      expect(result.filteredOutCount).toBe(legacyAll.length - filtered.length);
    }

    it('returns empty counts when events.log does not exist', () => {
      const runId = createRun();
      expect(store.readFilteredTailFromEnd(runId, 10)).toEqual({
        lines: [],
        totalLineCount: 0,
        totalFilteredCount: 0,
        filteredOutCount: 0,
      });
    });

    it('returns empty counts for a zero-byte events.log', () => {
      const runId = createRun();
      writeRawEvents(runId, '');
      expect(store.readFilteredTailFromEnd(runId, 10)).toEqual({
        lines: [],
        totalLineCount: 0,
        totalFilteredCount: 0,
        filteredOutCount: 0,
      });
    });

    it('returns all filtered lines when the file is smaller than one chunk', () => {
      const runId = createRun();
      writeEventLines(runId, [
        '[codex] command: started rg foo',
        '[codex] message: kept one',
        '[codex] event: item.completed/web_search',
        '[codex] command: npm test (exit 1)',
        '[mock] final summary',
      ]);

      const result = store.readFilteredTailFromEnd(runId, 10);
      expect(result.lines).toEqual([
        '[codex] message: kept one',
        '[codex] command: npm test (exit 1)',
        '[mock] final summary',
      ]);
      expect(result.totalLineCount).toBe(5);
      expect(result.totalFilteredCount).toBe(3);
      expect(result.filteredOutCount).toBe(2);
    });

    it('handles multi-chunk files whose final line has no trailing newline', () => {
      const runId = createRun();
      const lines = Array.from({ length: 900 }, (_, i) =>
        i % 6 === 0
          ? `[codex] command: started rg ${i} ${'x'.repeat(90)}`
          : `[mock] message ${i} ${'y'.repeat(90)}`,
      );
      lines.push(`[mock] final partial ${'z'.repeat(90)}`);
      writeEventLines(runId, lines, false);

      expect(statSync(store.eventsLogPath(runId)).size).toBeGreaterThan(chunkBytes);
      expectFilteredTailParity(runId, 10);
      expect(store.readFilteredTailFromEnd(runId, 1).lines).toEqual([lines[lines.length - 1]]);
    });

    it('reconstructs a line split across a chunk boundary', () => {
      const runId = createRun();
      const prefixLabel = '[mock] prefix ';
      const prefixLine = `${prefixLabel}${'p'.repeat(chunkBytes - 100 - prefixLabel.length)}`;
      const crossingLine = `{"event":"${'q'.repeat(190)}"}`;
      const afterLine = '[mock] after crossing';
      writeEventLines(runId, [prefixLine, crossingLine, afterLine]);

      expect(Buffer.byteLength(`${prefixLine}\n`, 'utf-8')).toBe(chunkBytes - 99);
      expectFilteredTailParity(runId, 2);
      expect(store.readFilteredTailFromEnd(runId, 2).lines).toEqual([crossingLine, afterLine]);
    });

    it('finds filtered signal lines before a long receipt-only suffix', () => {
      const runId = createRun();
      const signalLines = [
        '[codex] message: kept one',
        '[codex] message: kept two',
        '[codex] message: kept three',
      ];
      const receiptLines = Array.from({ length: 1_000 }, (_, i) =>
        `[codex] command: started rg noisy-${i} ${'r'.repeat(80)}`,
      );
      writeEventLines(runId, [...signalLines, ...receiptLines]);

      expect(statSync(store.eventsLogPath(runId)).size).toBeGreaterThan(chunkBytes);
      const result = store.readFilteredTailFromEnd(runId, 2);
      expect(result.lines).toEqual(signalLines.slice(-2));
      expect(result.totalLineCount).toBe(signalLines.length + receiptLines.length);
      expect(result.totalFilteredCount).toBe(signalLines.length);
      expect(result.filteredOutCount).toBe(receiptLines.length);
    });

    it('does not mangle UTF-8 when a multi-byte character crosses a chunk boundary', () => {
      const runId = createRun();
      const prefixLine = 'a'.repeat(chunkBytes - 3);
      const unicodeLine = '🚀 non-ascii summary text';
      writeEventLines(runId, [prefixLine, unicodeLine], false);

      expect(Buffer.byteLength(`${prefixLine}\n`, 'utf-8')).toBe(chunkBytes - 2);
      expectFilteredTailParity(runId, 1);
      expect(store.readFilteredTailFromEnd(runId, 1).lines).toEqual([unicodeLine]);
    });

    it('matches the legacy full-read filtered tail for varied caps and file sizes', () => {
      const runId = createRun();
      const lines = Array.from({ length: 1_250 }, (_, i) => {
        if (i % 11 === 0) return `[codex] event: item.started/web_search ${i}`;
        if (i % 7 === 0) return `[codex] command: rg ${i} (exit 0)`;
        return `[mock] message ${i} ${'m'.repeat(70)}`;
      });
      writeEventLines(runId, lines);

      expect(statSync(store.eventsLogPath(runId)).size).toBeGreaterThan(chunkBytes);
      for (const n of [1, 3, 10, 500]) {
        expectFilteredTailParity(runId, n);
      }
    });
  });

  // readSignalEventsSince — used by get_run_status's long-poll fast-
  // return to skip waking when only adapter receipts have arrived
  // since the cursor. Cursor advances over receipts (matches the raw
  // file offset) but the returned `lines` are signal-only.
  // See docs/plans/active/noise-symmetric-filter.md.
  describe('readSignalEventsSince', () => {
    it('drops codex receipt lines from the returned slice', () => {
      store.create({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
      store.appendEvent('r-1', '[codex] command: started rg foo');
      store.appendEvent('r-1', '[codex] command: rg foo (exit 0)');
      store.appendEvent('r-1', '[codex] event: item.started/web_search');
      store.appendEvent('r-1', '[codex] message: real synthesis here');
      const result = store.readSignalEventsSince('r-1', 0);
      expect(result.lines).toEqual(['[codex] message: real synthesis here']);
      // Cursor matches raw file offset — 4 lines in events.log.
      expect(result.nextLine).toBe(4);
    });

    it('keeps non-zero command exits (signals a failure)', () => {
      store.create({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
      store.appendEvent('r-1', '[codex] command: started npm test');
      store.appendEvent('r-1', '[codex] command: npm test (exit 1)');
      const result = store.readSignalEventsSince('r-1', 0);
      // exit 0 is a receipt; exit 1 stays.
      expect(result.lines).toEqual(['[codex] command: npm test (exit 1)']);
      expect(result.nextLine).toBe(2);
    });

    it('returns lines:[] but nextLine still advances when window is all receipts', () => {
      store.create({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
      store.appendEvent('r-1', '[codex] command: started rg foo');
      store.appendEvent('r-1', '[codex] command: rg foo (exit 0)');
      const result = store.readSignalEventsSince('r-1', 0);
      // Caller's "do I have signal?" check sees an empty lines array
      // and falls through to long-poll wait, but the cursor still
      // matches the on-disk file so the next poll's bookkeeping is
      // coherent.
      expect(result.lines).toEqual([]);
      expect(result.nextLine).toBe(2);
    });

    it('honors sinceLine cursor on the raw file offset', () => {
      store.create({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
      store.appendEvent('r-1', '[codex] command: started rg foo');
      store.appendEvent('r-1', '[codex] message: synthesis A');
      store.appendEvent('r-1', '[codex] command: rg foo (exit 0)');
      store.appendEvent('r-1', '[codex] message: synthesis B');
      // Skip the first two raw lines: the slice should contain the
      // exit-0 receipt (which is filtered) and synthesis B.
      const result = store.readSignalEventsSince('r-1', 2);
      expect(result.lines).toEqual(['[codex] message: synthesis B']);
      expect(result.nextLine).toBe(4);
    });

    it('returns {lines:[], nextLine:0} when log does not exist', () => {
      store.create({ runId: 'r-1', agentId: 'a', worktreePath: '/x', initialPrompt: 'p' });
      const result = store.readSignalEventsSince('r-1', 0);
      expect(result.lines).toEqual([]);
      expect(result.nextLine).toBe(0);
    });
  });
});
