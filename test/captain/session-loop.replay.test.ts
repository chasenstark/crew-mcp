// Scenario 7 coverage: providerSessionRef invalidation & one-turn replay.
//
// Tests the N9 retry semantics: exactly one automatic replay per event. A
// second consecutive resume rejection must propagate as a hard failure
// rather than silently retrying forever.

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

function makeScheduler(): ToolCallScheduler {
  return {
    schedule: async () => ({ kind: 'synchronous', result: {}, status: 'success' }),
  };
}

describe('SessionLoop replay on providerSessionRef rejection (M1.5-12)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'crew-sl-replay-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('first resume rejection triggers exactly one replay; captain finishes on retry', async () => {
    const session = CaptainSession.create({
      projectRoot: root,
      cliVersionTag: 'claude-code@1.0.0',
    });
    session.providerSessionRef = 'stale-ref';
    session.appendUserMessage('hi', '2026-04-19T00:00:00.000Z');
    const dispatcher = new ToolDispatcher();

    let calls = 0;
    const captain: SessionLoopTurn = {
      execute: async (args) => {
        calls++;
        if (calls === 1) {
          // Reject the stale providerSessionRef.
          expect(args.providerSessionRef).toBe('stale-ref');
          return { providerSessionRejected: true };
        }
        // Replay turn: ref was dropped, and isReplay is set.
        expect(args.providerSessionRef).toBeUndefined();
        expect(args.isReplay).toBe(true);
        return { assistantText: 'ok', done: true, finalReport: 'done' };
      },
    };

    const { finalReport } = await new SessionLoop({
      session,
      dispatcher,
      captain,
      scheduler: makeScheduler(),
    }).run();

    expect(calls).toBe(2);
    expect(finalReport).toBe('done');
    // The session's providerSessionRef should have been dropped.
    expect(session.providerSessionRef).toBeUndefined();
  });

  it('two consecutive resume rejections propagate as hard failure', async () => {
    const session = CaptainSession.create({
      projectRoot: root,
      cliVersionTag: 'claude-code@1.0.0',
    });
    session.providerSessionRef = 'stale-ref';
    session.appendUserMessage('hi', '2026-04-19T00:00:00.000Z');
    const dispatcher = new ToolDispatcher();

    let calls = 0;
    const captain: SessionLoopTurn = {
      execute: async () => {
        calls++;
        return { providerSessionRejected: true };
      },
    };

    const loop = new SessionLoop({
      session,
      dispatcher,
      captain,
      scheduler: makeScheduler(),
    });
    await expect(loop.run()).rejects.toThrow(/rejected twice/);
    expect(calls).toBe(2);
  });

  it('cliVersion tag is re-probed exactly once on resume rejection', async () => {
    const session = CaptainSession.create({
      projectRoot: root,
      cliVersionTag: 'claude-code@1.0.0',
    });
    session.providerSessionRef = 'stale-ref';
    session.appendUserMessage('hi', '2026-04-19T00:00:00.000Z');
    const dispatcher = new ToolDispatcher();

    let captureCount = 0;
    let refreshProbes = 0;

    const captain: SessionLoopTurn = {
      execute: async (args) => {
        captureCount++;
        if (captureCount === 1) {
          return { providerSessionRejected: true };
        }
        expect(args.isReplay).toBe(true);
        return { assistantText: 'done', done: true, finalReport: 'ok' };
      },
      refreshCliVersionTag: async () => {
        refreshProbes++;
        return 'claude-code@2.0.0';
      },
    };

    await new SessionLoop({
      session,
      dispatcher,
      captain,
      scheduler: makeScheduler(),
    }).run();

    expect(refreshProbes).toBe(1);
    expect(captureCount).toBe(2);
  });

  it('cliVersion refresh failure does not block the replay', async () => {
    const session = CaptainSession.create({
      projectRoot: root,
      cliVersionTag: 'claude-code@1.0.0',
    });
    session.providerSessionRef = 'stale-ref';
    session.appendUserMessage('hi', '2026-04-19T00:00:00.000Z');
    const dispatcher = new ToolDispatcher();

    let calls = 0;
    const captain: SessionLoopTurn = {
      execute: async () => {
        calls++;
        if (calls === 1) return { providerSessionRejected: true };
        return { done: true, finalReport: 'ok' };
      },
      refreshCliVersionTag: async () => {
        throw new Error('detection failed');
      },
    };

    const { finalReport } = await new SessionLoop({
      session,
      dispatcher,
      captain,
      scheduler: makeScheduler(),
    }).run();

    expect(finalReport).toBe('ok');
    expect(calls).toBe(2);
  });

  it('full message log is replayed after rejection (replay context)', async () => {
    const session = CaptainSession.create({
      projectRoot: root,
      cliVersionTag: 'claude-code@1.0.0',
    });
    session.providerSessionRef = 'stale-ref';
    session.appendUserMessage('first', '2026-04-19T00:00:00.000Z');
    session.appendAssistantMessage('ack', '2026-04-19T00:00:01.000Z');
    session.appendUserMessage('second', '2026-04-19T00:00:02.000Z');
    const dispatcher = new ToolDispatcher();

    const messagesSeen: number[] = [];
    const captain: SessionLoopTurn = {
      execute: async (args) => {
        messagesSeen.push(args.messages.length);
        if (messagesSeen.length === 1) {
          return { providerSessionRejected: true };
        }
        return { done: true, finalReport: 'ok' };
      },
    };

    await new SessionLoop({
      session,
      dispatcher,
      captain,
      scheduler: makeScheduler(),
    }).run();

    // Both turns see the full log (no trimming); session continuity preserved.
    expect(messagesSeen).toEqual([3, 3]);
  });
});
