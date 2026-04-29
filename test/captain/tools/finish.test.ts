import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CaptainSession } from '../../../src/captain/session.js';
import { ToolDispatcher } from '../../../src/captain/tool-dispatcher.js';
import {
  SessionLoop,
  type SessionLoopTurn,
  type SessionLoopToolCall,
  type ToolCallScheduleResult,
  type ToolCallScheduler,
} from '../../../src/captain/session-loop.js';
import { dispatchFinish } from '../../../src/captain/tools/finish.js';

function makeScheduler(
  handler: (call: SessionLoopToolCall) => Promise<ToolCallScheduleResult>,
): ToolCallScheduler {
  return { schedule: (call) => handler(call) };
}

describe('dispatchFinish', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'crew-finish-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('appends the summary and terminates the session loop', async () => {
    const session = CaptainSession.create({ projectRoot: root });
    const dispatcher = new ToolDispatcher();
    session.appendUserMessage('do a thing');

    let turnCount = 0;
    const turn: SessionLoopTurn = {
      execute: async () => {
        turnCount++;
        return {
          toolCalls: [
            {
              toolCallId: 'call-finish',
              toolName: 'finish',
              input: { summary: 'all done', outcome: 'success' },
            },
          ],
        };
      },
    };
    const scheduler = makeScheduler(async (call) => {
      if (call.toolName === 'finish') {
        dispatchFinish(session, loop, {
          summary: call.input.summary as string,
          outcome: 'success',
        });
        return { kind: 'synchronous', result: { status: 'finished' }, status: 'success' };
      }
      return { kind: 'synchronous', result: null, status: 'success' };
    });

    const loop = new SessionLoop({ session, dispatcher, captain: turn, scheduler });
    const { finalReport } = await loop.run();
    expect(finalReport).toBe('all done');
    expect(turnCount).toBe(1);
    const messages = session.getMessages();
    // expect the summary in an assistant message before the tool_result
    const assistantSummary = messages.find(
      (m) => m.role === 'assistant' && m.text === 'all done',
    );
    expect(assistantSummary).toBeDefined();
  });

  it('blocks finish while dispatched work is still in flight', async () => {
    const session = CaptainSession.create({ projectRoot: root });
    const dispatcher = new ToolDispatcher();
    session.appendUserMessage('do a slow thing');

    const turn: SessionLoopTurn = {
      execute: async () => ({
        toolCalls: [{ toolCallId: 'slow', toolName: 'run_agent', input: {} }],
      }),
    };
    const scheduler = makeScheduler(async (call) => ({
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
    const loop = new SessionLoop({ session, dispatcher, captain: turn, scheduler });
    const run = loop.run();

    await new Promise((r) => setImmediate(r));
    const result = dispatchFinish(session, loop, { summary: 'too soon' });

    expect(result.status).toBe('blocked');
    expect(result.reason).toContain('still in flight');
    expect(session.getMessages().some((m) => m.role === 'assistant' && m.text === 'too soon')).toBe(false);

    loop.cancel('test cleanup');
    await run;
  });

  it('ignores subsequent events after finish is called', async () => {
    const session = CaptainSession.create({ projectRoot: root });
    const dispatcher = new ToolDispatcher();
    session.appendUserMessage('hi');

    const turn: SessionLoopTurn = {
      execute: async () => ({
        toolCalls: [
          {
            toolCallId: 'call-finish',
            toolName: 'finish',
            input: { summary: 'done' },
          },
        ],
      }),
    };
    const scheduler = makeScheduler(async () => {
      dispatchFinish(session, loop, { summary: 'done' });
      return { kind: 'synchronous', result: { status: 'finished' }, status: 'success' };
    });
    const loop = new SessionLoop({ session, dispatcher, captain: turn, scheduler });
    const result = loop.run();

    // A tool_completed event after finish should NOT wake another turn.
    await new Promise((r) => setImmediate(r));

    await result;
    expect(session.getMessages().some((m) => m.role === 'assistant' && m.text === 'done')).toBe(true);
  });
});
