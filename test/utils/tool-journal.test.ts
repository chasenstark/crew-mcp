import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  appendToolJournal,
  isWaitingWaitParams,
  redactAndDigestArgs,
  toolJournalPath,
  type ToolJournalRecord,
} from '../../src/utils/tool-journal.js';

describe('tool journal', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it('allowlists scalars and digests sensitive text without writing raw values', () => {
    const digest = redactAndDigestArgs({
      agent_id: 'codex',
      run_id: 'run-1',
      prompt: 'top secret prompt',
      peer_messages: [{ body: 'private peer body' }],
      commit_body: 'private commit body',
      run_token: 'never-write-this-token',
      unknown_future_field: 'also private',
      msg_ids: ['a', 'b'],
    });
    const serialized = JSON.stringify(digest);
    expect(digest).toMatchObject({
      agent_id: 'codex',
      run_id: 'run-1',
      msg_ids_count: 2,
      prompt: { present: true, length: 17 },
      peer_messages: { present: true },
    });
    expect(serialized).not.toContain('top secret prompt');
    expect(serialized).not.toContain('private peer body');
    expect(serialized).not.toContain('private commit body');
    expect(serialized).not.toContain('never-write-this-token');
    expect(serialized).not.toContain('also private');
  });

  it('distinguishes real waits from explicit snapshot and consent parameters', () => {
    expect(isWaitingWaitParams({ wait_for_change_ms: 1 })).toBe(true);
    expect(isWaitingWaitParams({ wait_for_terminal_only: true })).toBe(true);
    expect(isWaitingWaitParams({ wait_for_change_ms: 0 })).toBe(false);
    expect(isWaitingWaitParams({ wait_for_terminal_only: false })).toBe(false);
    expect(isWaitingWaitParams({ user_requested_wait: false })).toBe(false);
    expect(isWaitingWaitParams({ user_requested_wait: true })).toBe(false);
    expect(isWaitingWaitParams(undefined)).toBe(false);
  });

  it('lands intact concurrent O_APPEND records and rotates under the configured cap', async () => {
    const crewHome = mkdtempSync(join(tmpdir(), 'crew-tool-journal-'));
    cleanup.push(crewHome);
    const records = Array.from({ length: 20 }, (_, index) => makeRecord(`tool-${index}`));
    await Promise.all(records.map((record) => appendToolJournal({ crewHome, record })));
    const path = toolJournalPath(crewHome);
    const lines = readFileSync(path, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toHaveLength(20);
    expect(new Set(lines.map((line) => line.tool)).size).toBe(20);

    writeFileSync(path, 'x'.repeat(128), 'utf-8');
    await appendToolJournal({ crewHome, record: makeRecord('after-rotation'), maxBytes: 64 });
    expect(readFileSync(`${path}.1`, 'utf-8')).toHaveLength(128);
    expect(JSON.parse(readFileSync(path, 'utf-8')).tool).toBe('after-rotation');
  });

  it('fails open for serialization and filesystem errors', async () => {
    const crewHome = mkdtempSync(join(tmpdir(), 'crew-tool-journal-fail-'));
    cleanup.push(crewHome);
    const blockedHome = join(crewHome, 'blocked');
    writeFileSync(blockedHome, 'not a directory', 'utf-8');
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(appendToolJournal({
      crewHome: blockedHome,
      record: makeRecord('write-error'),
    })).resolves.toBeUndefined();
    await expect(appendToolJournal({
      crewHome,
      record: { ...makeRecord('serialize-error'), args_digest: circular },
    })).resolves.toBeUndefined();
  });
});

function makeRecord(tool: string): ToolJournalRecord {
  return {
    ts: new Date().toISOString(),
    tool,
    args_digest: {},
    isError: false,
    duration_ms: 1,
    clientKind: 'unknown',
    captainServeInstance: 'serve-test',
  };
}
