/**
 * Regression for review Finding 8: when the captain turn returns nothing
 * (no assistantText, no toolCalls, not done), the SessionLoop's M3 safety
 * net exits cleanly rather than hanging on an event that never arrives.
 * Only reachable on the M3 path — legacy always returned a toolCall.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CaptainSession } from '../../src/captain/session.js';
import { ToolDispatcher } from '../../src/captain/tool-dispatcher.js';
import {
  SessionLoop,
  type SessionLoopTurn,
  type ToolCallScheduler,
} from '../../src/captain/session-loop.js';

describe('SessionLoop quiet-turn safety net (review Finding 8)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'crew-quiet-turn-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('exits cleanly when the captain returns an empty turn with no dispatcher work in flight', async () => {
    const session = CaptainSession.create({ projectRoot: root });
    const dispatcher = new ToolDispatcher();
    session.appendUserMessage('hello');

    const turn: SessionLoopTurn = {
      execute: async () => ({
        // quiet: no assistant text, no tool calls, not done
      }),
    };
    const scheduler: ToolCallScheduler = {
      schedule: async () => ({
        kind: 'synchronous',
        result: null,
        status: 'success',
      }),
    };

    const loop = new SessionLoop({ session, dispatcher, captain: turn, scheduler });
    // Without the safety net this would hang (no events arrive). Test
    // timeout would trip. With the safety net, the loop observes the
    // quiet turn + empty dispatcher queue and sets done=true.
    const result = await loop.run();
    expect(result.finalReport).toBeUndefined();
  });

  it('does NOT apply the safety net when tasks are still in flight on the dispatcher', async () => {
    const session = CaptainSession.create({ projectRoot: root });
    const dispatcher = new ToolDispatcher();
    session.appendUserMessage('hello');

    let firstTurn = true;
    let dispatchResolve!: () => void;
    const dispatchPromise = new Promise<unknown>((r) => {
      dispatchResolve = () => r({ result: 'agent-done' });
    });

    const turn: SessionLoopTurn = {
      execute: async () => {
        if (firstTurn) {
          firstTurn = false;
          return {
            toolCalls: [
              { toolCallId: 'call-1', toolName: 'run_agent', input: { agent_id: 'x' } },
            ],
          };
        }
        return { done: true, finalReport: 'all set' };
      },
    };
    const scheduler: ToolCallScheduler = {
      schedule: async () => ({
        kind: 'dispatched',
        task: {
          toolCallId: 'call-1',
          toolName: 'run_agent',
          run: async () => {
            // Block until we release the dispatch. This keeps
            // dispatcher.inFlightCount() > 0 so the safety net should NOT fire.
            return await dispatchPromise;
          },
        },
      }),
    };

    const loop = new SessionLoop({ session, dispatcher, captain: turn, scheduler });
    const runPromise = loop.run();

    // Brief yield so the first turn runs and the dispatch starts.
    await new Promise((r) => setImmediate(r));
    expect(dispatcher.inFlightCount()).toBe(1);

    // Release the dispatch; the next turn should see the tool_result and finish.
    dispatchResolve();
    const result = await runPromise;
    expect(result.finalReport).toBe('all set');
  });
});
