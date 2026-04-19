import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CaptainSession } from '../../src/captain/session.js';
import { ToolDispatcher } from '../../src/captain/tool-dispatcher.js';
import {
  SessionLoop,
  type SessionLoopToolCall,
  type SessionLoopTurnResult,
  type ToolCallScheduleResult,
  type ToolCallScheduler,
  type SessionLoopTurn,
} from '../../src/captain/session-loop.js';

function makeFakeScheduler(
  handler: (call: SessionLoopToolCall) => Promise<ToolCallScheduleResult>,
): ToolCallScheduler {
  return {
    schedule: (call) => handler(call),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('SessionLoop (M1.5-6a scaffold)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'crew-session-loop-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('runs one captain turn on the initial user message and exits cleanly on done', async () => {
    const session = CaptainSession.create({ projectRoot: root });
    const dispatcher = new ToolDispatcher();
    session.appendUserMessage('hello', '2026-04-19T00:00:00.000Z');

    const turn: SessionLoopTurn = {
      execute: async () => ({
        assistantText: 'hi back',
        done: true,
        finalReport: 'report',
      }),
    };

    const loop = new SessionLoop({
      session,
      dispatcher,
      captain: turn,
      scheduler: makeFakeScheduler(async () => ({ kind: 'synchronous', result: {}, status: 'success' })),
    });

    const { finalReport } = await loop.run();
    expect(finalReport).toBe('report');
    const msgs = session.getMessages();
    expect(msgs.length).toBe(2);
    expect(msgs[0].role).toBe('user');
    expect(msgs[1].role).toBe('assistant');
  });

  it('user_message during active subagent run triggers a fresh captain turn without waiting', async () => {
    const session = CaptainSession.create({ projectRoot: root });
    const dispatcher = new ToolDispatcher();
    session.appendUserMessage('start subagent', '2026-04-19T00:00:00.000Z');

    let turnCount = 0;
    let subagentResolve: (value: unknown) => void = () => undefined;
    const subagentRan = new Promise<unknown>((resolve) => {
      subagentResolve = resolve;
    });

    const captain: SessionLoopTurn = {
      execute: async ({ messages }) => {
        turnCount++;
        if (turnCount === 1) {
          return {
            toolCalls: [{ toolCallId: 'run-1', toolName: 'run_agent', input: { task: 't1' } }],
          };
        }
        // Turn 2: see user_message, emit nothing — wait for tool_result later
        if (turnCount === 2) {
          // sanity: this turn should see the second user message even though
          // the subagent hasn't completed yet
          const sawSecondUser = messages.some((m) => m.role === 'user' && m.content === 'interject');
          expect(sawSecondUser).toBe(true);
          return { assistantText: 'ack second user' };
        }
        // Turn 3: see tool_result, finish
        return { assistantText: 'final', done: true, finalReport: 'done' };
      },
    };

    const scheduler = makeFakeScheduler(async (call) => ({
      kind: 'dispatched',
      task: {
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        run: async (ctx) => {
          // Simulate a long-running subagent. Resolve explicitly via resolver.
          return new Promise((resolve, reject) => {
            ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
            subagentRan.then(resolve);
          });
        },
      },
    }));

    const loopPromise = new SessionLoop({
      session,
      dispatcher,
      captain,
      scheduler,
    }).run();

    // Let the first turn fire + start the subagent
    await delay(20);
    expect(turnCount).toBe(1);
    // Subagent should be in flight
    expect(dispatcher.inFlightCount()).toBe(1);

    // Inject a user message DURING subagent run
    session.appendUserMessage('interject', '2026-04-19T00:00:01.000Z');
    await delay(20);
    expect(turnCount).toBeGreaterThanOrEqual(2);

    // Complete the subagent
    subagentResolve({ ok: true });
    await delay(20);

    await loopPromise;
    expect(turnCount).toBe(3);
  });

  it('next captain turn sees user_message + tool_result in the message log after both arrive', async () => {
    const session = CaptainSession.create({ projectRoot: root });
    const dispatcher = new ToolDispatcher();
    session.appendUserMessage('start', '2026-04-19T00:00:00.000Z');

    const seenMessages: string[][] = [];
    let turnCount = 0;
    const captain: SessionLoopTurn = {
      execute: async ({ messages }) => {
        turnCount++;
        seenMessages.push(messages.map((m) => `${m.role}:${m.content}`));
        if (turnCount === 1) {
          return { toolCalls: [{ toolCallId: 't1', toolName: 'run_agent', input: {} }] };
        }
        if (turnCount >= 3) {
          return { assistantText: 'done', done: true, finalReport: 'ok' };
        }
        return {};
      },
    };

    let resolveSubagent: (v: unknown) => void = () => undefined;
    const subagentDone = new Promise<unknown>((r) => {
      resolveSubagent = r;
    });

    const scheduler = makeFakeScheduler(async (call) => ({
      kind: 'dispatched',
      task: {
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        run: async () => subagentDone,
      },
    }));

    const loopPromise = new SessionLoop({ session, dispatcher, captain, scheduler }).run();

    await delay(10);
    // Inject user message + complete subagent nearly simultaneously
    session.appendUserMessage('mid', '2026-04-19T00:00:01.000Z');
    resolveSubagent({ subagentOk: true });
    await delay(30);
    await loopPromise;

    expect(turnCount).toBeGreaterThanOrEqual(3);
    const lastTurnMessages = seenMessages[seenMessages.length - 1];
    expect(lastTurnMessages.some((m) => m.includes('user:mid'))).toBe(true);
    expect(lastTurnMessages.some((m) => m.startsWith('tool:'))).toBe(true);
  });

  it('cancellation of a dispatched subagent fires one captain turn to see the cancellation', async () => {
    const session = CaptainSession.create({ projectRoot: root });
    const dispatcher = new ToolDispatcher();
    session.appendUserMessage('kick it off', '2026-04-19T00:00:00.000Z');

    let turnCount = 0;
    let sawCancellation = false;
    const captain: SessionLoopTurn = {
      execute: async ({ messages }) => {
        turnCount++;
        if (turnCount === 1) {
          return { toolCalls: [{ toolCallId: 'sub-1', toolName: 'run_agent', input: {} }] };
        }
        if (messages.some((m) => {
          try {
            const parsed = JSON.parse(m.content ?? '');
            return parsed.status === 'cancelled';
          } catch {
            return false;
          }
        })) {
          sawCancellation = true;
        }
        return { assistantText: 'noted', done: true, finalReport: 'bye' };
      },
    };

    const scheduler = makeFakeScheduler(async (call) => ({
      kind: 'dispatched',
      task: {
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        run: async (ctx) => {
          return new Promise((_resolve, reject) => {
            ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
          });
        },
      },
    }));

    const loopPromise = new SessionLoop({ session, dispatcher, captain, scheduler }).run();

    await delay(20);
    dispatcher.cancel('sub-1', 'user-cancel');
    await loopPromise;
    expect(sawCancellation).toBe(true);
    expect(turnCount).toBeGreaterThanOrEqual(2);
  });

  it('two concurrent tool calls resolve independently and both appear in the next turn (scenario 6)', async () => {
    const session = CaptainSession.create({ projectRoot: root });
    const dispatcher = new ToolDispatcher();
    session.appendUserMessage('run two in parallel', '2026-04-19T00:00:00.000Z');

    let turnCount = 0;
    let lastTurnMessages: string[] = [];
    const captain: SessionLoopTurn = {
      execute: async ({ messages }) => {
        turnCount++;
        if (turnCount === 1) {
          return {
            toolCalls: [
              { toolCallId: 'fast', toolName: 'run_agent', input: { id: 'fast' } },
              { toolCallId: 'slow', toolName: 'run_agent', input: { id: 'slow' } },
            ],
          };
        }
        // Later turns: collect the tool messages
        lastTurnMessages = messages
          .filter((m) => m.role === 'tool')
          .map((m) => m.name ?? '');
        if (lastTurnMessages.length >= 2) {
          return { assistantText: 'both done', done: true, finalReport: 'ok' };
        }
        return {};
      },
    };

    const scheduler = makeFakeScheduler(async (call) => ({
      kind: 'dispatched',
      task: {
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        run: async () => {
          if (call.toolCallId === 'fast') {
            await delay(5);
            return { from: 'fast' };
          }
          await delay(30);
          return { from: 'slow' };
        },
      },
    }));

    await new SessionLoop({ session, dispatcher, captain, scheduler }).run();

    expect(lastTurnMessages.sort()).toEqual(['fast', 'slow']);
    // tool_results should be ordered by completion: fast first, then slow
    const toolResults = session.getMessages().filter((m) => m.role === 'tool_result');
    expect(toolResults.length).toBe(2);
    expect(toolResults[0].role === 'tool_result' && toolResults[0].toolCallId).toBe('fast');
    expect(toolResults[1].role === 'tool_result' && toolResults[1].toolCallId).toBe('slow');
  });

  it('run:stream events do not persist and are not written to the session', async () => {
    const session = CaptainSession.create({ projectRoot: root });
    const dispatcher = new ToolDispatcher();
    session.appendUserMessage('go', '2026-04-19T00:00:00.000Z');

    const captain: SessionLoopTurn = {
      execute: async () => ({
        assistantText: 'ok',
        done: true,
        finalReport: 'done',
      }),
    };

    const streamChunks: string[] = [];
    dispatcher.onEvent('run:stream', (info) => streamChunks.push(info.chunk));

    // Pre-start a dispatched task that streams. The loop won't wait for it,
    // but streaming should fire without polluting the session.
    dispatcher.start({
      toolCallId: 'stream-1',
      toolName: 'run_agent',
      run: async (ctx) => {
        ctx.onStream?.('chunk-a');
        ctx.onStream?.('chunk-b');
        return 'ok';
      },
    });

    await delay(10);

    await new SessionLoop({
      session,
      dispatcher,
      captain,
      scheduler: makeFakeScheduler(async () => ({
        kind: 'synchronous',
        result: {},
        status: 'success',
      })),
    }).run();

    expect(streamChunks).toEqual(['chunk-a', 'chunk-b']);
    // Session should not contain stream chunks — only the initial user, assistant, and the
    // tool_result from the manually-started subagent.
    const msgs = session.getMessages();
    const hasStreamContent = msgs.some(
      (m) => (m.role === 'assistant' && m.text.includes('chunk-a'))
        || (m.role === 'user' && m.text.includes('chunk-a')),
    );
    expect(hasStreamContent).toBe(false);
  });

  it('surfaces captain errors and stops the loop', async () => {
    const session = CaptainSession.create({ projectRoot: root });
    const dispatcher = new ToolDispatcher();
    session.appendUserMessage('hi', '2026-04-19T00:00:00.000Z');

    const captain: SessionLoopTurn = {
      execute: async () => {
        throw new Error('boom');
      },
    };

    const loop = new SessionLoop({
      session,
      dispatcher,
      captain,
      scheduler: makeFakeScheduler(async () => ({ kind: 'synchronous', result: {}, status: 'success' })),
    });

    await expect(loop.run()).rejects.toThrow('boom');
  });

  it('cancel() aborts in-flight dispatched calls and stops consuming events', async () => {
    const session = CaptainSession.create({ projectRoot: root });
    const dispatcher = new ToolDispatcher();
    session.appendUserMessage('long-run', '2026-04-19T00:00:00.000Z');

    const captain: SessionLoopTurn = {
      execute: async () => ({
        toolCalls: [{ toolCallId: 'l1', toolName: 'run_agent', input: {} }],
      }),
    };

    const scheduler = makeFakeScheduler(async (call) => ({
      kind: 'dispatched',
      task: {
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        run: async (ctx) => {
          return new Promise((_r, reject) => {
            ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
          });
        },
      },
    }));

    const loop = new SessionLoop({ session, dispatcher, captain, scheduler });
    const run = loop.run();
    await delay(20);
    expect(dispatcher.inFlightCount()).toBe(1);
    loop.cancel('test-cancel');
    await run;
    expect(dispatcher.inFlightCount()).toBe(0);
  });

  it('persists session + providerSessionRef after each turn', async () => {
    const session = CaptainSession.create({ projectRoot: root });
    const dispatcher = new ToolDispatcher();
    session.appendUserMessage('go', '2026-04-19T00:00:00.000Z');

    const captain: SessionLoopTurn = {
      execute: async () => ({
        assistantText: 'done',
        newProviderSessionRef: 'sess-42',
        done: true,
        finalReport: 'ok',
      }),
    };

    await new SessionLoop({
      session,
      dispatcher,
      captain,
      scheduler: makeFakeScheduler(async () => ({ kind: 'synchronous', result: {}, status: 'success' })),
    }).run();

    expect(session.providerSessionRef).toBe('sess-42');
    // Reload from disk and verify
    const reloaded = CaptainSession.load({ projectRoot: root });
    expect(reloaded?.providerSessionRef).toBe('sess-42');
  });
});

// M4-5: the "throws helpfully when session/dispatcher not injected" scaffold
// test was deleted — session + dispatcher are compile-time required on
// JudgmentRunner's constructor. The m3-tool-surface.test.ts integration
// suite is the authoritative post-M4 coverage for session-loop wiring.
