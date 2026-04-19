import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CaptainSession } from '../../../src/captain/session.js';
import { ToolDispatcher } from '../../../src/captain/tool-dispatcher.js';
import { AskUserAbortError, dispatchAskUser } from '../../../src/captain/tools/ask-user.js';

describe('dispatchAskUser', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'crew-ask-user-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('appends a tool_call message immediately', async () => {
    const session = CaptainSession.create({ projectRoot: root });
    const dispatcher = new ToolDispatcher();
    const pending = dispatchAskUser({
      session,
      dispatcher,
      question: 'pick one',
    });
    // one tick for async scheduling
    await new Promise((r) => setImmediate(r));
    const msgs = session.getMessages();
    expect(msgs.length).toBe(1);
    expect(msgs[0].role).toBe('tool_call');
    if (msgs[0].role === 'tool_call') {
      expect(msgs[0].toolName).toBe('ask_user');
      expect((msgs[0].input as { question: string }).question).toBe('pick one');
    }
    // clean up the pending task
    dispatcher.cancelAll('test cleanup');
    try {
      await pending;
    } catch {
      // expected
    }
  });

  it('resolves on the next user_message event', async () => {
    const session = CaptainSession.create({ projectRoot: root });
    const dispatcher = new ToolDispatcher();
    const pending = dispatchAskUser({
      session,
      dispatcher,
      question: 'what color?',
    });

    // small delay so the coordinator subscribes before we deliver the message
    await new Promise((r) => setImmediate(r));
    session.appendUserMessage('blue', '2026-04-19T00:00:00.000Z');

    const result = await pending;
    expect(result.response).toBe('blue');
    const msgs = session.getMessages();
    const lastResult = msgs.find((m) => m.role === 'tool_result');
    expect(lastResult?.role).toBe('tool_result');
    if (lastResult?.role === 'tool_result') {
      expect(lastResult.status).toBe('success');
      expect(lastResult.output).toBe('blue');
    }
  });

  it('two concurrent ask_user calls resolve independently, per toolCallId', async () => {
    const session = CaptainSession.create({ projectRoot: root });
    const dispatcher = new ToolDispatcher();

    const first = dispatchAskUser({
      session,
      dispatcher,
      question: 'q1',
      toolCallId: 'c1',
    });
    const second = dispatchAskUser({
      session,
      dispatcher,
      question: 'q2',
      toolCallId: 'c2',
    });

    await new Promise((r) => setImmediate(r));
    session.appendUserMessage('answer-1', '2026-04-19T00:00:00.000Z');
    await new Promise((r) => setImmediate(r));
    session.appendUserMessage('answer-2', '2026-04-19T00:00:01.000Z');

    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.toolCallId).toBe('c1');
    expect(r1.response).toBe('answer-1');
    expect(r2.toolCallId).toBe('c2');
    expect(r2.response).toBe('answer-2');
  });

  it('reflects the correct toolCallId through to the tool_result', async () => {
    const session = CaptainSession.create({ projectRoot: root });
    const dispatcher = new ToolDispatcher();
    const pending = dispatchAskUser({
      session,
      dispatcher,
      question: 'q',
      toolCallId: 'custom-id',
    });
    await new Promise((r) => setImmediate(r));
    session.appendUserMessage('ok');
    await pending;
    const msgs = session.getMessages();
    const call = msgs.find((m) => m.role === 'tool_call');
    const result = msgs.find((m) => m.role === 'tool_result');
    expect(call?.role === 'tool_call' && call.toolCallId).toBe('custom-id');
    expect(result?.role === 'tool_result' && result.toolCallId).toBe('custom-id');
  });

  it('emits a run:start event on the dispatcher', async () => {
    const session = CaptainSession.create({ projectRoot: root });
    const dispatcher = new ToolDispatcher();
    const starts: string[] = [];
    dispatcher.onEvent('run:start', (info) => starts.push(info.toolName));

    const pending = dispatchAskUser({
      session,
      dispatcher,
      question: 'q',
    });
    await new Promise((r) => setImmediate(r));
    session.appendUserMessage('ok');
    await pending;

    expect(starts).toEqual(['ask_user']);
  });

  it('external abort signal cancels the ask_user and writes cancelled tool_result', async () => {
    const session = CaptainSession.create({ projectRoot: root });
    const dispatcher = new ToolDispatcher();
    const external = new AbortController();

    const pending = dispatchAskUser({
      session,
      dispatcher,
      question: 'q',
      externalSignal: external.signal,
    });

    await new Promise((r) => setImmediate(r));
    external.abort('test-cancel');

    await expect(pending).rejects.toBeInstanceOf(AskUserAbortError);

    const msgs = session.getMessages();
    const result = msgs.find((m) => m.role === 'tool_result');
    expect(result?.role === 'tool_result' && result.status).toBe('cancelled');
  });

  it('dispatcher.cancel on the toolCallId cancels the ask_user', async () => {
    const session = CaptainSession.create({ projectRoot: root });
    const dispatcher = new ToolDispatcher();
    const pending = dispatchAskUser({
      session,
      dispatcher,
      question: 'q',
      toolCallId: 'c-abort',
    });

    await new Promise((r) => setImmediate(r));
    dispatcher.cancel('c-abort', 'user-cancel');

    await expect(pending).rejects.toBeInstanceOf(AskUserAbortError);
  });
});
