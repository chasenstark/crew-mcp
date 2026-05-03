import { describe, expect, it } from 'vitest';
import { ToolDispatcher, type DispatchTask } from '../../src/orchestrator/tool-dispatcher.js';

function makeTask(
  id: string,
  run: (signal: AbortSignal, onStream: (chunk: string) => void) => Promise<unknown>,
  toolName = 'run_agent',
  runId?: string,
): DispatchTask {
  return {
    toolCallId: id,
    toolName,
    runId,
    run: (ctx) => run(ctx.signal, ctx.onStream ?? (() => undefined)),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForEvent<K extends string>(
  dispatcher: ToolDispatcher,
  kind: K,
  predicate: (info: unknown) => boolean = () => true,
): Promise<unknown> {
  return new Promise((resolve) => {
    const handle = dispatcher.onEvent(kind as any, (info: unknown) => {
      if (predicate(info)) {
        handle.dispose();
        resolve(info);
      }
    });
  });
}

describe('ToolDispatcher', () => {
  it('emits run:start then run:complete for a resolved task', async () => {
    const d = new ToolDispatcher();
    const events: string[] = [];
    d.onEvent('run:start', () => events.push('start'));
    d.onEvent('run:complete', () => events.push('complete'));

    d.start(makeTask('c1', async () => ({ ok: true })));

    await waitForEvent(d, 'run:complete');
    expect(events).toEqual(['start', 'complete']);
    expect(d.inFlightCount()).toBe(0);
  });

  it('emits run:failed when the task rejects without cancellation', async () => {
    const d = new ToolDispatcher();
    d.start(makeTask('c1', async () => {
      throw new Error('boom');
    }));

    const info = (await waitForEvent(d, 'run:failed')) as { error: string };
    expect(info.error).toBe('boom');
    expect(d.inFlightCount()).toBe(0);
  });

  it('emits run:failed when a resolved task result has status=error', async () => {
    const d = new ToolDispatcher();
    d.start(makeTask('c1', async () => ({
      output: 'agent timed out',
      filesModified: [],
      status: 'error',
      metadata: {},
    })));

    const info = (await waitForEvent(d, 'run:failed')) as {
      error: string;
      result?: { status?: string; output?: string };
    };
    expect(info.error).toBe('agent timed out');
    expect(info.result).toMatchObject({ status: 'error', output: 'agent timed out' });
    expect(d.inFlightCount()).toBe(0);
  });

  it('cancel() aborts only the target task', async () => {
    const d = new ToolDispatcher();
    let aAborted = false;
    let bAborted = false;

    d.start(makeTask('a', async (signal) => {
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(new Error('pre-aborted'));
        const handler = () => {
          aAborted = true;
          reject(new Error('aborted'));
        };
        signal.addEventListener('abort', handler);
        setTimeout(() => {
          signal.removeEventListener('abort', handler);
          resolve();
        }, 200);
      });
      return 'a-done';
    }));

    d.start(makeTask('b', async (signal) => {
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(new Error('pre-aborted'));
        const handler = () => {
          bAborted = true;
          reject(new Error('aborted'));
        };
        signal.addEventListener('abort', handler);
        setTimeout(() => {
          signal.removeEventListener('abort', handler);
          resolve();
        }, 200);
      });
      return 'b-done';
    }));

    await delay(10);
    expect(d.inFlightCount()).toBe(2);
    const cancelled = d.cancel('a', 'user-requested');
    expect(cancelled).toBe(true);

    const aResult = (await waitForEvent(d, 'run:cancelled')) as { toolCallId: string; reason: string };
    expect(aResult.toolCallId).toBe('a');
    expect(aResult.reason).toBe('user-requested');
    expect(aAborted).toBe(true);

    // b finishes normally
    const bResult = (await waitForEvent(d, 'run:complete')) as { toolCallId: string };
    expect(bResult.toolCallId).toBe('b');
    expect(bAborted).toBe(false);
    expect(d.inFlightCount()).toBe(0);
  });

  it('cancel() returns false for an unknown id', () => {
    const d = new ToolDispatcher();
    expect(d.cancel('nope')).toBe(false);
  });

  it('cancelAll() terminates N concurrent tasks', async () => {
    const d = new ToolDispatcher();
    const cancellations: string[] = [];
    d.onEvent('run:cancelled', (info) => {
      cancellations.push(info.toolCallId);
    });

    for (let i = 0; i < 3; i++) {
      d.start(makeTask(`c-${i}`, async (signal) => {
        await new Promise<void>((resolve, reject) => {
          const handler = () => reject(new Error('aborted'));
          signal.addEventListener('abort', handler);
          setTimeout(() => {
            signal.removeEventListener('abort', handler);
            resolve();
          }, 200);
        });
      }));
    }
    await delay(10);
    expect(d.inFlightCount()).toBe(3);
    const count = d.cancelAll('session terminated');
    expect(count).toBe(3);

    // wait for all to settle
    await delay(50);
    expect(cancellations.sort()).toEqual(['c-0', 'c-1', 'c-2']);
    expect(d.inFlightCount()).toBe(0);
  });

  it('run:stream events fire via onStream callback but are never persisted here', async () => {
    const d = new ToolDispatcher();
    const streams: string[] = [];
    d.onEvent('run:stream', (info) => streams.push(info.chunk));

    d.start(makeTask('c1', async (_signal, onStream) => {
      onStream('chunk-1');
      onStream('chunk-2');
      return 'done';
    }));

    await waitForEvent(d, 'run:complete');
    expect(streams).toEqual(['chunk-1', 'chunk-2']);
  });

  it('map cleanup: terminal events remove the AbortController entry', async () => {
    const d = new ToolDispatcher();
    d.start(makeTask('c1', async () => 'ok'));
    await waitForEvent(d, 'run:complete');
    expect(d.inFlightCount()).toBe(0);
    expect(d.hasInFlight('c1')).toBe(false);
  });

  it('two concurrent start() calls complete independently', async () => {
    const d = new ToolDispatcher();
    const results: string[] = [];
    d.onEvent('run:complete', (info) => {
      results.push(String(info.result));
    });

    d.start(makeTask('fast', async () => 'fast-done'));
    d.start(makeTask('slow', async () => {
      await delay(20);
      return 'slow-done';
    }));

    await delay(50);
    expect(results.sort()).toEqual(['fast-done', 'slow-done']);
    expect(d.inFlightCount()).toBe(0);
  });

  it('onEvent returns a disposable that stops further deliveries', async () => {
    const d = new ToolDispatcher();
    const calls: string[] = [];
    const handle = d.onEvent('run:complete', (info) => calls.push(info.toolCallId));
    handle.dispose();

    d.start(makeTask('c1', async () => 'ok'));
    // Wait for whatever the event would have been.
    await delay(10);
    expect(calls).toEqual([]);
  });

  it('throws when start() is called twice for the same toolCallId', () => {
    const d = new ToolDispatcher();
    d.start(makeTask('c1', async () => {
      await delay(50);
      return 'ok';
    }));
    expect(() => d.start(makeTask('c1', async () => 'duplicate'))).toThrow();
    d.cancelAll('cleanup');
  });

  it('reports runId on start/complete when provided', async () => {
    const d = new ToolDispatcher();
    const startInfo = waitForEvent(d, 'run:start');
    const completeInfo = waitForEvent(d, 'run:complete');
    d.start(makeTask('c1', async () => 'ok', 'run_agent', 'run-42'));
    const start = (await startInfo) as { runId?: string };
    const complete = (await completeInfo) as { runId?: string };
    expect(start.runId).toBe('run-42');
    expect(complete.runId).toBe('run-42');
  });

  it('listInFlight() surfaces tool name + runId for active work', async () => {
    const d = new ToolDispatcher();
    d.start(makeTask('c1', async (signal) => {
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }, 'run_agent', 'run-1'));
    await delay(5);
    const list = d.listInFlight();
    expect(list.length).toBe(1);
    expect(list[0]).toEqual({ toolCallId: 'c1', toolName: 'run_agent', runId: 'run-1' });
    d.cancelAll('cleanup');
  });
});
