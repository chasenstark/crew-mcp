import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionStore, type SessionSnapshot } from '../../src/captain/session-store.js';
import type { SessionEvent } from '../../src/captain/event-types.js';

function ensureCaptainDir(root: string): string {
  const dir = join(root, '.crew', 'captain');
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('SessionStore', () => {
  let root: string;
  let store: SessionStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'crew-session-store-'));
    store = new SessionStore(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const baseSnapshot = (overrides: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
    schemaVersion: 1,
    messages: [],
    startedAt: '2026-04-19T00:00:00.000Z',
    ...overrides,
  });

  it('roundtrips a snapshot via write + load', () => {
    const snap = baseSnapshot({
      messages: [
        { role: 'user', text: 'hi', timestamp: '2026-04-19T00:00:00.000Z' },
      ],
      providerSessionRef: 'sess-123',
      cliVersionTag: 'claude-code@1.2.0',
      toolSchemaHash: 'abc',
    });
    store.writeSession(snap);
    const loaded = store.loadSession();
    expect(loaded).toEqual(snap);
  });

  it('returns null when no session.json exists', () => {
    expect(store.loadSession()).toBeNull();
  });

  it('preserves append + read ordering across 100 events', () => {
    const events: SessionEvent[] = [];
    for (let i = 0; i < 100; i++) {
      const event: SessionEvent = {
        kind: 'user_message',
        text: `msg-${i}`,
        ts: new Date(1_700_000_000_000 + i).toISOString(),
      };
      store.appendEvent(event);
      events.push(event);
    }
    const read = store.readAllEvents();
    expect(read.length).toBe(100);
    expect(read.map((e) => (e.kind === 'user_message' ? e.text : null))).toEqual(
      events.map((e) => (e.kind === 'user_message' ? e.text : null)),
    );
  });

  it('loads 2000 events in under 500 ms', () => {
    // Pre-populate the events.log directly to isolate the read path; fsync
    // per-append would dominate if we went through appendEvent 2000 times.
    const dir = ensureCaptainDir(root);
    const eventsPath = join(dir, 'events.log');
    const lines: string[] = [];
    for (let i = 0; i < 2000; i++) {
      lines.push(JSON.stringify({
        kind: 'tool_completed',
        toolCallId: `call-${i}`,
        result: { i },
        ts: new Date(1_700_000_000_000 + i).toISOString(),
      }));
    }
    writeFileSync(eventsPath, lines.join('\n') + '\n', 'utf-8');

    const start = Date.now();
    const loaded = store.readAllEvents();
    const elapsed = Date.now() - start;
    expect(loaded.length).toBe(2000);
    expect(elapsed).toBeLessThan(500);
  });

  it('returns null on partial-write (invalid JSON) rather than throwing', () => {
    const dir = ensureCaptainDir(root);
    writeFileSync(join(dir, 'session.json'), '{"schemaVersion":1,"messag', 'utf-8');
    expect(store.loadSession()).toBeNull();
  });

  it('returns null on empty session.json', () => {
    const dir = ensureCaptainDir(root);
    writeFileSync(join(dir, 'session.json'), '', 'utf-8');
    expect(store.loadSession()).toBeNull();
  });

  it('refuses unrecognized schemaVersion', () => {
    const dir = ensureCaptainDir(root);
    writeFileSync(
      join(dir, 'session.json'),
      JSON.stringify({
        schemaVersion: 42,
        messages: [],
        startedAt: '2026-04-19T00:00:00.000Z',
      }),
      'utf-8',
    );
    expect(store.loadSession()).toBeNull();
  });

  it('skips malformed NDJSON lines without aborting the whole read', () => {
    const eventsPath = join(root, '.crew', 'captain', 'events.log');
    // Write one good + one partial + one good. Partial simulates a crash mid-append.
    store.appendEvent({
      kind: 'user_message',
      text: 'first',
      ts: '2026-04-19T00:00:00.000Z',
    });
    appendFileSync(eventsPath, '{"kind":"user_message","text":"partial');
    appendFileSync(eventsPath, '\n');
    store.appendEvent({
      kind: 'user_message',
      text: 'third',
      ts: '2026-04-19T00:00:01.000Z',
    });
    const events = store.readAllEvents();
    expect(events.length).toBe(2);
    expect(events[0].kind === 'user_message' && events[0].text).toBe('first');
    expect(events[1].kind === 'user_message' && events[1].text).toBe('third');
  });

  it('warns but does not corrupt when a second writer acquires no lock', () => {
    // Simulate another live process already holding the lock: pre-write a
    // pid-file containing our own pid (which is guaranteed to be "alive").
    const dir = ensureCaptainDir(root);
    writeFileSync(join(dir, '.lock'), String(process.pid), 'utf-8');

    // A fresh store (second writer) should proceed under last-write-wins.
    const second = new SessionStore(root);
    second.writeSession(baseSnapshot({
      messages: [{ role: 'user', text: 'second', timestamp: '2026-04-19T00:00:00.000Z' }],
    }));

    const loaded = second.loadSession();
    expect(loaded?.messages.length).toBe(1);
    expect(loaded?.messages[0].role === 'user' && loaded?.messages[0].text).toBe('second');
  });

  it('is last-write-wins on session.json under contention (explicit)', () => {
    const a = new SessionStore(root);
    const b = new SessionStore(root);
    a.writeSession(baseSnapshot({
      messages: [{ role: 'user', text: 'A', timestamp: '2026-04-19T00:00:00.000Z' }],
    }));
    b.writeSession(baseSnapshot({
      messages: [{ role: 'user', text: 'B', timestamp: '2026-04-19T00:00:01.000Z' }],
    }));
    const loaded = store.loadSession();
    expect(loaded?.messages[0].role === 'user' && loaded?.messages[0].text).toBe('B');
  });

  it('persists session + events under .crew/captain/', () => {
    store.writeSession(baseSnapshot());
    store.appendEvent({
      kind: 'user_message',
      text: 'hi',
      ts: '2026-04-19T00:00:00.000Z',
    });
    expect(existsSync(join(root, '.crew', 'captain', 'session.json'))).toBe(true);
    expect(existsSync(join(root, '.crew', 'captain', 'events.log'))).toBe(true);
  });

  it('persists events across SessionStore instances in the same process', () => {
    store.appendEvent({
      kind: 'user_message',
      text: 'alpha',
      ts: '2026-04-19T00:00:00.000Z',
    });
    const fresh = new SessionStore(root);
    const events = fresh.readAllEvents();
    expect(events.length).toBe(1);
    expect(events[0].kind === 'user_message' && events[0].text).toBe('alpha');
  });

  it('truncates large tool_completed payloads', () => {
    const huge = 'X'.repeat(10_000);
    store.appendEvent({
      kind: 'tool_completed',
      toolCallId: 'c1',
      result: { blob: huge },
      ts: '2026-04-19T00:00:00.000Z',
    });
    const events = store.readAllEvents();
    expect(events.length).toBe(1);
    const evt = events[0];
    expect(evt.kind).toBe('tool_completed');
    if (evt.kind === 'tool_completed') {
      const result = evt.result as { truncated?: boolean; originalBytes?: number };
      expect(result.truncated).toBe(true);
      expect(result.originalBytes).toBeGreaterThan(9_000);
    }
  });

  it('clear() removes session + events', () => {
    store.writeSession(baseSnapshot());
    store.appendEvent({
      kind: 'user_message',
      text: 'hi',
      ts: '2026-04-19T00:00:00.000Z',
    });
    store.clear();
    expect(existsSync(join(root, '.crew', 'captain', 'session.json'))).toBe(false);
    expect(existsSync(join(root, '.crew', 'captain', 'events.log'))).toBe(false);
  });

  it('reclaims a stale lock file whose holder pid is no longer alive (S6)', () => {
    // A never-used pid in the unsigned-int range that's certainly not alive.
    const DEAD_PID = 2_147_483_646;
    const dir = ensureCaptainDir(root);
    const lockPath = join(dir, '.lock');
    writeFileSync(lockPath, String(DEAD_PID), 'utf-8');

    // Acquire should succeed silently via reclaim; the lock file now holds
    // our own pid.
    store.writeSession(baseSnapshot());

    const holder = readFileSync(lockPath, 'utf-8').trim();
    expect(holder).toBe(String(process.pid));
  });

  it('does not reclaim a lock held by a live process', () => {
    // Our own pid is guaranteed alive. The store should NOT reclaim.
    const dir = ensureCaptainDir(root);
    const lockPath = join(dir, '.lock');
    writeFileSync(lockPath, String(process.pid), 'utf-8');
    // Build a second store in the same dir and verify the lock isn't taken.
    const second = new SessionStore(root);
    second.writeSession(baseSnapshot());
    // The lock file's contents are still our pid (we're alive, not reclaimed).
    const holder = readFileSync(lockPath, 'utf-8').trim();
    expect(holder).toBe(String(process.pid));
  });

  it('appends through SessionStore after a concurrent lock simulation', () => {
    // Prime a lock file as if another process owned it.
    const dir = ensureCaptainDir(root);
    writeFileSync(join(dir, '.lock'), '99999', 'utf-8');
    // Appends should still land despite not owning the lock.
    store.appendEvent({
      kind: 'user_message',
      text: 'A',
      ts: '2026-04-19T00:00:00.000Z',
    });
    store.appendEvent({
      kind: 'user_message',
      text: 'B',
      ts: '2026-04-19T00:00:01.000Z',
    });
    // events.log still readable and complete.
    const raw = readFileSync(join(root, '.crew', 'captain', 'events.log'), 'utf-8');
    expect(raw.split('\n').filter(Boolean).length).toBe(2);
  });
});
