import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CaptainSession } from '../../../src/captain/session.js';
import { ToolDispatcher } from '../../../src/captain/tool-dispatcher.js';
import { AskUserAbortError, dispatchAskUser } from '../../../src/captain/tools/ask-user.js';
import { SessionLoop, type SessionLoopTurn } from '../../../src/captain/session-loop.js';

describe('dispatchAskUser', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'crew-ask-user-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('appends a tool_call message immediately (no inline tool_result)', async () => {
    const session = CaptainSession.create({ projectRoot: root });
    const dispatcher = new ToolDispatcher();
    const pending = dispatchAskUser({
      session,
      dispatcher,
      question: 'pick one',
    });
    await new Promise((r) => setImmediate(r));
    const msgs = session.getMessages();
    expect(msgs.length).toBe(1);
    expect(msgs[0].role).toBe('tool_call');

    dispatcher.cancelAll('test cleanup');
    try { await pending; } catch { /* expected */ }
  });

  it('resolves with response text on the next user_message event', async () => {
    const session = CaptainSession.create({ projectRoot: root });
    const dispatcher = new ToolDispatcher();
    const pending = dispatchAskUser({
      session,
      dispatcher,
      question: 'what color?',
    });

    await new Promise((r) => setImmediate(r));
    session.appendUserMessage('blue', '2026-04-19T00:00:00.000Z');

    const result = await pending;
    expect(result.response).toBe('blue');
    // dispatchAskUser no longer writes a tool_result itself — the dispatcher
    // emits run:complete, and a SessionLoop-attached listener is the writer.
    // Without a SessionLoop around this test, no tool_result is present.
    const toolResults = session.getMessages().filter((m) => m.role === 'tool_result');
    expect(toolResults.length).toBe(0);
  });

  it('two concurrent ask_user calls resolve independently, per toolCallId', async () => {
    const session = CaptainSession.create({ projectRoot: root });
    const dispatcher = new ToolDispatcher();

    const first = dispatchAskUser({
      session, dispatcher, question: 'q1', toolCallId: 'c1',
    });
    const second = dispatchAskUser({
      session, dispatcher, question: 'q2', toolCallId: 'c2',
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

  it('reflects the correct toolCallId on the resolved result', async () => {
    const session = CaptainSession.create({ projectRoot: root });
    const dispatcher = new ToolDispatcher();
    const pending = dispatchAskUser({
      session, dispatcher, question: 'q', toolCallId: 'custom-id',
    });
    await new Promise((r) => setImmediate(r));
    session.appendUserMessage('ok');
    const result = await pending;
    expect(result.toolCallId).toBe('custom-id');
  });

  it('emits a run:start event on the dispatcher', async () => {
    const session = CaptainSession.create({ projectRoot: root });
    const dispatcher = new ToolDispatcher();
    const starts: string[] = [];
    dispatcher.onEvent('run:start', (info) => starts.push(info.toolName));

    const pending = dispatchAskUser({ session, dispatcher, question: 'q' });
    await new Promise((r) => setImmediate(r));
    session.appendUserMessage('ok');
    await pending;

    expect(starts).toEqual(['ask_user']);
  });

  it('external abort signal cancels the ask_user and fires run:cancelled', async () => {
    const session = CaptainSession.create({ projectRoot: root });
    const dispatcher = new ToolDispatcher();
    const cancellations: string[] = [];
    dispatcher.onEvent('run:cancelled', (info) => cancellations.push(info.toolCallId));

    const external = new AbortController();
    const pending = dispatchAskUser({
      session, dispatcher, question: 'q', toolCallId: 'c-ext', externalSignal: external.signal,
    });

    await new Promise((r) => setImmediate(r));
    external.abort('test-cancel');

    await expect(pending).rejects.toBeInstanceOf(AskUserAbortError);
    expect(cancellations).toContain('c-ext');
  });

  it('dispatcher.cancel on the toolCallId cancels the ask_user', async () => {
    const session = CaptainSession.create({ projectRoot: root });
    const dispatcher = new ToolDispatcher();
    const pending = dispatchAskUser({
      session, dispatcher, question: 'q', toolCallId: 'c-abort',
    });

    await new Promise((r) => setImmediate(r));
    dispatcher.cancel('c-abort', 'user-cancel');

    await expect(pending).rejects.toBeInstanceOf(AskUserAbortError);
  });

  describe('under SessionLoop: exactly one tool_result is written (B2 regression)', () => {
    it('successful ask_user produces a single tool_result', async () => {
      const session = CaptainSession.create({ projectRoot: root });
      const dispatcher = new ToolDispatcher();

      let askPromise: Promise<unknown> | undefined;
      let turnCount = 0;
      const captain: SessionLoopTurn = {
        execute: async () => {
          turnCount++;
          if (turnCount === 1) {
            // Captain turn emits an ask_user dispatched call via a direct
            // helper invocation (simulating what buildSessionLoopScheduler
            // does for ask_user decisions).
            askPromise = dispatchAskUser({
              session,
              dispatcher,
              question: 'go?',
              toolCallId: 'c-au',
            });
            return {}; // no toolCalls returned — we fired the dispatch inline
          }
          return { done: true, finalReport: 'ok' };
        },
      };

      const loop = new SessionLoop({
        session,
        dispatcher,
        captain,
        scheduler: { schedule: async () => ({ kind: 'synchronous', result: {}, status: 'success' }) },
      });

      session.appendUserMessage('begin');
      const runP = loop.run();

      await new Promise((r) => setImmediate(r));
      // Answer the ask_user.
      session.appendUserMessage('answer');
      await askPromise;
      await runP;

      // Exactly ONE tool_result for the ask_user toolCallId.
      const toolResultsForAskUser = session
        .getMessages()
        .filter((m) => m.role === 'tool_result' && m.toolCallId === 'c-au');
      expect(toolResultsForAskUser.length).toBe(1);
      expect((toolResultsForAskUser[0] as { status: string }).status).toBe('success');
    });
  });
});
