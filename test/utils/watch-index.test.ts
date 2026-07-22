import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  appendWatchIndex,
  watchIndexPath,
  type WatchIndexRecord,
} from '../../src/utils/watch-index.js';

describe('watch index', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it('prunes expired terminal runs and bounds the index by distinct run count', async () => {
    const crewHome = mkdtempSync(join(tmpdir(), 'crew-watch-index-'));
    cleanup.push(crewHome);
    const now = Date.parse('2026-07-22T12:00:00.000Z');
    const old = '2026-06-01T12:00:00.000Z';

    await appendWatchIndex({ crewHome, record: start('expired', old), nowMs: now, maxRuns: 2 });
    await appendWatchIndex({
      crewHome,
      record: terminal('expired', new Date(now).toISOString(), 'success', 0, old),
      nowMs: now,
      maxRuns: 2,
    });
    for (const runId of ['recent-a', 'recent-b', 'recent-c']) {
      await appendWatchIndex({
        crewHome,
        record: start(runId, new Date(now).toISOString()),
        nowMs: now,
        maxRuns: 2,
      });
    }

    const records = readRecords(crewHome);
    expect(new Set(records.map((record) => record.run_id))).toEqual(
      new Set(['recent-b', 'recent-c']),
    );
  });

  it('serializes a concurrent append behind compaction without losing either record', async () => {
    const crewHome = mkdtempSync(join(tmpdir(), 'crew-watch-index-concurrent-'));
    cleanup.push(crewHome);
    const now = Date.parse('2026-07-22T12:00:00.000Z');
    const old = '2026-06-01T12:00:00.000Z';
    const path = watchIndexPath(crewHome);
    mkdirSync(join(crewHome, 'runs', '.meta'), { recursive: true });
    writeFileSync(path, [
      JSON.stringify(start('expired', old)),
      JSON.stringify(terminal('expired', new Date(now).toISOString(), 'success', 0, old)),
      '',
    ].join('\n'), 'utf-8');

    let concurrentAppend: Promise<void> | undefined;
    await appendWatchIndex({
      crewHome,
      record: start('compacting-writer', new Date(now).toISOString()),
      nowMs: now,
      beforeCompactWrite: () => {
        concurrentAppend = appendWatchIndex({
          crewHome,
          record: start('concurrent-writer', new Date(now).toISOString()),
          nowMs: now,
        });
      },
    });
    await concurrentAppend;

    const records = readRecords(crewHome);
    expect(records.map((record) => record.run_id)).toEqual([
      'compacting-writer',
      'concurrent-writer',
    ]);
  });

  it('falls back to one unlocked append when the index lock times out', async () => {
    const crewHome = mkdtempSync(join(tmpdir(), 'crew-watch-index-lock-fail-'));
    cleanup.push(crewHome);
    const path = watchIndexPath(crewHome);
    mkdirSync(join(crewHome, 'runs', '.meta'), { recursive: true });
    mkdirSync(`${path}.lock`);

    await expect(appendWatchIndex({
      crewHome,
      record: start('lock-timeout', new Date().toISOString()),
    })).resolves.toBeUndefined();
    expect(readRecords(crewHome).map((record) => record.run_id)).toEqual(['lock-timeout']);
  });

  it('fails open when the index path cannot be created', async () => {
    const crewHome = mkdtempSync(join(tmpdir(), 'crew-watch-index-fail-'));
    cleanup.push(crewHome);
    const impossible = join(crewHome, 'missing', 'file-as-home');
    mkdirSync(join(crewHome, 'missing'));
    writeFileSync(impossible, 'not a directory', 'utf-8');
    await expect(appendWatchIndex({
      crewHome: impossible,
      record: start('run-1', new Date().toISOString()),
    })).resolves.toBeUndefined();
  });
});

function start(runId: string, ts: string): WatchIndexRecord {
  return {
    event: 'start',
    ts,
    run_id: runId,
    watcher_pid: 123,
    watcher_instance: '123',
  };
}

function terminal(
  runId: string,
  ts: string,
  status: string,
  exitOutcome: 0 | 3,
  terminalAt?: string,
): WatchIndexRecord {
  return {
    event: 'terminal_observed',
    ts,
    run_id: runId,
    watcher_pid: 123,
    watcher_instance: '123',
    status,
    exit_outcome: exitOutcome,
    ...(terminalAt !== undefined ? { terminal_at: terminalAt } : {}),
  };
}

function readRecords(crewHome: string): WatchIndexRecord[] {
  return readFileSync(watchIndexPath(crewHome), 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as WatchIndexRecord);
}
