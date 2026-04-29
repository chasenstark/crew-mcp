import { EventEmitter } from 'eventemitter3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachRunnerEvents } from '../../../src/cli/runtime/attach-runner-events.js';
import type { PipelineEvents } from '../../../src/captain/events.js';
import type { CrewRunner } from '../../../src/captain/runner.js';
import { ToolDispatcher } from '../../../src/captain/tool-dispatcher.js';

function createRunner(): CrewRunner {
  const emitter = new EventEmitter<PipelineEvents>();
  return {
    run: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
    markInterrupted: vi.fn(),
    on: emitter.on.bind(emitter),
    removeAllListeners: emitter.removeAllListeners.bind(emitter),
  } as unknown as CrewRunner;
}

describe('attachRunnerEvents', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('prints dispatcher progress for non-interactive runs', async () => {
    const dispatcher = new ToolDispatcher();
    const subscription = attachRunnerEvents(
      createRunner(),
      {
        agentStartSymbol: '>',
        successSymbol: 'ok',
        errorSymbol: 'err',
        separator: '-',
      },
      () => undefined,
      dispatcher,
    );

    dispatcher.start({
      toolCallId: 'tc-1',
      toolName: 'run_agent',
      run: async (ctx) => {
        ctx.onStream?.('chunk one');
        return 'done';
      },
    });
    await new Promise((r) => setImmediate(r));
    subscription.dispose();

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('run_agent');
    expect(output).toContain('chunk one');
    expect(output).toContain('ok');
  });
});
