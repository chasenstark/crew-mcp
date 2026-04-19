import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CaptainSession } from '../../src/captain/session.js';

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

  it('events() yields prior events + newly emitted events in order', async () => {
    const s = CaptainSession.create({ projectRoot: root });
    s.appendUserMessage('one', '2026-04-19T00:00:00.000Z');
    s.appendToolResult({
      toolCallId: 'c-1',
      output: { r: 1 },
      status: 'success',
      timestamp: '2026-04-19T00:00:01.000Z',
    });

    const iter = s.events()[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.value?.kind).toBe('user_message');
    const second = await iter.next();
    expect(second.value?.kind).toBe('tool_completed');

    // future events stream live
    const pending = iter.next();
    s.appendUserMessage('two', '2026-04-19T00:00:02.000Z');
    const third = await pending;
    expect(third.value?.kind).toBe('user_message');
    if (third.value?.kind === 'user_message') {
      expect(third.value.text).toBe('two');
    }
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

  it('appendUserMessage emits a user_message event persisted to events.log', async () => {
    const s = CaptainSession.create({ projectRoot: root });
    s.appendUserMessage('hi', '2026-04-19T00:00:00.000Z');
    s.persist();

    // Reload and verify event is present on disk.
    const reloaded = CaptainSession.load({ projectRoot: root });
    expect(reloaded).not.toBeNull();
    const iter = reloaded!.events()[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.value?.kind).toBe('user_message');
  });

  it('appendToolResult with status=error emits a tool_failed event', async () => {
    const s = CaptainSession.create({ projectRoot: root });
    s.appendToolResult({
      toolCallId: 'c-1',
      output: 'boom',
      status: 'error',
      timestamp: '2026-04-19T00:00:00.000Z',
    });
    const iter = s.events()[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.value?.kind).toBe('tool_failed');
    if (first.value?.kind === 'tool_failed') {
      expect(first.value.error).toBe('boom');
    }
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
});
