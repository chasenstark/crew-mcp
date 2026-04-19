import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CaptainSession } from '../../src/captain/session.js';
import { SessionStore } from '../../src/captain/session-store.js';

describe('CaptainSession', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'crew-captain-session-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('create() + persist() + load() roundtrips message log + refs', () => {
    const s = CaptainSession.create({
      projectRoot: root,
      cliVersionTag: 'claude-code@1.0.0',
      toolSchemaHash: 'abc',
    });
    s.providerSessionRef = 'sess-1';
    s.appendUserMessage('hello', '2026-04-19T00:00:00.000Z');
    s.appendAssistantMessage('world', '2026-04-19T00:00:01.000Z');
    s.appendToolCall({
      toolCallId: 'call-1',
      toolName: 'run_execute',
      input: { taskId: 't1' },
      timestamp: '2026-04-19T00:00:02.000Z',
    });
    s.appendToolResult({
      toolCallId: 'call-1',
      output: { ok: true },
      status: 'success',
      timestamp: '2026-04-19T00:00:03.000Z',
    });
    s.persist();

    const loaded = CaptainSession.load({ projectRoot: root });
    expect(loaded).not.toBeNull();
    const msgs = loaded!.getMessages();
    expect(msgs.length).toBe(4);
    expect(msgs[0].role).toBe('user');
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[2].role).toBe('tool_call');
    expect(msgs[3].role).toBe('tool_result');
    expect(loaded!.providerSessionRef).toBe('sess-1');
    expect(loaded!.cliVersionTag).toBe('claude-code@1.0.0');
    expect(loaded!.toolSchemaHash).toBe('abc');
  });

  it('load() returns null when no session.json exists', () => {
    expect(CaptainSession.load({ projectRoot: root })).toBeNull();
  });

  it('loadOrCreate() creates a fresh session when none exists', () => {
    const s = CaptainSession.loadOrCreate({ projectRoot: root });
    expect(s.getMessages().length).toBe(0);
    expect(s.providerSessionRef).toBeUndefined();
  });

  it('events() yields only future events (no disk replay)', async () => {
    const s = CaptainSession.create({ projectRoot: root });

    // Kick the iterator so its pending resolver is in place before we append.
    const iter = s.events()[Symbol.asyncIterator]();
    const firstP = iter.next();

    s.appendUserMessage('one', '2026-04-19T00:00:00.000Z');
    const first = await firstP;
    expect(first.value?.kind).toBe('user_message');

    const secondP = iter.next();
    s.appendToolResult({
      toolCallId: 'c-1',
      output: { r: 1 },
      status: 'success',
      timestamp: '2026-04-19T00:00:01.000Z',
    });
    const second = await secondP;
    expect(second.value?.kind).toBe('tool_completed');
  });

  it('events() does NOT replay events that were appended before subscribe()', async () => {
    const s = CaptainSession.create({ projectRoot: root });
    s.appendUserMessage('pre', '2026-04-19T00:00:00.000Z');

    // The pre-subscription event must not arrive on the iterator; events()
    // is strictly future-only. Race against a short timeout to prove nothing
    // is yielded.
    const iter = s.events()[Symbol.asyncIterator]();
    const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 30));
    const winner = await Promise.race([iter.next().then(() => 'next' as const), timeout]);
    expect(winner).toBe('timeout');
  });

  it('subscribe() delivers future events, not prior ones', () => {
    const s = CaptainSession.create({ projectRoot: root });
    s.appendUserMessage('pre', '2026-04-19T00:00:00.000Z');
    const received: string[] = [];
    const handle = s.subscribe((event) => {
      if (event.kind === 'user_message') received.push(event.text);
    });
    s.appendUserMessage('post', '2026-04-19T00:00:01.000Z');
    handle.dispose();
    expect(received).toEqual(['post']);
  });

  it('updateEnvironmentFingerprint drops providerSessionRef on cliVersionTag change', () => {
    const s = CaptainSession.create({
      projectRoot: root,
      cliVersionTag: 'claude-code@1.0.0',
      toolSchemaHash: 'abc',
    });
    s.providerSessionRef = 'sess-1';
    s.appendUserMessage('hi', '2026-04-19T00:00:00.000Z');

    s.updateEnvironmentFingerprint({ cliVersionTag: 'claude-code@2.0.0' });
    expect(s.providerSessionRef).toBeUndefined();
    expect(s.cliVersionTag).toBe('claude-code@2.0.0');
    // message log survives invalidation
    expect(s.getMessages().length).toBe(1);
  });

  it('updateEnvironmentFingerprint drops providerSessionRef on toolSchemaHash change', () => {
    const s = CaptainSession.create({
      projectRoot: root,
      cliVersionTag: 'claude-code@1.0.0',
      toolSchemaHash: 'abc',
    });
    s.providerSessionRef = 'sess-1';

    s.updateEnvironmentFingerprint({ toolSchemaHash: 'def' });
    expect(s.providerSessionRef).toBeUndefined();
    expect(s.toolSchemaHash).toBe('def');
  });

  it('updateEnvironmentFingerprint preserves ref when values are stable', () => {
    const s = CaptainSession.create({
      projectRoot: root,
      cliVersionTag: 'claude-code@1.0.0',
      toolSchemaHash: 'abc',
    });
    s.providerSessionRef = 'sess-1';
    s.updateEnvironmentFingerprint({
      cliVersionTag: 'claude-code@1.0.0',
      toolSchemaHash: 'abc',
    });
    expect(s.providerSessionRef).toBe('sess-1');
  });

  it('providerSessionRef getter returns undefined after invalidation', () => {
    const s = CaptainSession.create({
      projectRoot: root,
      cliVersionTag: 'claude-code@1.0.0',
    });
    s.providerSessionRef = 'sess-1';
    s.updateEnvironmentFingerprint({ cliVersionTag: 'claude-code@2.0.0' });
    expect(s.providerSessionRef).toBeUndefined();
  });

  it('toToolLoopMessages maps all message roles to adapter-compatible shape', () => {
    const s = CaptainSession.create({ projectRoot: root });
    s.appendUserMessage('question', '2026-04-19T00:00:00.000Z');
    s.appendAssistantMessage('answer', '2026-04-19T00:00:01.000Z');
    s.appendToolCall({
      toolCallId: 'c-1',
      toolName: 'run_execute',
      input: { taskId: 't1' },
    });
    s.appendToolResult({
      toolCallId: 'c-1',
      output: { ok: true },
      status: 'success',
    });
    const msgs = s.toToolLoopMessages();
    expect(msgs.length).toBe(4);
    expect(msgs[0]).toEqual({ role: 'user', content: 'question' });
    expect(msgs[1]).toEqual({ role: 'assistant', content: 'answer' });
    expect(msgs[2].role).toBe('assistant');
    expect(msgs[2].name).toBe('run_execute');
    expect(msgs[3].role).toBe('tool');
    expect(msgs[3].name).toBe('c-1');
  });

  it('appendUserMessage writes a user_message event to events.log', () => {
    const s = CaptainSession.create({ projectRoot: root });
    s.appendUserMessage('hi', '2026-04-19T00:00:00.000Z');

    // Read from the persisted log directly (not via events(), which is
    // future-only). This verifies durability.
    const store = new SessionStore(root);
    const events = store.readAllEvents();
    expect(events.length).toBe(1);
    expect(events[0].kind).toBe('user_message');
  });

  it('appendToolResult with status=error fires a tool_failed subscription event', () => {
    const s = CaptainSession.create({ projectRoot: root });
    const received: string[] = [];
    s.subscribe((event) => {
      received.push(event.kind);
    });
    s.appendToolResult({
      toolCallId: 'c-1',
      output: 'boom',
      status: 'error',
      timestamp: '2026-04-19T00:00:00.000Z',
    });
    expect(received).toEqual(['tool_failed']);
  });

  it('persist() is idempotent across calls', () => {
    const s = CaptainSession.create({
      projectRoot: root,
      cliVersionTag: 'c@1.0.0',
    });
    s.appendUserMessage('hi', '2026-04-19T00:00:00.000Z');
    s.persist();
    s.persist();
    const reloaded = CaptainSession.load({ projectRoot: root });
    expect(reloaded?.getMessages().length).toBe(1);
  });

  describe('refreshCliVersionTag (M1.5-8 self-heal)', () => {
    it('returns fresh value and invalidates providerSessionRef on drift', async () => {
      const s = CaptainSession.create({
        projectRoot: root,
        cliVersionTag: 'claude-code@1.0.0',
      });
      s.providerSessionRef = 'sess-1';
      let probes = 0;
      const fetch = async (): Promise<string> => {
        probes++;
        return 'claude-code@2.0.0';
      };

      const fresh = await s.refreshCliVersionTag(fetch);
      expect(fresh).toBe('claude-code@2.0.0');
      expect(s.cliVersionTag).toBe('claude-code@2.0.0');
      expect(s.providerSessionRef).toBeUndefined();
      expect(probes).toBe(1);
    });

    it('preserves providerSessionRef when version is unchanged', async () => {
      const s = CaptainSession.create({
        projectRoot: root,
        cliVersionTag: 'claude-code@1.0.0',
      });
      s.providerSessionRef = 'sess-1';
      const fresh = await s.refreshCliVersionTag(async () => 'claude-code@1.0.0');
      expect(fresh).toBe('claude-code@1.0.0');
      expect(s.providerSessionRef).toBe('sess-1');
    });

    it('is safe to call exactly once per resume rejection (one-turn self-heal)', async () => {
      const s = CaptainSession.create({
        projectRoot: root,
        cliVersionTag: 'claude-code@1.0.0',
      });
      s.providerSessionRef = 'sess-1';
      let probes = 0;
      const fetch = async (): Promise<string> => {
        probes++;
        return 'claude-code@2.0.0';
      };

      // First rejection: re-probe, drop ref, proceed to replay.
      await s.refreshCliVersionTag(fetch);
      expect(probes).toBe(1);
      expect(s.providerSessionRef).toBeUndefined();

      // Post-replay, a second rejection would re-probe again — the cache is
      // fresh, so providerSessionRef would STILL be undefined from the replay
      // turn's own write. This test just confirms the method is re-entrant.
      await s.refreshCliVersionTag(fetch);
      expect(probes).toBe(2);
    });

    it('returns the cached value if fetcher returns undefined', async () => {
      const s = CaptainSession.create({
        projectRoot: root,
        cliVersionTag: 'claude-code@1.0.0',
      });
      const fresh = await s.refreshCliVersionTag(async () => undefined);
      expect(fresh).toBe('claude-code@1.0.0');
    });

    it('returns the cached value when the fetcher throws', async () => {
      const s = CaptainSession.create({
        projectRoot: root,
        cliVersionTag: 'claude-code@1.0.0',
      });
      s.providerSessionRef = 'sess-1';
      const fresh = await s.refreshCliVersionTag(async () => {
        throw new Error('detection failed');
      });
      expect(fresh).toBe('claude-code@1.0.0');
      // ref should still be intact since we didn't actually learn of a change
      expect(s.providerSessionRef).toBe('sess-1');
    });
  });
});
